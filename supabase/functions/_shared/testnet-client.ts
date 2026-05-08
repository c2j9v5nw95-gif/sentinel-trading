// TestnetBybitClient — talks to Bybit V5 TESTNET via real REST.
//
// Source of truth:
//   Bybit testnet is authoritative for `getPosition` and `getWalletBalance`.
//   Local DB rows mirror it; reconciliation/recovery jobs realign drift.
//
// Idempotency:
//   Every order is submitted with a deterministic orderLinkId from the executor.
//   Bybit dedupes within ~10 minutes; we record retCode 110007 as 'submitted'.
//
// Protection (SL/TP/TSL) is applied via /v5/position/trading-stop, which sets
// position-level stops without separate orders (Bybit's preferred model).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  BybitClient, PositionSnapshot, SubmitOrderRequest, SubmitOrderResult, WalletSnapshot,
} from "./bybit-client.ts";
import type { ExecutionMode } from "./execution-mode.ts";
import { BybitRest, BybitError } from "./bybit-rest.ts";

const TESTNET_BASE = "https://api-testnet.bybit.com";

interface SymbolMeta { category: "linear"; }

export class TestnetBybitClient implements BybitClient {
  readonly mode: ExecutionMode = "testnet";
  private rest: BybitRest;

  constructor(private sb: SupabaseClient) {
    const apiKey = Deno.env.get("BYBIT_TESTNET_API_KEY") ?? "";
    const apiSecret = Deno.env.get("BYBIT_TESTNET_API_SECRET") ?? "";
    if (!apiKey || !apiSecret) {
      throw new Error("BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_API_SECRET not configured");
    }
    this.rest = new BybitRest({ apiKey, apiSecret, baseUrl: TESTNET_BASE });
  }

  private async meta(symbol: string): Promise<SymbolMeta> {
    const { data } = await this.sb.from("symbols").select("category").eq("symbol", symbol).maybeSingle();
    return { category: ((data?.category as "linear") ?? "linear") };
  }

  async getWalletBalance(): Promise<WalletSnapshot> {
    const r = await this.rest.request<{ list: Array<{ totalEquity: string; totalAvailableBalance: string }> }>({
      endpoint: "/v5/account/wallet-balance",
      method: "GET",
      query: { accountType: "UNIFIED" },
    });
    const row = r.result?.list?.[0];
    return {
      totalEquity: Number(row?.totalEquity ?? 0),
      availableBalance: Number(row?.totalAvailableBalance ?? 0),
    };
  }

  async getPosition(symbol: string): Promise<PositionSnapshot> {
    const meta = await this.meta(symbol);
    const r = await this.rest.request<{ list: Array<{ symbol: string; side: string; size: string; avgPrice: string; leverage: string }> }>({
      endpoint: "/v5/position/list",
      method: "GET",
      query: { category: meta.category, symbol },
    });
    const row = r.result?.list?.find((p) => Number(p.size) > 0);
    if (!row) return { symbol, side: "none", size: 0, entryPrice: null, leverage: null };
    return {
      symbol,
      side: row.side === "Buy" ? "long" : "short",
      size: Number(row.size),
      entryPrice: row.avgPrice ? Number(row.avgPrice) : null,
      leverage: row.leverage ? Number(row.leverage) : null,
    };
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const meta = await this.meta(req.symbol);

    // Audit row up front so we have a paper trail even if Bybit times out.
    const { data: orderRow } = await this.sb.from("orders").insert({
      symbol: req.symbol, side: req.side === "Buy" ? "long" : "short",
      order_type: req.orderType ?? "Market", qty: req.qty, price: req.price,
      purpose: req.purpose ?? "entry",
      signal_id: req.signalId ?? null, position_id: req.positionId ?? null,
      status: "submitted",
      request_payload: req as unknown as Record<string, unknown>,
      execution_mode: "testnet",
      bybit_order_id: req.orderLinkId,
    }).select("id").single();

    try {
      const r = await this.rest.request<{ orderId: string; orderLinkId: string }>({
        endpoint: "/v5/order/create",
        method: "POST",
        idempotencyKey: req.orderLinkId,
        body: {
          category: meta.category,
          symbol: req.symbol,
          side: req.side,
          orderType: req.orderType ?? "Market",
          qty: String(req.qty),
          reduceOnly: req.reduceOnly,
          orderLinkId: req.orderLinkId,
          timeInForce: "IOC",
          ...(req.orderType === "Limit" && req.price ? { price: String(req.price) } : {}),
        },
      });

      // Poll execution to confirm fill (small polling — websockets in a future pass).
      let filledQty = 0; let avgPrice: number | null = null; let fee = 0; let status: SubmitOrderResult["status"] = "submitted";
      for (let i = 0; i < 4; i++) {
        await new Promise((res) => setTimeout(res, 250));
        const exec = await this.rest.request<{ list: Array<{ execQty: string; execPrice: string; execFee: string; orderStatus: string }> }>({
          endpoint: "/v5/execution/list",
          method: "GET",
          query: { category: meta.category, orderLinkId: req.orderLinkId, limit: 20 },
        }).catch(() => null);
        const fills = exec?.result?.list ?? [];
        if (fills.length > 0) {
          let totalQty = 0; let notional = 0;
          for (const f of fills) {
            const q = Number(f.execQty); totalQty += q;
            notional += q * Number(f.execPrice);
            fee += Number(f.execFee || 0);
          }
          filledQty = totalQty;
          avgPrice = totalQty > 0 ? notional / totalQty : null;
          status = "filled";
          break;
        }
      }

      await this.sb.from("orders").update({
        status,
        bybit_order_id: r.result.orderId ?? req.orderLinkId,
        finalized_at: status === "filled" ? new Date().toISOString() : null,
        response_payload: r.result as unknown as Record<string, unknown>,
        qty: filledQty || req.qty,
        price: avgPrice ?? req.price,
      }).eq("id", orderRow!.id);

      return {
        orderLinkId: req.orderLinkId,
        bybitOrderId: r.result.orderId,
        status,
        filledQty: filledQty || (status === "filled" ? req.qty : 0),
        avgFillPrice: avgPrice,
        feeUsdt: fee,
      };
    } catch (e) {
      const isDup = e instanceof BybitError && (e.retCode === 110007 || e.retCode === 130021);
      await this.sb.from("orders").update({
        status: isDup ? "submitted" : "rejected",
        error_message: (e as Error).message.slice(0, 300),
        finalized_at: isDup ? null : new Date().toISOString(),
      }).eq("id", orderRow!.id);
      if (isDup) {
        return {
          orderLinkId: req.orderLinkId, bybitOrderId: null,
          status: "unknown", filledQty: 0, avgFillPrice: null, feeUsdt: 0,
          message: "duplicate_order_link_id",
        };
      }
      throw e;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const meta = await this.meta(symbol);
    try {
      await this.rest.request({
        endpoint: "/v5/position/set-leverage",
        method: "POST",
        body: {
          category: meta.category,
          symbol,
          buyLeverage: String(leverage),
          sellLeverage: String(leverage),
        },
      });
    } catch (e) {
      // 110043 = leverage not modified — benign
      if (e instanceof BybitError && e.retCode === 110043) return;
      throw e;
    }
    await this.sb.from("audit_log").insert({
      action: "testnet_set_leverage", target: symbol, after: { leverage },
    });
  }

  async setTradingStop(args: {
    symbol: string; positionId?: string;
    slPrice?: number | null; tpPrice?: number | null; tslCallbackPct?: number | null;
  }): Promise<void> {
    const meta = await this.meta(args.symbol);
    const body: Record<string, unknown> = {
      category: meta.category, symbol: args.symbol, positionIdx: 0,
    };
    if (args.slPrice != null) body.stopLoss = String(args.slPrice);
    if (args.tpPrice != null) body.takeProfit = String(args.tpPrice);
    // tslCallbackPct: Bybit expects an absolute "trailingStop" distance in price units.
    // If callback is in pct, the executor must convert before calling here. We pass through.
    if (args.tslCallbackPct != null) body.trailingStop = String(args.tslCallbackPct);

    try {
      await this.rest.request({ endpoint: "/v5/position/trading-stop", method: "POST", body });
    } catch (e) {
      // 34040 / 10001 = "not modified" / "no change" — treat as success
      if (e instanceof BybitError && (e.retCode === 34040 || e.retCode === 10001)) return;
      throw e;
    }

    if (args.positionId) {
      const patch: Record<string, unknown> = {};
      if (args.slPrice != null) patch.sl_price = args.slPrice;
      if (args.tslCallbackPct != null) {
        patch.tsl_active = true;
        patch.tsl_activated_at = new Date().toISOString();
      }
      if (Object.keys(patch).length) {
        await this.sb.from("positions").update(patch)
          .eq("id", args.positionId).eq("execution_mode", "testnet");
      }
    }
    await this.sb.from("audit_log").insert({
      action: "testnet_set_trading_stop", target: args.symbol, after: args,
    });
  }

  async cancelOrder(symbol: string, orderLinkId: string): Promise<void> {
    const meta = await this.meta(symbol);
    try {
      await this.rest.request({
        endpoint: "/v5/order/cancel",
        method: "POST",
        body: { category: meta.category, symbol, orderLinkId },
      });
    } catch (e) {
      // 110001 = order does not exist (already filled/cancelled) — benign
      if (e instanceof BybitError && e.retCode === 110001) return;
      throw e;
    }
    await this.sb.from("orders").update({
      status: "cancelled", finalized_at: new Date().toISOString(),
      error_message: "testnet_cancelled",
    }).eq("execution_mode", "testnet").eq("bybit_order_id", orderLinkId).eq("symbol", symbol);
  }
}
