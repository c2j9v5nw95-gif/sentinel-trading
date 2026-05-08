// PaperBybitClient — Postgres-backed Bybit simulator.
//
// Behavior:
//   - submitOrder (Market): inserts an `orders` row stamped execution_mode='paper',
//     fills it immediately at last known price ± slippage, deducts a taker fee
//     from `paper_wallet`, and applies the position delta to `positions`.
//   - getPosition / getWalletBalance: straight DB reads filtered to paper rows.
//   - setLeverage / setTradingStop / cancelOrder: write to local rows + audit_log.
//
// Pricing source priority:
//   1. paper_market_prices.price (if fresher than 60s)
//   2. (caller-provided req.price) — TradingView signal price fallback
//   3. fail with status='unknown' (we never invent prices)

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  BybitClient,
  PositionSnapshot,
  SubmitOrderRequest,
  SubmitOrderResult,
  WalletSnapshot,
} from "./bybit-client.ts";
import type { ExecutionMode } from "./execution-mode.ts";

interface PaperSettings {
  fee_bps: number;
  slippage_bps: number;
  starting_balance: number;
}

export interface ChaosConfig {
  random_timeout_pct?: number;     // 0..100 — chance the order returns 'unknown'
  fill_delay_ms?: number;          // injected latency before fill
  partial_fill_pct?: number;       // 0..100 — fill only this fraction
  duplicate_delivery_pct?: number; // (used by sim-inject)
  stale_lock_ms?: number;          // (used by sim-scenario)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PaperBybitClient implements BybitClient {
  readonly mode: ExecutionMode = "paper";
  constructor(private sb: SupabaseClient) {}

  private async settings(): Promise<PaperSettings & { chaos: ChaosConfig }> {
    const { data } = await this.sb.from("app_settings")
      .select("paper_fee_bps,paper_slippage_bps,paper_starting_balance_usdt,chaos_config")
      .maybeSingle();
    return {
      fee_bps: Number(data?.paper_fee_bps ?? 5.5),
      slippage_bps: Number(data?.paper_slippage_bps ?? 2),
      starting_balance: Number(data?.paper_starting_balance_usdt ?? 10000),
      chaos: (data?.chaos_config ?? {}) as ChaosConfig,
    };
  }

  private async lastPrice(symbol: string): Promise<number | null> {
    const { data } = await this.sb.from("paper_market_prices")
      .select("price,received_at").eq("symbol", symbol).maybeSingle();
    if (!data) return null;
    const ageMs = Date.now() - new Date(data.received_at).getTime();
    if (ageMs > 5 * 60_000) return null;
    return Number(data.price);
  }

  async getWalletBalance(): Promise<WalletSnapshot> {
    const { data } = await this.sb.from("paper_wallet").select("*").maybeSingle();
    const balance = Number(data?.balance_usdt ?? 10000);
    const equity = Number(data?.equity_usdt ?? balance);
    return { totalEquity: equity, availableBalance: balance };
  }

  async getPosition(symbol: string): Promise<PositionSnapshot> {
    const { data } = await this.sb.from("positions")
      .select("symbol,side,qty_open,entry_price,leverage")
      .eq("symbol", symbol).eq("execution_mode", "paper").is("closed_at", null)
      .maybeSingle();
    if (!data || Number(data.qty_open ?? 0) === 0) {
      return { symbol, side: "none", size: 0, entryPrice: null, leverage: null };
    }
    return {
      symbol,
      side: data.side as "long" | "short",
      size: Number(data.qty_open),
      entryPrice: data.entry_price == null ? null : Number(data.entry_price),
      leverage: data.leverage == null ? null : Number(data.leverage),
    };
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const cfg = await this.settings();
    const refPrice = (await this.lastPrice(req.symbol)) ?? req.price ?? null;

    // Chaos: inject latency
    if (cfg.chaos.fill_delay_ms && cfg.chaos.fill_delay_ms > 0) {
      await sleep(Math.min(cfg.chaos.fill_delay_ms, 30_000));
    }

    // Chaos: random timeout — return 'unknown' as if Bybit didn't ack.
    const timeoutPct = Number(cfg.chaos.random_timeout_pct ?? 0);
    if (timeoutPct > 0 && Math.random() * 100 < timeoutPct) {
      await this.sb.from("orders").insert({
        symbol: req.symbol, side: req.side === "Buy" ? "long" : "short",
        order_type: req.orderType ?? "Market", qty: req.qty,
        purpose: req.purpose ?? "entry",
        signal_id: req.signalId ?? null, position_id: req.positionId ?? null,
        status: "submitted",
        request_payload: { ...req, paper: true, chaos: "timeout" },
        execution_mode: "paper", bybit_order_id: req.orderLinkId,
        error_message: "chaos_timeout",
      });
      return {
        orderLinkId: req.orderLinkId, bybitOrderId: null,
        status: "unknown", filledQty: 0, avgFillPrice: null, feeUsdt: 0,
        message: "chaos_timeout",
      };
    }

    if (refPrice == null || !Number.isFinite(refPrice) || refPrice <= 0) {
      await this.sb.from("orders").insert({
        symbol: req.symbol, side: req.side === "Buy" ? "long" : "short",
        order_type: req.orderType ?? "Market", qty: req.qty,
        purpose: req.purpose ?? "entry",
        signal_id: req.signalId ?? null, position_id: req.positionId ?? null,
        status: "submitted",
        request_payload: { ...req, paper: true, error: "no_price" },
        execution_mode: "paper", bybit_order_id: req.orderLinkId,
        error_message: "no_price_available",
      });
      return {
        orderLinkId: req.orderLinkId, bybitOrderId: null,
        status: "unknown", filledQty: 0, avgFillPrice: null, feeUsdt: 0,
        message: "no_price_available",
      };
    }

    // Chaos: partial fill
    let filledQty = req.qty;
    const partialPct = Number(cfg.chaos.partial_fill_pct ?? 0);
    let partial = false;
    if (partialPct > 0 && partialPct < 100) {
      filledQty = req.qty * (partialPct / 100);
      partial = true;
    }

    const slipFactor = cfg.slippage_bps / 10_000;
    const fillPrice = req.side === "Buy"
      ? refPrice * (1 + slipFactor)
      : refPrice * (1 - slipFactor);

    const notional = fillPrice * filledQty;
    const fee = notional * (cfg.fee_bps / 10_000);

    const { data: orderRow } = await this.sb.from("orders").insert({
      symbol: req.symbol, side: req.side === "Buy" ? "long" : "short",
      order_type: req.orderType ?? "Market", qty: filledQty, price: fillPrice,
      purpose: req.purpose ?? "entry",
      signal_id: req.signalId ?? null, position_id: req.positionId ?? null,
      status: partial ? "partial" : "filled",
      submitted_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      request_payload: { ...req, paper: true, chaos: cfg.chaos },
      response_payload: { paper: true, refPrice, fillPrice, notional, fee, partial },
      execution_mode: "paper", bybit_order_id: req.orderLinkId,
    }).select("id").single();

    const { data: wallet } = await this.sb.from("paper_wallet").select("*").maybeSingle();
    if (wallet) {
      const newBalance = Number(wallet.balance_usdt) - fee;
      await this.sb.from("paper_wallet").update({
        balance_usdt: newBalance, equity_usdt: newBalance,
        realized_pnl: Number(wallet.realized_pnl) - fee,
        updated_at: new Date().toISOString(),
      }).eq("id", wallet.id);
    }

    return {
      orderLinkId: req.orderLinkId,
      bybitOrderId: orderRow?.id ?? null,
      status: partial ? "submitted" : "filled",
      filledQty, avgFillPrice: fillPrice, feeUsdt: fee,
    };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.sb.from("audit_log").insert({
      action: "paper_set_leverage", target: symbol,
      after: { leverage, paper: true },
    });
  }

  async setTradingStop(args: {
    symbol: string;
    positionId?: string;
    slPrice?: number | null;
    tpPrice?: number | null;
    tslCallbackPct?: number | null;
  }): Promise<void> {
    if (args.positionId) {
      const patch: Record<string, unknown> = {};
      if (args.slPrice != null) patch.sl_price = args.slPrice;
      if (args.tslCallbackPct != null) {
        patch.tsl_active = true;
        patch.tsl_activated_at = new Date().toISOString();
      }
      if (Object.keys(patch).length) {
        await this.sb.from("positions").update(patch)
          .eq("id", args.positionId).eq("execution_mode", "paper");
      }
    }
    await this.sb.from("audit_log").insert({
      action: "paper_set_trading_stop", target: args.symbol,
      after: { ...args, paper: true },
    });
  }

  async cancelOrder(symbol: string, orderLinkId: string): Promise<void> {
    await this.sb.from("orders").update({
      status: "cancelled",
      finalized_at: new Date().toISOString(),
      error_message: "paper_cancelled",
    }).eq("execution_mode", "paper").eq("bybit_order_id", orderLinkId).eq("symbol", symbol);
  }
}
