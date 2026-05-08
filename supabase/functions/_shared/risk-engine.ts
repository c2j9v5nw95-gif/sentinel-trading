// Risk Engine — sequential gates evaluated in priority order.
// First failure wins. Each call writes exactly one risk_decisions row.
//
// Phase 2 scope:
//   1. kill_switch       app_settings.emergency_stop / entries_paused
//   2. risk              symbol enabled, recognized strategy code
//   3. transport_mismatch signal.transport vs symbols.preferred_transport
//   4. unprotected_pause any open position in 'unprotected' state blocks ENTERs
//   5. risk (concurrency) max_concurrent_positions for ENTERs
//   6. risk (no_position) EXITs require an open position for that symbol/side

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isEntry, isExit, sideOf, type SignalAction } from "./strategy-map.ts";

export type RiskGate =
  | "kill_switch"
  | "risk"
  | "transport_mismatch"
  | "unprotected_pause"
  | "exposure_limit"
  | "health"
  | "dedupe";

export type RiskOutcome = "pass" | "block";

export interface RiskDecision {
  outcome: RiskOutcome;
  gate: RiskGate;
  reason: string;
  metrics: Record<string, unknown>;
}

export interface RiskInput {
  signalId: string;
  action: SignalAction;
  symbol: string;
  strategy: string;
  tag: string;
  transport: "webhook" | "email";
  strategyCodeKnown: boolean;
}

export async function evaluateRisk(
  sb: SupabaseClient,
  inp: RiskInput,
): Promise<RiskDecision> {
  const { data: settings } = await sb
    .from("app_settings")
    .select("emergency_stop,entries_paused,max_concurrent_positions")
    .maybeSingle();

  // 1. kill switch
  if (settings?.emergency_stop) {
    return { outcome: "block", gate: "kill_switch", reason: "emergency_stop", metrics: {} };
  }
  if (settings?.entries_paused && isEntry(inp.action)) {
    return { outcome: "block", gate: "kill_switch", reason: "entries_paused", metrics: {} };
  }

  // 2. recognized strategy code (HEALTH excluded — never reaches here)
  if (!inp.strategyCodeKnown) {
    return { outcome: "block", gate: "risk", reason: "unknown_strategy_code", metrics: {} };
  }

  // 2. symbol enabled
  const { data: sym } = await sb
    .from("symbols")
    .select("enabled,preferred_transport")
    .eq("symbol", inp.symbol)
    .maybeSingle();

  if (!sym) {
    return { outcome: "block", gate: "risk", reason: "symbol_not_configured", metrics: { symbol: inp.symbol } };
  }
  if (!sym.enabled) {
    return { outcome: "block", gate: "risk", reason: "symbol_disabled", metrics: { symbol: inp.symbol } };
  }

  // 3. transport mismatch
  if (sym.preferred_transport !== "either" && sym.preferred_transport !== inp.transport) {
    return {
      outcome: "block",
      gate: "transport_mismatch",
      reason: `expected ${sym.preferred_transport}, got ${inp.transport}`,
      metrics: { preferred: sym.preferred_transport, actual: inp.transport },
    };
  }

  // 4. unprotected pause (entries only)
  if (isEntry(inp.action)) {
    const { count: unprotectedCount } = await sb
      .from("positions")
      .select("id", { count: "exact", head: true })
      .is("closed_at", null)
      .eq("protection_state", "unprotected");
    if ((unprotectedCount ?? 0) > 0) {
      return {
        outcome: "block",
        gate: "unprotected_pause",
        reason: "unprotected_positions_present",
        metrics: { unprotected_count: unprotectedCount },
      };
    }
  }

  // 5. concurrency cap (entries only)
  if (isEntry(inp.action)) {
    const max = settings?.max_concurrent_positions ?? 5;
    const { count: openCount } = await sb
      .from("positions")
      .select("id", { count: "exact", head: true })
      .is("closed_at", null);
    if ((openCount ?? 0) >= max) {
      return {
        outcome: "block",
        gate: "risk",
        reason: "max_concurrent_positions",
        metrics: { open: openCount, max },
      };
    }
  }

  // 6. exits require an open matching position
  if (isExit(inp.action)) {
    const side = sideOf(inp.action);
    const { count: matching } = await sb
      .from("positions")
      .select("id", { count: "exact", head: true })
      .is("closed_at", null)
      .eq("symbol", inp.symbol)
      .eq("side", side!);
    if ((matching ?? 0) === 0) {
      return {
        outcome: "block",
        gate: "risk",
        reason: "no_open_position",
        metrics: { symbol: inp.symbol, side },
      };
    }
  }

  return { outcome: "pass", gate: "risk", reason: "all_gates_passed", metrics: {} };
}

export async function recordDecision(
  sb: SupabaseClient,
  signalId: string,
  d: RiskDecision,
): Promise<void> {
  await sb.from("risk_decisions").insert({
    signal_id: signalId,
    gate: d.gate,
    outcome: d.outcome,
    reason: d.reason,
    metrics: d.metrics,
  });
}
