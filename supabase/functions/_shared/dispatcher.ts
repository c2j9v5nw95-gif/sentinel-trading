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
//   - trade execution fails fast; stale entries must not sit queued and execute late
//   - unexpected failures are marked error with full trail + error_log context
//
// Trail is appended at every step and flushed before return (always).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { evaluateHealth } from "./health-gate.ts";
import { evaluateRisk, recordDecision } from "./risk-engine.ts";
import { resolveStrategyCode, isExit, isEntry, type SignalAction } from "./strategy-map.ts";
import { Trail, flushTrail } from "./trail.ts";
import { resolveExecutionMode } from "./execution-mode.ts";
import { LIVE_GATE_WORKER_VERSION, liveExecutionGate } from "./live-client.ts";
import { withSymbolLock } from "./locks.ts";
import { executeEntry, executeExit } from "./executor.ts";
import { BybitTransportError } from "./bybit-rest.ts";
import { notify } from "./telegram.ts";

const MAX_ENTRY_SIGNAL_AGE_MS = 30_000;

export interface DispatchResult {
  signalId: string;
  status: "processed" | "accepted" | "rejected" | "skipped" | "error" | "dead_letter" | "requeued";
  reason?: string;
  gate?: string;
}

function signalAgeMs(signal: any): number {
  const ts = Date.parse(signal.received_at ?? signal.created_at ?? "");
  return Number.isFinite(ts) ? Date.now() - ts : 0;
}

function isExecutorError(reason?: string): boolean {
  return !!reason && (
    reason === "client_init_failed" ||
    reason.startsWith("order_submit_failed:") ||
    reason.startsWith("entry_fill_failed:") ||
    reason.startsWith("exit_fill_failed:") ||
    reason === "sl_unconfirmed_auto_closed" ||
    reason === "drift_no_local_row"
  );
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
    net_profit: num(payload.net_profit ?? payload.netProfit),
    winrate: num(payload.winrate),
    profit_factor: num(payload.profit_factor ?? payload.profitFactor),
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
  trail.add("queued", "info");
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

    if (action && isEntry(action)) {
      const ageMs = signalAgeMs(signal);
      if (ageMs > MAX_ENTRY_SIGNAL_AGE_MS) {
        const reason = `entry_stale:${Math.round(ageMs / 1000)}s`;
        trail.add("entry_stale", "fail", reason, { age_ms: ageMs, max_age_ms: MAX_ENTRY_SIGNAL_AGE_MS });
        await flushTrail(sb, signal.id, trail);
        await sb.from("signals").update({
          status: "error",
          processed_at: new Date().toISOString(),
          decision_reason: reason,
        }).eq("id", signal.id);
        await sb.from("error_log").insert({
          source: "dispatcher", message: "entry_stale_no_retry",
          context: { signal_id: signal.id, symbol: signal.symbol, action, age_ms: ageMs },
        });
        return { signalId: signal.id, status: "error", reason, gate: "execution" };
      }
    }

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

    // Pass — accepted. Run execution under symbol lock.
    const resolved = await resolveExecutionMode(sb, signal.symbol);
    trail.add("mode_resolved", "info", resolved.source, { mode: resolved.mode });

    // Live execution gate — must pass before instantiating LiveBybitClient.
    let liveGatePassed = false;
    if (resolved.mode === "live") {
      console.log(JSON.stringify({
        evt: "executor_live_gate_start",
        worker_version: LIVE_GATE_WORKER_VERSION,
        signal_id: signal.id,
        symbol: signal.symbol,
        mode: resolved.mode,
        action,
      }));
      const gateReason = await liveExecutionGate(sb, { symbol: signal.symbol, signalId: signal.id });
      if (gateReason) {
        trail.add("live_gate_blocked", "fail", gateReason);
        await flushTrail(sb, signal.id, trail);
        await recordDecision(sb, signal.id, {
          outcome: "block", gate: "risk", reason: `live_gate:${gateReason}`, metrics: {},
        });
        await sb.from("signals").update({
          status: "rejected", processed_at: new Date().toISOString(),
          decision_reason: `live_gate:${gateReason}`,
        }).eq("id", signal.id);
        await sb.from("audit_log").insert({
          action: "signal_dispatched", target: signal.id,
          after: { gate: "live_gate", outcome: "block", reason: gateReason },
        });
        return { signalId: signal.id, status: "rejected", reason: gateReason, gate: "live_gate" };
      }
      trail.add("live_gate_passed", "pass");
      liveGatePassed = true;
    }

    trail.add("accepted", "info");

    const lockKind = exitMode ? "exit" : "entry";
    const locked = await withSymbolLock(sb, signal.symbol, lockKind,
      { signalId: signal.id, allowPreempt: exitMode },
      async () => {
        return exitMode
          ? await executeExit(sb, signal, resolved.mode, trail, { liveGatePassed })
          : await executeEntry(sb, signal, resolved.mode, trail, { liveGatePassed });
      });

    if (!locked.ok && locked.reason === "symbol_busy") {
      trail.add("lock_busy", "fail", "symbol_in_use", locked.details as unknown as Record<string, unknown>);
      await flushTrail(sb, signal.id, trail);
      await sb.from("signals").update({
        status: "error",
        processed_at: new Date().toISOString(),
        decision_reason: "symbol_busy_no_retry",
      }).eq("id", signal.id);
      return { signalId: signal.id, status: "error", reason: "symbol_busy", gate: "execution" };
    }
    if (!locked.ok) throw new Error(`exec_error:${locked.details}`);

    const exec = locked.value;
    const executorError = isExecutorError(exec.reason);
    const finalStatus = exec.ok ? "processed" : executorError ? "error" : "rejected";
    trail.add(exec.ok ? "executed" : "exec_failed",
      exec.ok ? "pass" : "fail", exec.reason,
      { position_id: exec.position_id, fill_price: exec.fill_price, qty: exec.filled_qty });
    if (executorError) {
      await sb.from("error_log").insert({
        source: "executor", message: exec.reason ?? "executor_error",
        context: { signal_id: signal.id, symbol: signal.symbol, mode: resolved.mode, action },
      });
    }
    await flushTrail(sb, signal.id, trail);
    await sb.from("signals").update({
      status: finalStatus, processed_at: new Date().toISOString(),
      decision_reason: exec.ok
        ? `executed:${resolved.mode}`
        : executorError
          ? (exec.reason ?? "executor_error")
        : `exec_rejected:${exec.reason ?? "unknown"}`,
    }).eq("id", signal.id);
    await sb.from("audit_log").insert({
      action: "signal_executed", target: signal.id,
      after: {
        action, symbol: signal.symbol, mode: resolved.mode, lock_kind: lockKind,
        ok: exec.ok, reason: exec.reason, position_id: exec.position_id,
        fill_price: exec.fill_price, filled_qty: exec.filled_qty,
        protection_state: exec.protection_state,
      },
    });
    return {
      signalId: signal.id,
      status: exec.ok ? "accepted" : "rejected",
      reason: exec.reason ?? (exec.ok ? "executed" : "exec_failed"),
      gate: "execution",
    };
  } catch (e) {
    const stack = (e as Error).stack ?? null;

    // Transport-level failures (Cloudflare/WAF block, non-JSON body) get
    // a structured decision_reason + Telegram critical alert + diagnostics
    // so operators can see exactly why and where the request was blocked.
    if (e instanceof BybitTransportError) {
      const d = e.diagnostics;
      const reason = `bybit_transport_${e.kind}:${d.endpoint}`;
      const ctx = {
        signal_id: signal.id, symbol: signal.symbol, action: signal.action,
        kind: e.kind, diagnostics: d, fail_fast: true,
      };
      await sb.from("error_log").insert({
        source: "dispatcher.bybit_transport", message: e.message, stack, context: ctx,
      });
      await sb.from("system_alerts").insert({
        severity: "critical", category: "bybit_transport_block",
        message: `Bybit ${e.kind.toUpperCase()} on ${d.endpoint} (HTTP ${d.http_status})`,
        context: ctx,
      });
      notify({
        severity: "critical", category: "bybit_diagnostic_failure",
        execution_mode: "live", symbol: signal.symbol ?? null,
        reason: `bybit_transport_${e.kind}: HTTP ${d.http_status} on ${d.endpoint}`,
        extra: {
          base_url: d.base_url,
          cf_ray: d.cf_ray, server: d.server,
          content_type: d.content_type, request_id: d.request_id,
          body_snippet: d.body_snippet,
          hint: e.kind === "forbidden"
            ? "Cloudflare/WAF/egress IP block — NOT an API-key issue. Try BYBIT_API_BASE_URL=https://api.bytick.com or use a proxy."
            : "Non-JSON response from Bybit endpoint. See body_snippet.",
        },
      });
      trail.add("bybit_transport_error", "fail", reason, ctx as Record<string, unknown>);
      await flushTrail(sb, signal.id, trail);
      await sb.from("signals").update({
        status: "error", processed_at: new Date().toISOString(),
        decision_reason: reason, error_stack: stack,
      }).eq("id", signal.id);
      await sb.from("audit_log").insert({
        action: "signal_execution_error", target: signal.id,
        after: { error: reason, kind: e.kind, diagnostics: d, fail_fast: true },
      });
      return { signalId: signal.id, status: "error", reason, gate: "execution" };
    }

    const msg = (e as Error).message ?? String(e);
    await sb.from("error_log").insert({
      source: "dispatcher", message: msg, stack,
      context: { signal_id: signal.id, retry_count: signal.retry_count ?? 0, fail_fast: true },
    });

    trail.add("execution_error", "fail", msg, { retry_count: signal.retry_count ?? 0, fail_fast: true });
    await flushTrail(sb, signal.id, trail);
    await sb.from("signals").update({
      status: "error",
      processed_at: new Date().toISOString(),
      decision_reason: `execution_error:${msg.slice(0, 200)}`,
      error_stack: stack,
    }).eq("id", signal.id);
    await sb.from("audit_log").insert({
      action: "signal_execution_error", target: signal.id,
      after: { error: msg, retry_count: signal.retry_count ?? 0, fail_fast: true },
    });
    return { signalId: signal.id, status: "error", reason: msg, gate: "execution" };
  }
}
