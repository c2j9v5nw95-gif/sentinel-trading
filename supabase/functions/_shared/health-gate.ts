// Health Gate — evaluates whether a trading signal should be allowed based on
// the latest HEALTH_ALL snapshot for the *symbol*, compared to thresholds set
// on the global HEALTH_ALL strategy row.
//
// Rationale: TradingView publishes per-symbol health as
// (symbol, strategy='HEALTH_ALL', tag=''), but entry signals come in as
// (symbol, strategy='ES1/EL1/XS1/XL1...', tag='STRAT2'). Looking up snapshot
// or thresholds by the entry signal's own tuple never matches anything, so
// the gate was effectively a no-op. We now always read the HEALTH_ALL row
// for the symbol regardless of the signal's strategy/tag.
//
// Outcomes:
//   pass=true  reason="ok"                     all configured thresholds met
//   pass=true  reason="no_thresholds"          HEALTH_ALL has no thresholds
//   pass=true  reason="no_health_data"         no snapshot yet (don't block
//                                              first alert; surfaced as warning)
//   pass=false reason="<metric>_below_threshold"
//   pass=false reason="health_strategy_disabled"  HEALTH_ALL row disabled
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

const HEALTH_STRATEGY = "HEALTH_ALL";
const HEALTH_TAG = "";

export async function evaluateHealth(
  sb: SupabaseClient,
  inp: HealthInput,
): Promise<HealthDecision> {
  const { data: strat } = await sb
    .from("strategies")
    .select("enabled,health_min_winrate,health_min_profit_factor,health_min_net_profit")
    .eq("name", HEALTH_STRATEGY)
    .eq("tag", HEALTH_TAG)
    .maybeSingle();

  if (strat && strat.enabled === false) {
    return {
      pass: false,
      reason: "health_strategy_disabled",
      metrics: { symbol: inp.symbol, applied_strategy: HEALTH_STRATEGY },
    };
  }

  const minWr = strat?.health_min_winrate != null ? Number(strat.health_min_winrate) : null;
  const minPf = strat?.health_min_profit_factor != null ? Number(strat.health_min_profit_factor) : null;
  const minNp = strat?.health_min_net_profit != null ? Number(strat.health_min_net_profit) : null;

  if (minWr == null && minPf == null && minNp == null) {
    return {
      pass: true,
      reason: "no_thresholds",
      metrics: { symbol: inp.symbol, applied_strategy: HEALTH_STRATEGY },
    };
  }

  const { data: snap } = await sb
    .from("health_snapshots")
    .select("net_profit,winrate,profit_factor,bar_time,created_at")
    .eq("symbol", inp.symbol)
    .eq("strategy", HEALTH_STRATEGY)
    .eq("tag", HEALTH_TAG)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!snap) {
    return {
      pass: true,
      reason: "no_health_data",
      metrics: {
        symbol: inp.symbol,
        applied_strategy: HEALTH_STRATEGY,
        signal_strategy: inp.strategy,
        signal_tag: inp.tag,
        thresholds: { minWr, minPf, minNp },
      },
    };
  }

  // Staleness gate: if the latest HEALTH_ALL snapshot is older than 120 min,
  // block new entries. The TV alert may have been disabled or is failing —
  // we should not trade on stale health data.
  const STALE_MINUTES = 120;
  const ageMs = Date.now() - new Date(snap.created_at).getTime();
  if (ageMs > STALE_MINUTES * 60 * 1000) {
    return {
      pass: false,
      reason: "health_stale",
      metrics: {
        symbol: inp.symbol,
        applied_strategy: HEALTH_STRATEGY,
        signal_strategy: inp.strategy,
        signal_tag: inp.tag,
        snapshot_age_minutes: Math.round(ageMs / 60000),
        stale_threshold_minutes: STALE_MINUTES,
        last_snapshot_at: snap.created_at,
      },
    };
  }

  const wr = snap.winrate != null ? Number(snap.winrate) : null;
  const pf = snap.profit_factor != null ? Number(snap.profit_factor) : null;
  const np = snap.net_profit != null ? Number(snap.net_profit) : null;

  const metrics = {
    symbol: inp.symbol,
    applied_strategy: HEALTH_STRATEGY,
    signal_strategy: inp.strategy,
    signal_tag: inp.tag,
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
