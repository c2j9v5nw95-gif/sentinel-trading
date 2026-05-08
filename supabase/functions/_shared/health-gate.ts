// Health Gate — evaluates whether a trading signal's strategy is currently
// "healthy" enough to act on, based on the latest health_snapshot for the
// (symbol, strategy, tag) tuple compared to thresholds on the strategies row.
//
// Outcomes:
//   pass=true  reason="ok"                     all configured thresholds met
//   pass=true  reason="no_thresholds"          strategy has no thresholds set
//   pass=true  reason="no_health_data"         no snapshot yet (don't block first
//                                              alert; surfaced as warning)
//   pass=false reason="<metric>_below_threshold"
//   pass=false reason="strategy_disabled"      strategy row exists but enabled=false
//
// HEALTH-type signals never enter this gate (they ARE the data feeding it).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface HealthInput {
  symbol: string;
  strategy: string;
  tag: string;
}

export interface HealthDecision {
  pass: boolean;
  reason: string;
  metrics: Record<string, unknown>;
}

export async function evaluateHealth(
  sb: SupabaseClient,
  inp: HealthInput,
): Promise<HealthDecision> {
  const { data: strat } = await sb
    .from("strategies")
    .select("enabled,health_min_winrate,health_min_profit_factor,health_min_net_profit")
    .eq("name", inp.strategy)
    .eq("tag", inp.tag ?? "")
    .maybeSingle();

  if (strat && strat.enabled === false) {
    return { pass: false, reason: "strategy_disabled", metrics: { strategy: inp.strategy, tag: inp.tag } };
  }

  const minWr = strat?.health_min_winrate != null ? Number(strat.health_min_winrate) : null;
  const minPf = strat?.health_min_profit_factor != null ? Number(strat.health_min_profit_factor) : null;
  const minNp = strat?.health_min_net_profit != null ? Number(strat.health_min_net_profit) : null;

  if (minWr == null && minPf == null && minNp == null) {
    return { pass: true, reason: "no_thresholds", metrics: {} };
  }

  const { data: snap } = await sb
    .from("health_snapshots")
    .select("net_profit,winrate,profit_factor,bar_time,created_at")
    .eq("symbol", inp.symbol)
    .eq("strategy", inp.strategy)
    .eq("tag", inp.tag ?? "")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!snap) {
    return {
      pass: true,
      reason: "no_health_data",
      metrics: { thresholds: { minWr, minPf, minNp } },
    };
  }

  const wr = snap.winrate != null ? Number(snap.winrate) : null;
  const pf = snap.profit_factor != null ? Number(snap.profit_factor) : null;
  const np = snap.net_profit != null ? Number(snap.net_profit) : null;

  const metrics = {
    snapshot: { winrate: wr, profit_factor: pf, net_profit: np, bar_time: snap.bar_time },
    thresholds: { minWr, minPf, minNp },
  };

  if (minWr != null && (wr == null || wr < minWr))
    return { pass: false, reason: "winrate_below_threshold", metrics };
  if (minPf != null && (pf == null || pf < minPf))
    return { pass: false, reason: "profit_factor_below_threshold", metrics };
  if (minNp != null && (np == null || np < minNp))
    return { pass: false, reason: "net_profit_below_threshold", metrics };

  return { pass: true, reason: "ok", metrics };
}
