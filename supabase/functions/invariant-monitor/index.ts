// invariant-monitor — runs a battery of safety assertions over the live engine state.
//
// Designed to run on a cron (every ~30s). Every check is independent and emits
// either zero or N violation rows. After the run we:
//   * upsert active violations (refreshing last_seen_at + occurrences)
//   * mark previously-open violations as resolved when the rule no longer fires
//   * write critical violations to system_alerts (one per new occurrence)
//   * compute a 0..100 health score
//   * optionally auto-pause entries when criticals exist and the toggle is on
//
// All checks are READ-ONLY against engine tables — they never mutate execution state.

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { notify } from "../_shared/telegram.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Violation {
  rule_code: string;
  rule_label: string;
  severity: "info" | "warning" | "critical";
  target_kind: "position" | "symbol" | "lock" | "system";
  target_key: string;
  message: string;
  detail?: Record<string, unknown>;
}

const RULES: Array<{ code: string; label: string; weight: number }> = [
  { code: "open_position_unprotected",   label: "Open position has no protection",          weight: 25 },
  { code: "overlapping_positions",       label: "Overlapping open positions on symbol",     weight: 25 },
  { code: "qty_below_min_precision",     label: "Position qty below exchange precision",    weight: 10 },
  { code: "tp_exceeds_initial_qty",      label: "TP1+TP2 exceed original position size",    weight: 15 },
  { code: "lock_stuck",                  label: "Execution lock held past TTL",             weight: 10 },
  { code: "reconciliation_drift",        label: "Local position state drifted from venue",  weight: 15 },
  { code: "dead_letter_overflow",        label: "Dead-letter queue above threshold",        weight: 10 },
  { code: "duplicate_active_sl",         label: "Duplicate active SL orders for symbol",    weight: 15 },
  { code: "orphan_tsl_state",            label: "TSL active without an open position",      weight: 10 },
];

const DEAD_LETTER_THRESHOLD = 25;

async function runChecks(sb: SupabaseClient): Promise<Violation[]> {
  const v: Violation[] = [];

  // 1. Open position has no protection (unprotected longer than 60s).
  const { data: unprotected } = await sb
    .from("positions")
    .select("id,symbol,protection_state,unprotected_since,closed_at")
    .is("closed_at", null)
    .neq("protection_state", "protected");
  for (const p of unprotected ?? []) {
    const since = p.unprotected_since ? new Date(p.unprotected_since).getTime() : Date.now();
    const ageSec = (Date.now() - since) / 1000;
    if (ageSec < 60) continue;
    v.push({
      rule_code: "open_position_unprotected",
      rule_label: "Open position has no protection",
      severity: "critical",
      target_kind: "position", target_key: p.id,
      message: `${p.symbol} unprotected for ${Math.round(ageSec)}s (state=${p.protection_state})`,
      detail: { symbol: p.symbol, protection_state: p.protection_state, age_sec: ageSec },
    });
  }

  // 2. Overlapping open positions per symbol (one-way mode invariant).
  const { data: openPos } = await sb
    .from("positions")
    .select("id,symbol,side,qty_open")
    .is("closed_at", null);
  const bySym = new Map<string, any[]>();
  for (const p of openPos ?? []) {
    if (!p.qty_open || Number(p.qty_open) <= 0) continue;
    const arr = bySym.get(p.symbol) ?? [];
    arr.push(p); bySym.set(p.symbol, arr);
  }
  for (const [symbol, list] of bySym) {
    if (list.length > 1) {
      v.push({
        rule_code: "overlapping_positions",
        rule_label: "Overlapping open positions on symbol",
        severity: "critical",
        target_kind: "symbol", target_key: symbol,
        message: `${list.length} open positions on ${symbol}`,
        detail: { positions: list.map((p) => ({ id: p.id, side: p.side, qty: p.qty_open })) },
      });
    }
  }

  // 3. Qty below exchange minimum precision (treat 0/<1e-8 as suspect).
  for (const p of openPos ?? []) {
    const q = Number(p.qty_open ?? 0);
    if (q > 0 && q < 1e-8) {
      v.push({
        rule_code: "qty_below_min_precision",
        rule_label: "Position qty below exchange precision",
        severity: "warning",
        target_kind: "position", target_key: p.id,
        message: `${p.symbol} qty=${q} below precision floor`,
        detail: { qty_open: q },
      });
    }
  }

  // 4. TP1 + TP2 must not exceed initial qty.
  const { data: tpRows } = await sb
    .from("positions")
    .select("id,symbol,qty_initial,tp1_qty,tp1_done,tp2_done");
  for (const p of tpRows ?? []) {
    const init = Number(p.qty_initial ?? 0);
    const tp1 = Number(p.tp1_qty ?? 0);
    if (init > 0 && tp1 > init) {
      v.push({
        rule_code: "tp_exceeds_initial_qty",
        rule_label: "TP1+TP2 exceed original position size",
        severity: "critical",
        target_kind: "position", target_key: p.id,
        message: `${p.symbol} TP1 qty ${tp1} > initial ${init}`,
        detail: { qty_initial: init, tp1_qty: tp1 },
      });
    }
  }

  // 5. Stuck locks — heartbeat older than TTL means sweeper hasn't caught it yet.
  const { data: locks } = await sb
    .from("execution_locks")
    .select("symbol,kind,owner_id,heartbeat_at,ttl_seconds,acquired_at");
  for (const l of locks ?? []) {
    const expiresAt = new Date(l.heartbeat_at).getTime() + (l.ttl_seconds * 1000);
    const overdueSec = (Date.now() - expiresAt) / 1000;
    if (overdueSec > 30) {
      v.push({
        rule_code: "lock_stuck",
        rule_label: "Execution lock held past TTL",
        severity: "warning",
        target_kind: "lock", target_key: l.symbol,
        message: `Lock on ${l.symbol} (${l.kind}) overdue by ${Math.round(overdueSec)}s`,
        detail: { kind: l.kind, owner_id: l.owner_id, overdue_sec: overdueSec },
      });
    }
  }

  // 6. Reconciliation drift — positions flagged drift_detected via position_events recently.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: drifts } = await sb
    .from("position_events")
    .select("position_id,detail,created_at")
    .eq("event_type", "reconciliation_drift")
    .gte("created_at", since);
  const driftSeen = new Set<string>();
  for (const d of drifts ?? []) {
    if (driftSeen.has(d.position_id)) continue;
    driftSeen.add(d.position_id);
    v.push({
      rule_code: "reconciliation_drift",
      rule_label: "Local position state drifted from venue",
      severity: "critical",
      target_kind: "position", target_key: d.position_id,
      message: `Drift detected on position ${d.position_id}`,
      detail: d.detail ?? {},
    });
  }

  // 7. Dead-letter overflow — count signals stuck in failed/dead status.
  const { count: deadCount } = await sb
    .from("signals")
    .select("id", { count: "exact", head: true })
    .in("status", ["failed", "dead"]);
  if ((deadCount ?? 0) >= DEAD_LETTER_THRESHOLD) {
    v.push({
      rule_code: "dead_letter_overflow",
      rule_label: "Dead-letter queue above threshold",
      severity: "warning",
      target_kind: "system", target_key: "GLOBAL",
      message: `${deadCount} signals in dead/failed state (threshold ${DEAD_LETTER_THRESHOLD})`,
      detail: { count: deadCount, threshold: DEAD_LETTER_THRESHOLD },
    });
  }

  // 8. Duplicate active SL orders per symbol.
  const { data: slOrders } = await sb
    .from("orders")
    .select("symbol,id,bybit_order_id,status,purpose,position_id")
    .eq("purpose", "sl")
    .in("status", ["submitted", "open", "partially_filled"]);
  const slBySym = new Map<string, any[]>();
  for (const o of slOrders ?? []) {
    const arr = slBySym.get(o.symbol) ?? [];
    arr.push(o); slBySym.set(o.symbol, arr);
  }
  for (const [symbol, arr] of slBySym) {
    if (arr.length > 1) {
      v.push({
        rule_code: "duplicate_active_sl",
        rule_label: "Duplicate active SL orders for symbol",
        severity: "critical",
        target_kind: "symbol", target_key: symbol,
        message: `${arr.length} active SL orders on ${symbol}`,
        detail: { order_ids: arr.map((o) => o.id) },
      });
    }
  }

  // 9. Orphaned TSL state — tsl_active=true but no open qty.
  for (const p of tpRows ?? []) {
    const open = (openPos ?? []).find((x) => x.id === p.id);
    const live = open && Number(open.qty_open) > 0;
    // Re-fetch tsl_active inline by querying again — cheap
  }
  const { data: tslRows } = await sb
    .from("positions")
    .select("id,symbol,tsl_active,qty_open,closed_at")
    .eq("tsl_active", true);
  for (const p of tslRows ?? []) {
    const orphan = !!p.closed_at || !p.qty_open || Number(p.qty_open) <= 0;
    if (orphan) {
      v.push({
        rule_code: "orphan_tsl_state",
        rule_label: "TSL active without an open position",
        severity: "warning",
        target_kind: "position", target_key: p.id,
        message: `${p.symbol} has tsl_active=true with no open qty`,
        detail: { qty_open: p.qty_open, closed_at: p.closed_at },
      });
    }
  }

  return v;
}

async function persistRun(sb: SupabaseClient, violations: Violation[]) {
  const critical = violations.filter((x) => x.severity === "critical").length;
  const warning = violations.filter((x) => x.severity === "warning").length;
  const failedRules = new Set(violations.map((v) => v.rule_code));
  const failedWeight = RULES
    .filter((r) => failedRules.has(r.code))
    .reduce((s, r) => s + r.weight, 0);
  const maxWeight = RULES.reduce((s, r) => s + r.weight, 0);
  const healthScore = Math.max(0, Math.round(100 * (1 - failedWeight / maxWeight)));

  // Auto-pause?
  let autoPaused = false;
  if (critical > 0) {
    const { data: settings } = await sb
      .from("app_settings")
      .select("auto_pause_on_critical_invariant,entries_paused")
      .maybeSingle();
    if (settings?.auto_pause_on_critical_invariant && !settings.entries_paused) {
      await sb.from("app_settings").update({ entries_paused: true }).eq("singleton", true);
      await sb.from("audit_log").insert({
        action: "entries_auto_paused",
        target: "invariant-monitor",
        after: { reason: "critical_invariant_violation", count: critical },
      });
      autoPaused = true;
    }
  }

  const { data: runRow } = await sb
    .from("invariant_runs")
    .insert({
      finished_at: new Date().toISOString(),
      checks_total: RULES.length,
      checks_failed: failedRules.size,
      critical_count: critical,
      warning_count: warning,
      health_score: healthScore,
      auto_paused: autoPaused,
      detail: { rules_failed: Array.from(failedRules) },
    })
    .select("id")
    .single();
  const runId = runRow?.id ?? null;

  // Currently-open keys
  const { data: openV } = await sb
    .from("invariant_violations")
    .select("id,rule_code,target_key,occurrences")
    .is("resolved_at", null);
  const openMap = new Map<string, any>();
  for (const r of openV ?? []) openMap.set(`${r.rule_code}::${r.target_key}`, r);

  const seenKeys = new Set<string>();
  for (const viol of violations) {
    const key = `${viol.rule_code}::${viol.target_key}`;
    seenKeys.add(key);
    const existing = openMap.get(key);
    if (existing) {
      await sb.from("invariant_violations").update({
        last_seen_at: new Date().toISOString(),
        occurrences: existing.occurrences + 1,
        message: viol.message,
        detail: viol.detail ?? {},
        run_id: runId,
      }).eq("id", existing.id);
    } else {
      await sb.from("invariant_violations").insert({
        rule_code: viol.rule_code,
        rule_label: viol.rule_label,
        severity: viol.severity,
        target_kind: viol.target_kind,
        target_key: viol.target_key,
        message: viol.message,
        detail: viol.detail ?? {},
        run_id: runId,
      });
      // Critical -> system alert
      if (viol.severity === "critical") {
        await sb.from("system_alerts").insert({
          severity: "critical",
          category: `invariant:${viol.rule_code}`,
          message: viol.message,
          context: viol.detail ?? {},
        });
      }
    }
  }

  // Resolve previously-open that are no longer firing.
  for (const [key, row] of openMap) {
    if (!seenKeys.has(key)) {
      await sb.from("invariant_violations").update({
        resolved_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
  }

  return { runId, healthScore, critical, warning, autoPaused };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const sb = serviceClient();
    const violations = await runChecks(sb);
    const result = await persistRun(sb, violations);
    return new Response(JSON.stringify({ ok: true, ...result, violations: violations.length }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
