// Risk Engine — sequential gates, first-failure-wins, with mode awareness.
//   mode='standard'      ENTRY checks: kill_switch, symbol, transport,
//                        unprotected_pause, concurrency
//   mode='exit_priority' EXIT checks:  kill_switch (only if blocks_exits=true),
//                        symbol, no_open_position
// Health Gate is run separately by the dispatcher (entries only).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isEntry, isExit, sideOf, type SignalAction } from "./strategy-map.ts";
import { Trail } from "./trail.ts";

export type RiskGate =
  | "kill_switch" | "risk" | "transport_mismatch"
  | "unprotected_pause" | "exposure_limit" | "health" | "dedupe";

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
  mode: "standard" | "exit_priority";
}

export async function evaluateRisk(
  sb: SupabaseClient, inp: RiskInput, trail: Trail,
): Promise<RiskDecision> {
  const { data: settings } = await sb.from("app_settings")
    .select("emergency_stop,entries_paused,max_concurrent_positions,emergency_stop_blocks_exits")
    .maybeSingle();

  // 1. Kill switch
  if (settings?.emergency_stop) {
    if (inp.mode === "exit_priority" && !settings.emergency_stop_blocks_exits) {
      trail.add("kill_switch", "skip", "exit_priority_bypass");
    } else {
      trail.add("kill_switch", "fail", "emergency_stop");
      return { outcome: "block", gate: "kill_switch", reason: "emergency_stop", metrics: {} };
    }
  } else if (settings?.entries_paused && isEntry(inp.action)) {
    trail.add("kill_switch", "fail", "entries_paused");
    return { outcome: "block", gate: "kill_switch", reason: "entries_paused", metrics: {} };
  } else {
    trail.add("kill_switch", "pass");
  }

  // 2. Strategy code recognized
  if (!inp.strategyCodeKnown) {
    trail.add("strategy_code", "fail", "unknown");
    return { outcome: "block", gate: "risk", reason: "unknown_strategy_code", metrics: {} };
  }
  trail.add("strategy_code", "pass");

  // 3. Symbol configured + enabled
  const { data: sym } = await sb.from("symbols")
    .select("enabled,preferred_transport")
    .eq("symbol", inp.symbol).maybeSingle();
  if (!sym) {
    trail.add("symbol", "fail", "not_configured", { symbol: inp.symbol });
    return { outcome: "block", gate: "risk", reason: "symbol_not_configured", metrics: { symbol: inp.symbol } };
  }
  if (!sym.enabled) {
    trail.add("symbol", "fail", "disabled", { symbol: inp.symbol });
    return { outcome: "block", gate: "risk", reason: "symbol_disabled", metrics: { symbol: inp.symbol } };
  }
  trail.add("symbol", "pass");

  // 4. Transport — entries only; exits bypass
  if (inp.mode === "exit_priority") {
    trail.add("transport", "skip", "exit_priority_bypass");
  } else if (sym.preferred_transport !== "either" && sym.preferred_transport !== inp.transport) {
    trail.add("transport", "fail", "mismatch",
      { preferred: sym.preferred_transport, actual: inp.transport });
    return {
      outcome: "block", gate: "transport_mismatch",
      reason: `expected ${sym.preferred_transport}, got ${inp.transport}`,
      metrics: { preferred: sym.preferred_transport, actual: inp.transport },
    };
  } else {
    trail.add("transport", "pass");
  }

  // 5. Unprotected pause — entries only
  if (isEntry(inp.action)) {
    const { count } = await sb.from("positions")
      .select("id", { count: "exact", head: true })
      .is("closed_at", null).eq("protection_state", "unprotected");
    if ((count ?? 0) > 0) {
      trail.add("unprotected_pause", "fail", "unprotected_positions_present", { count });
      return {
        outcome: "block", gate: "unprotected_pause",
        reason: "unprotected_positions_present",
        metrics: { unprotected_count: count },
      };
    }
    trail.add("unprotected_pause", "pass");
  } else {
    trail.add("unprotected_pause", "skip", "exit");
  }

  // 6. Concurrency — entries only
  if (isEntry(inp.action)) {
    const max = settings?.max_concurrent_positions ?? 5;
    const { count } = await sb.from("positions")
      .select("id", { count: "exact", head: true }).is("closed_at", null);
    if ((count ?? 0) >= max) {
      trail.add("concurrency", "fail", "max_concurrent_positions", { open: count, max });
      return {
        outcome: "block", gate: "risk", reason: "max_concurrent_positions",
        metrics: { open: count, max },
      };
    }
    trail.add("concurrency", "pass", undefined, { open: count, max });
  } else {
    trail.add("concurrency", "skip", "exit");
  }

  // 7. Position check — exits only
  if (isExit(inp.action)) {
    const side = sideOf(inp.action);
    const { count } = await sb.from("positions")
      .select("id", { count: "exact", head: true })
      .is("closed_at", null).eq("symbol", inp.symbol).eq("side", side!);
    if ((count ?? 0) === 0) {
      trail.add("position_check", "fail", "no_open_position",
        { symbol: inp.symbol, side });
      return {
        outcome: "block", gate: "risk", reason: "no_open_position",
        metrics: { symbol: inp.symbol, side },
      };
    }
    trail.add("position_check", "pass", undefined, { matching: count });
  }

  return { outcome: "pass", gate: "risk", reason: "all_gates_passed", metrics: {} };
}

export async function recordDecision(
  sb: SupabaseClient, signalId: string, d: RiskDecision,
): Promise<void> {
  await sb.from("risk_decisions").insert({
    signal_id: signalId, gate: d.gate, outcome: d.outcome,
    reason: d.reason, metrics: d.metrics,
  });
}
