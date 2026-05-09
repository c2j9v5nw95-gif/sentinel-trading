// VenueBybitClient — shared Bybit V5 REST implementation for real venues.
//
// TestnetBybitClient and LiveBybitClient are intentionally separate wrappers
// around this base. Live never constructs, imports, or validates testnet
// credentials.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  BybitClient, PositionSnapshot, SubmitOrderRequest, SubmitOrderResult, WalletSnapshot,
} from "./bybit-client.ts";
import type { ExecutionMode } from "./execution-mode.ts";
import { BybitRest, BybitError, type BybitTrace } from "./bybit-rest.ts";
import { BridgeBybitRest, bridgeConfigured } from "./bridge-rest.ts";
import { buildPositionListRequest, buildOrderCreateRequest } from "./bybit-requests.ts";

interface SymbolMeta { category: "linear"; }

/** Common subset of BybitRest / BridgeBybitRest used by VenueBybitClient. */
type RestLike = {
  setSignalContext(id: string | null): void;
  request<T = unknown>(opts: import("./bybit-rest.ts").BybitRequestOpts): Promise<import("./bybit-rest.ts").BybitResponse<T>>;
};

export class VenueBybitClient implements BybitClient {
  readonly mode: ExecutionMode;
  /** True when live calls are routed through the private execution bridge VPS. */
  readonly viaBridge: boolean;
  private rest: RestLike;

  constructor(
    private sb: SupabaseClient,
    opts: { mode: Extract<ExecutionMode, "testnet" | "live">; baseUrl: string; apiKey: string; apiSecret: string },
  ) {
    this.mode = opts.mode;
    // Bridge is only used for live mode. Testnet keeps direct path so we can
    // continue to compare/diff request shapes during the cutover.
    this.viaBridge = opts.mode === "live" && bridgeConfigured();

    if (this.viaBridge) {
      this.rest = new BridgeBybitRest({
        bridgeUrl: Deno.env.get("EXECUTION_BRIDGE_URL")!,
        bridgeSecret: Deno.env.get("EXECUTION_BRIDGE_SECRET")!,
        label: `${opts.mode}-executor-bridge`,
        traceWriter: (trace) => this.persistTrace(trace),
      });
    } else {
      if (!opts.apiKey || !opts.apiSecret) {
        throw new Error(`BYBIT_${opts.mode.toUpperCase()}_API_KEY / BYBIT_${opts.mode.toUpperCase()}_API_SECRET not configured`);
      }
      this.rest = new BybitRest({
        apiKey: opts.apiKey,
        apiSecret: opts.apiSecret,
        baseUrl: opts.baseUrl,
        label: `${opts.mode}-executor`,
        traceWriter: (trace) => this.persistTrace(trace),
      });
    }
  }

  /** Tag every subsequent call with this signal id so traces can be diff'd. */
  setSignalContext(signalId: string | null) { this.rest.setSignalContext(signalId); }

  private async persistTrace(trace: BybitTrace) {
    // Persist live traces always; testnet only when explicitly enabled.
    if (this.mode !== "live" && Deno.env.get("BYBIT_PERSIST_TESTNET_TRACES") !== "1") return;
    await this.sb.from("bybit_request_traces").insert({
      label: trace.label,
      mode: this.mode,
      signal_id: trace.signal_id,
      base_url: trace.base_url,
      endpoint: trace.endpoint,
      method: trace.method,
      query: trace.query,
      query_string: trace.query_string,
      body_keys: trace.body_keys,
      body_size: trace.body_size,
      body_sha256_prefix: trace.body_sha256_prefix,
      recv_window_ms: trace.recv_window_ms,
      timestamp_ms: trace.timestamp_ms,
      sign_payload_prefix: trace.sign_payload_prefix,
      sign_len: trace.sign_len,
      api_key_prefix: trace.api_key_prefix,
      idempotency_key: trace.idempotency_key,
      attempt: trace.attempt,
      http_status: trace.http_status,
      content_type: trace.content_type,
      cf_ray: trace.cf_ray,
      server: trace.server,
      bapi_request_id: trace.bapi_request_id,
      amz_cf_id: trace.amz_cf_id,
      amz_cf_pop: trace.amz_cf_pop,
      via: trace.via,
      ret_code: trace.ret_code,
      ret_msg: trace.ret_msg,
      body_snippet: trace.body_snippet,
      duration_ms: trace.duration_ms,
      ok: trace.ok,
      error_kind: trace.error_kind,
    });
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
    const r = await this.rest.request<{ list: Array<{ symbol: string; side: string; size: string; avgPrice: string; leverage: string }> }>(
      buildPositionListRequest({ category: meta.category, symbol }),
    );
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

    const { data: orderRow } = await this.sb.from("orders").insert({
      symbol: req.symbol, side: req.side === "Buy" ? "long" : "short",
      order_type: req.orderType ?? "Market", qty: req.qty, price: req.price,
      purpose: req.purpose ?? "entry",
      signal_id: req.signalId ?? null, position_id: req.positionId ?? null,
      status: "submitted",
      request_payload: req as unknown as Record<string, unknown>,
      execution_mode: this.mode,
      bybit_order_id: req.orderLinkId,
    }).select("id").single();

    try {
      const r = await this.rest.request<{ orderId: string; orderLinkId: string }>(
        buildOrderCreateRequest({
          category: meta.category,
          symbol: req.symbol,
          side: req.side,
          orderType: req.orderType ?? "Market",
          qty: String(req.qty),
          reduceOnly: req.reduceOnly,
          orderLinkId: req.orderLinkId,
          timeInForce: "IOC",
          price: req.orderType === "Limit" && req.price ? String(req.price) : undefined,
        }),
      );

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
      if (e instanceof BybitError && e.retCode === 110043) return;
      throw e;
    }
    await this.sb.from("audit_log").insert({
      action: `${this.mode}_set_leverage`, target: symbol, after: { leverage },
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
    if (args.tslCallbackPct != null) body.trailingStop = String(args.tslCallbackPct);

    try {
      await this.rest.request({ endpoint: "/v5/position/trading-stop", method: "POST", body });
    } catch (e) {
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
          .eq("id", args.positionId).eq("execution_mode", this.mode);
      }
    }
    await this.sb.from("audit_log").insert({
      action: `${this.mode}_set_trading_stop`, target: args.symbol, after: args,
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
      if (e instanceof BybitError && e.retCode === 110001) return;
      throw e;
    }
    await this.sb.from("orders").update({
      status: "cancelled", finalized_at: new Date().toISOString(),
      error_message: `${this.mode}_cancelled`,
    }).eq("execution_mode", this.mode).eq("bybit_order_id", orderLinkId).eq("symbol", symbol);
  }
}
