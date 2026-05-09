// Bybit client interface + factory.
//
// Implementations:
//   - PaperBybitClient   — Postgres-backed simulator
//   - TestnetBybitClient — real Bybit V5 TESTNET REST
//   - LiveBybitClient    — real Bybit V5 MAINNET REST
//
// Executor stays mode-agnostic: getClient(mode) returns the right one.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ExecutionMode } from "./execution-mode.ts";
import { PaperBybitClient } from "./paper-client.ts";
import { TestnetBybitClient } from "./testnet-client.ts";

export interface SubmitOrderRequest {
  symbol: string;
  side: "Buy" | "Sell";
  qty: number;
  reduceOnly: boolean;
  orderLinkId: string;
  signalId?: string;
  positionId?: string;
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

// LiveBybitClient lives in live-client.ts and is gated by liveExecutionGate.
// It is intentionally independent from TestnetBybitClient initialization, so
// live execution never requires BYBIT_TESTNET_* credentials.
import { LiveBybitClient, liveExecutionGate } from "./live-client.ts";

export function getClient(
  mode: ExecutionMode,
  sb: SupabaseClient,
  opts?: { liveGatePassed?: boolean },
): BybitClient {
  if (mode === "paper")   return new PaperBybitClient(sb);
  if (mode === "testnet") return new TestnetBybitClient(sb);
  if (mode === "live" && opts?.liveGatePassed) return new LiveBybitClient(sb);
  // mode === "live" without a passed gate. Callers must pre-check via
  // liveExecutionGate() and forward { liveGatePassed: true } to opt in.
  throw new Error("live_execution_disabled: complete liveExecutionGate before requesting mode='live'");
}

export { liveExecutionGate, LiveBybitClient };
