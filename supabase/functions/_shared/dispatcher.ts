// dispatcher — single-signal end-to-end runner.
//
// Pipeline:
//   claim(queued -> processing) -> stats? recordHealth + processed
//                                -> trade?
//                                     mode = isExit ? exit_priority : standard
//                                     entries: Health Gate, then Risk Engine
//                                     exits:   skip Health Gate, Risk Engine in exit_priority mode
//                                -> accepted | rejected
//
// Errors:
//   - increment retry_count, requeue if < MAX_RETRIES
//   - else mark dead_letter, persist error_stack, system_alerts critical row
//
// Trail is appended at every step and flushed before return (always).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { evaluateHealth } from "./health-gate.ts";
import { evaluateRisk, recordDecision } from "./risk-engine.ts";
import { resolveStrategyCode, isExit, type SignalAction } from "./strategy-map.ts";
import { Trail, flushTrail } from "./trail.ts";
import { resolveExecutionMode } from "./execution-mode.ts";

const MAX_RETRIES = 2;

export interface DispatchResult {
  signalId: string;
  status: "processed" | "accepted" | "rejected" | "skipped" | "error" | "dead_letter" | "requeued";
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
    symbol: signal.symbol, strategy: signal.strategy, tag: signal.tag ?? "",
    net_profit: num(payload.net_profit),
    winrate: num(payload.winrate),
    profit_factor: num(payload.profit_factor),
    bar_time: signal.bar_time,
    source_signal_id: signal.id,
    payload,
  });

  const { data: existing } = await sb.from("strategies").select("id")
    .eq("name", signal.strategy).eq("tag", signal.tag ?? "").maybeSingle();
  if (existing) {
    await sb.from("strategies").update({ last_health_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await sb.from("strategies").insert({
      name: signal.strategy, tag: signal.tag ?? "", enabled: true,
      last_health_at: new Date().toISOString(),
    });
  }
}

export async function dispatchSignal(
  sb: SupabaseClient, signalId: string,
): Promise<DispatchResult> {
  const { data: claimed, error: claimErr } = await sb.from("signals")
    .update({ status: "processing" })
    .eq("id", signalId).eq("status", "queued")
    .select("*").maybeSingle();

  if (claimErr) return { signalId, status: "error", reason: claimErr.message };
  if (!claimed) return { signalId, status: "skipped", reason: "not_queued" };

  const signal = claimed;
  // Existing trail (from ingest) is preserved and extended.
  const trail = new Trail();
  for (const s of (signal.decision_trail ?? [])) trail.add(s.step, s.outcome, s.reason, s.metrics);
  trail.add("claimed", "info", undefined, { retry_count: signal.retry_count });

  try {
    if (signal.type === "stats" || signal.action === "HEALTH") {
      await recordHealth(sb, signal);
      trail.add("health_recorded", "info");
      trail.add("processed", "info");
      await flushTrail(sb, signal.id, trail);
      await sb.from("signals").update({
        status: "processed",
        processed_at: new Date().toISOString(),
        decision_reason: "health_recorded",
      }).eq("id", signal.id);
      await sb.from("audit_log").insert({
        action: "signal_dispatched", target: signal.id,
        after: { type: "stats", outcome: "processed" },
      });
      return { signalId: signal.id, status: "processed", reason: "health_recorded" };
    }

    const action = signal.action as SignalAction | null;
    const mapping = resolveStrategyCode(signal.strategy_code);
    const strategyCodeKnown = !!mapping && action !== null && action !== "HEALTH";

    if (!signal.symbol || !action || action === "HEALTH") {
      const reason = !signal.symbol ? "missing_symbol" : "missing_action";
      trail.add("malformed", "fail", reason);
      trail.add("rejected", "info");
      await flushTrail(sb, signal.id, trail);
      await recordDecision(sb, signal.id, { outcome: "block", gate: "risk", reason, metrics: {} });
      await sb.from("signals").update({
        status: "rejected",
        processed_at: new Date().toISOString(),
        decision_reason: reason,
      }).eq("id", signal.id);
      return { signalId: signal.id, status: "rejected", reason, gate: "risk" };
    }

    const exitMode = isExit(action);
    const mode: "standard" | "exit_priority" = exitMode ? "exit_priority" : "standard";

    // Health Gate — entries only; exits bypass for risk-reduction priority.
    if (exitMode) {
      trail.add("health_gate", "skip", "exit_priority");
    } else {
      const health = await evaluateHealth(sb, {
        symbol: signal.symbol, strategy: signal.strategy ?? "", tag: signal.tag ?? "",
      });
      if (!health.pass) {
        trail.add("health_gate", "fail", health.reason, health.metrics);
        trail.add("rejected", "info");
        await flushTrail(sb, signal.id, trail);
        await recordDecision(sb, signal.id, {
          outcome: "block", gate: "health", reason: health.reason, metrics: health.metrics,
        });
        await sb.from("signals").update({
          status: "rejected", processed_at: new Date().toISOString(),
          decision_reason: `health:${health.reason}`,
        }).eq("id", signal.id);
        await sb.from("audit_log").insert({
          action: "signal_dispatched", target: signal.id,
          after: { gate: "health", outcome: "block", reason: health.reason },
        });
        return { signalId: signal.id, status: "rejected", reason: health.reason, gate: "health" };
      }
      trail.add("health_gate", "pass", health.reason, health.metrics);
    }

    const risk = await evaluateRisk(sb, {
      signalId: signal.id, action,
      symbol: signal.symbol, strategy: signal.strategy ?? "", tag: signal.tag ?? "",
      transport: signal.transport, strategyCodeKnown, mode,
    }, trail);
    await recordDecision(sb, signal.id, risk);

    if (risk.outcome === "block") {
      trail.add("rejected", "info", `${risk.gate}:${risk.reason}`);
      await flushTrail(sb, signal.id, trail);
      await sb.from("signals").update({
        status: "rejected", processed_at: new Date().toISOString(),
        decision_reason: `${risk.gate}:${risk.reason}`,
      }).eq("id", signal.id);
      await sb.from("audit_log").insert({
        action: "signal_dispatched", target: signal.id,
        after: { gate: risk.gate, outcome: "block", reason: risk.reason, metrics: risk.metrics },
      });
      return { signalId: signal.id, status: "rejected", reason: risk.reason, gate: risk.gate };
    }

    // Pass — accepted. Phase 3 will pick these up for execution.
    trail.add("exposure_limit", "skip", "phase3_execution");
    trail.add("accepted", "info");
    await flushTrail(sb, signal.id, trail);
    await sb.from("signals").update({
      status: "accepted", processed_at: new Date().toISOString(),
      decision_reason: "gates_passed",
    }).eq("id", signal.id);
    await sb.from("audit_log").insert({
      action: "signal_dispatched", target: signal.id,
      after: {
        gate: "risk", outcome: "pass",
        action, symbol: signal.symbol, strategy: signal.strategy, tag: signal.tag,
        portion: signal.portion, mode,
        note: "phase2: execution stub; not sent to Bybit",
      },
    });
    return { signalId: signal.id, status: "accepted", reason: "gates_passed", gate: "risk" };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const stack = (e as Error).stack ?? null;
    const nextRetry = (signal.retry_count ?? 0) + 1;

    await sb.from("error_log").insert({
      source: "dispatcher", message: msg, stack,
      context: { signal_id: signal.id, retry_count: nextRetry },
    });

    if (nextRetry < MAX_RETRIES) {
      trail.add("error_retry", "info", msg, { retry_count: nextRetry });
      await flushTrail(sb, signal.id, trail);
      await sb.from("signals").update({
        status: "queued",
        retry_count: nextRetry,
      }).eq("id", signal.id);
      return { signalId: signal.id, status: "requeued", reason: msg };
    }

    trail.add("dead_letter", "fail", msg, { retry_count: nextRetry });
    await flushTrail(sb, signal.id, trail);
    await sb.from("signals").update({
      status: "dead_letter",
      retry_count: nextRetry,
      processed_at: new Date().toISOString(),
      decision_reason: `dead_letter:${msg.slice(0, 200)}`,
      error_stack: stack,
    }).eq("id", signal.id);
    await sb.from("audit_log").insert({
      action: "signal_dead_letter", target: signal.id,
      after: { error: msg, retry_count: nextRetry },
    });
    await sb.from("system_alerts").insert({
      severity: "critical", category: "dead_letter",
      message: `Signal moved to dead-letter: ${msg.slice(0, 160)}`,
      context: { signal_id: signal.id },
    });
    return { signalId: signal.id, status: "dead_letter", reason: msg };
  }
}
