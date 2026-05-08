// Bybit client interface + factory.
//
// Two implementations share the same surface:
//   - LiveBybitClient  — real Bybit V5 (Phase 3 implementation)
//   - PaperBybitClient — Postgres-backed simulator (this phase)
//
// Executor code stays mode-agnostic: getClient(mode) returns the right one.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ExecutionMode } from "./execution-mode.ts";
import { PaperBybitClient } from "./paper-client.ts";

export interface SubmitOrderRequest {
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  reduceOnly: boolean;
  orderLinkId: string;
  signalId?: string;
  positionId?: string;
  // For limit orders / SL/TSL — paper supports market only for now.
  orderType?: "Market" | "Limit";
  price?: number;
  purpose?: "entry" | "sl" | "tsl" | "tp1" | "tp2_rest" | "exit_full" | "manual_close";
}

export interface SubmitOrderResult {
  orderLinkId: string;
  bybitOrderId: string | null;
  status: "submitted" | "filled" | "rejected" | "unknown";
  filledQty: number;
  avgFillPrice: number | null;
  feeUsdt: number;
  message?: string;
}

export interface PositionSnapshot {
  symbol: string;
  side: "long" | "short" | "none";
  size: number;
  entryPrice: number | null;
  leverage: number | null;
}

export interface WalletSnapshot {
  totalEquity: number;
  availableBalance: number;
}

export interface BybitClient {
  readonly mode: ExecutionMode;
  getPosition(symbol: string): Promise<PositionSnapshot>;
  getWalletBalance(): Promise<WalletSnapshot>;
  submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResult>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  setTradingStop(args: {
    symbol: string;
    positionId?: string;
    slPrice?: number | null;
    tpPrice?: number | null;
    tslCallbackPct?: number | null;
  }): Promise<void>;
  cancelOrder(symbol: string, orderLinkId: string): Promise<void>;
}

class LiveBybitClient implements BybitClient {
  readonly mode: ExecutionMode = "live";
  // deno-lint-ignore no-unused-vars
  constructor(private sb: SupabaseClient) {}
  async getPosition(_s: string): Promise<PositionSnapshot> {
    throw new Error("LiveBybitClient.getPosition not implemented (Phase 3)");
  }
  async getWalletBalance(): Promise<WalletSnapshot> {
    throw new Error("LiveBybitClient.getWalletBalance not implemented (Phase 3)");
  }
  async submitOrder(_r: SubmitOrderRequest): Promise<SubmitOrderResult> {
    throw new Error("LiveBybitClient.submitOrder not implemented (Phase 3)");
  }
  async setLeverage(_s: string, _l: number): Promise<void> {
    throw new Error("LiveBybitClient.setLeverage not implemented (Phase 3)");
  }
  async setTradingStop(_a: unknown): Promise<void> {
    throw new Error("LiveBybitClient.setTradingStop not implemented (Phase 3)");
  }
  async cancelOrder(_s: string, _o: string): Promise<void> {
    throw new Error("LiveBybitClient.cancelOrder not implemented (Phase 3)");
  }
}

export function getClient(mode: ExecutionMode, sb: SupabaseClient): BybitClient {
  return mode === "paper" ? new PaperBybitClient(sb) : new LiveBybitClient(sb);
}
