// dispatcher — single-signal end-to-end runner used by process-signal.
// Pure function (no HTTP), so it can also be invoked inline by ingest.
//
// Flow:
//   1. Optimistic claim: queued -> processing
//   2. type=stats  -> recordHealth, mark processed
//   3. type=trade  -> Health Gate -> Risk Engine -> mark accepted | rejected
//      (Bybit execution is Phase 3; we stop at status='accepted')
//   4. Always write an audit_log entry.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { evaluateHealth } from "./health-gate.ts";
import { evaluateRisk, recordDecision } from "./risk-engine.ts";
import { resolveStrategyCode, isEntry, isExit, type SignalAction } from "./strategy-map.ts";

export interface DispatchResult {
  signalId: string;
  status: "processed" | "accepted" | "rejected" | "skipped" | "error";
  reason?: string;
  gate?: string;
}

async function recordHealth(sb: SupabaseClient, signal: any): Promise<void> {
  const payload = signal.payload ?? {};
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  await sb.from("health_snapshots").insert({
    symbol: signal.symbol,
    strategy: signal.strategy,
    tag: signal.tag ?? "",
    net_profit: num(payload.net_profit),
    winrate: num(payload.winrate),
    profit_factor: num(payload.profit_factor),
    bar_time: signal.bar_time,
    source_signal_id: signal.id,
    payload,
  });

  // Touch strategies.last_health_at; insert with NULL thresholds if missing.
  const { data: existing } = await sb
    .from("strategies")
    .select("id")
    .eq("name", signal.strategy)
    .eq("tag", signal.tag ?? "")
    .maybeSingle();
  if (existing) {
    await sb.from("strategies").update({ last_health_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await sb.from("strategies").insert({
      name: signal.strategy,
      tag: signal.tag ?? "",
      enabled: true,
      last_health_at: new Date().toISOString(),
    });
  }
}

export async function dispatchSignal(
  sb: SupabaseClient,
  signalId: string,
): Promise<DispatchResult> {
  // 1. Claim
  const { data: claimed, error: claimErr } = await sb
    .from("signals")
    .update({ status: "processing" })
    .eq("id", signalId)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();

  if (claimErr) {
    return { signalId, status: "error", reason: claimErr.message };
  }
  if (!claimed) {
    return { signalId, status: "skipped", reason: "not_queued" };
  }

  const signal = claimed;

  try {
    if (signal.type === "stats" || signal.action === "HEALTH") {
      await recordHealth(sb, signal);
      await sb.from("signals").update({
        status: "processed",
        processed_at: new Date().toISOString(),
        decision_reason: "health_recorded",
      }).eq("id", signal.id);
      await sb.from("audit_log").insert({
        action: "signal_dispatched",
        target: signal.id,
        after: { type: "stats", outcome: "processed" },
      });
      return { signalId: signal.id, status: "processed", reason: "health_recorded" };
    }

    // trade signal — must have a known strategy code & symbol
    const action = signal.action as SignalAction | null;
    const mapping = resolveStrategyCode(signal.strategy_code);
    const strategyCodeKnown = !!mapping && action !== null && action !== "HEALTH";

    if (!signal.symbol || !action || action === "HEALTH") {
      const reason = !signal.symbol ? "missing_symbol" : "missing_action";
      await recordDecision(sb, signal.id, {
        outcome: "block", gate: "risk", reason, metrics: {},
      });
      await sb.from("signals").update({
        status: "rejected",
        processed_at: new Date().toISOString(),
        decision_reason: reason,
      }).eq("id", signal.id);
      return { signalId: signal.id, status: "rejected", reason, gate: "risk" };
    }

    // Health Gate (only for trade signals)
    const health = await evaluateHealth(sb, {
      symbol: signal.symbol,
      strategy: signal.strategy ?? "",
      tag: signal.tag ?? "",
    });
    if (!health.pass) {
      await recordDecision(sb, signal.id, {
        outcome: "block", gate: "health", reason: health.reason, metrics: health.metrics,
      });
      await sb.from("signals").update({
        status: "rejected",
        processed_at: new Date().toISOString(),
        decision_reason: `health:${health.reason}`,
      }).eq("id", signal.id);
      await sb.from("audit_log").insert({
        action: "signal_dispatched",
        target: signal.id,
        after: { gate: "health", outcome: "block", reason: health.reason },
      });
      return { signalId: signal.id, status: "rejected", reason: health.reason, gate: "health" };
    }

    // Risk Engine
    const risk = await evaluateRisk(sb, {
      signalId: signal.id,
      action,
      symbol: signal.symbol,
      strategy: signal.strategy ?? "",
      tag: signal.tag ?? "",
      transport: signal.transport,
      strategyCodeKnown,
    });
    await recordDecision(sb, signal.id, risk);

    if (risk.outcome === "block") {
      await sb.from("signals").update({
        status: "rejected",
        processed_at: new Date().toISOString(),
        decision_reason: `${risk.gate}:${risk.reason}`,
      }).eq("id", signal.id);
      await sb.from("audit_log").insert({
        action: "signal_dispatched",
        target: signal.id,
        after: { gate: risk.gate, outcome: "block", reason: risk.reason, metrics: risk.metrics },
      });
      return { signalId: signal.id, status: "rejected", reason: risk.reason, gate: risk.gate };
    }

    // Pass — Phase 2 stops here. Phase 3 will pick 'accepted' rows for execution.
    await sb.from("signals").update({
      status: "accepted",
      processed_at: new Date().toISOString(),
      decision_reason: "gates_passed",
    }).eq("id", signal.id);
    await sb.from("audit_log").insert({
      action: "signal_dispatched",
      target: signal.id,
      after: {
        gate: "risk", outcome: "pass",
        action, symbol: signal.symbol, strategy: signal.strategy, tag: signal.tag,
        portion: signal.portion,
        note: "phase2: execution stub; not sent to Bybit",
      },
    });
    const _isEntryOrExit = isEntry(action) || isExit(action);
    void _isEntryOrExit;
    return { signalId: signal.id, status: "accepted", reason: "gates_passed", gate: "risk" };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await sb.from("signals").update({
      status: "error",
      processed_at: new Date().toISOString(),
      decision_reason: `dispatch_error:${msg.slice(0, 200)}`,
    }).eq("id", signal.id);
    await sb.from("error_log").insert({
      source: "dispatcher",
      message: msg,
      stack: (e as Error).stack ?? null,
      context: { signal_id: signal.id },
    });
    return { signalId: signal.id, status: "error", reason: msg };
  }
}
