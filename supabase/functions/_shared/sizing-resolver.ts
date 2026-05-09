// sizing-resolver — combines health snapshot + global rules + per-tuple
// overrides into the final sizing parameters used by the executor.
//
// Resolution order:
//   1. Load latest health_snapshot for (symbol, strategy, tag)
//   2. Load override row for same tuple
//   3. force_state=block → BLOCK (regardless of rules)
//   4. force_state=allow → skip rule evaluation (use overrides + symbol defaults)
//   5. Otherwise evaluate sizing_rules in priority order (ascending; lowest first):
//        - first matching {block:true} → BLOCK
//        - first matching {set:{...}}  → use as base sizing
//   6. Override columns (when set) overlay the rule/symbol base
//   7. Remaining nulls fall back to symbols-row defaults
//
// Returned `source` describes the provenance of each sized field so risk_decisions
// trail can show exactly why this size was used.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Snapshot = {
  winrate: number | null;
  profit_factor: number | null;
  net_profit: number | null;
  bar_time: string | null;
};

type RuleCondition = {
  all?: Array<{ metric: "winrate" | "profit_factor" | "net_profit"; op: ">" | ">=" | "<" | "<=" | "=="; value: number }>;
};

type RuleAction = { block?: boolean; set?: Partial<Record<"account_balance_percent" | "leverage" | "position_size_multiplier", number>> };

export interface ResolvedSizing {
  blocked: boolean;
  block_reason: string | null;
  account_balance_percent: number;
  leverage: number;
  position_size_multiplier: number;
  max_position_notional_usdt: number | null;
  max_margin_usage_usdt: number | null;
  source: {
    snapshot: Snapshot | null;
    matched_rule_id: string | null;
    matched_rule_label: string | null;
    override_used: boolean;
    field_origin: Record<string, "override" | "rule" | "symbol_default">;
  };
}

function evalCondition(cond: RuleCondition, snap: Snapshot | null): boolean {
  if (!cond.all || cond.all.length === 0) return false;
  if (!snap) return false;
  for (const c of cond.all) {
    const v = (snap as any)[c.metric];
    if (v == null || !Number.isFinite(Number(v))) return false;
    const n = Number(v);
    const t = Number(c.value);
    let ok = false;
    switch (c.op) {
      case ">": ok = n > t; break;
      case ">=": ok = n >= t; break;
      case "<": ok = n < t; break;
      case "<=": ok = n <= t; break;
      case "==": ok = n === t; break;
    }
    if (!ok) return false;
  }
  return true;
}

export async function resolveSizing(
  sb: SupabaseClient,
  ctx: { symbol: string; strategy: string; tag: string; symbolRow: any },
): Promise<ResolvedSizing> {
  const sym = ctx.symbolRow;
  const fieldOrigin: Record<string, "override" | "rule" | "symbol_default"> = {
    account_balance_percent: "symbol_default",
    leverage: "symbol_default",
    position_size_multiplier: "symbol_default",
    max_position_notional_usdt: "symbol_default",
    max_margin_usage_usdt: "symbol_default",
  };

  // 1. snapshot
  const { data: snapRow } = await sb
    .from("health_snapshots")
    .select("winrate,profit_factor,net_profit,bar_time")
    .eq("symbol", ctx.symbol)
    .eq("strategy", ctx.strategy)
    .eq("tag", ctx.tag ?? "")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const snap: Snapshot | null = snapRow ? {
    winrate: snapRow.winrate != null ? Number(snapRow.winrate) : null,
    profit_factor: snapRow.profit_factor != null ? Number(snapRow.profit_factor) : null,
    net_profit: snapRow.net_profit != null ? Number(snapRow.net_profit) : null,
    bar_time: snapRow.bar_time ?? null,
  } : null;

  // 2. override
  const { data: ovr } = await sb
    .from("symbol_strategy_overrides")
    .select("*")
    .eq("symbol", ctx.symbol)
    .eq("strategy", ctx.strategy)
    .eq("tag", ctx.tag ?? "")
    .maybeSingle();

  // 3. force block
  if (ovr?.force_state === "block") {
    return {
      blocked: true,
      block_reason: "override_force_block",
      account_balance_percent: Number(sym.account_balance_percent),
      leverage: Number(sym.leverage),
      position_size_multiplier: Number(sym.position_size_multiplier),
      max_position_notional_usdt: sym.max_position_notional_usdt,
      max_margin_usage_usdt: sym.max_margin_usage_usdt,
      source: { snapshot: snap, matched_rule_id: null, matched_rule_label: null, override_used: true, field_origin: fieldOrigin },
    };
  }

  // 4-5. evaluate rules unless force_allow
  let matchedRuleId: string | null = null;
  let matchedRuleLabel: string | null = null;
  let blockedByRule = false;
  let blockReason: string | null = null;
  let base: Partial<Record<string, number>> = {};

  if (ovr?.force_state !== "allow") {
    const { data: rules } = await sb
      .from("sizing_rules")
      .select("id,priority,enabled,label,condition,action")
      .eq("enabled", true)
      .order("priority", { ascending: true });

    for (const r of (rules ?? [])) {
      if (!evalCondition(r.condition as RuleCondition, snap)) continue;
      const action = (r.action ?? {}) as RuleAction;
      matchedRuleId = r.id;
      matchedRuleLabel = r.label;
      if (action.block === true) {
        blockedByRule = true;
        blockReason = `rule:${r.label}`;
        break;
      }
      if (action.set && typeof action.set === "object") {
        base = { ...action.set } as Record<string, number>;
        for (const k of Object.keys(base)) fieldOrigin[k] = "rule";
        break;
      }
    }
  }

  // 6. apply override field overlay (only set fields)
  const overlayKeys: Array<keyof typeof fieldOrigin> = [
    "account_balance_percent", "leverage", "position_size_multiplier",
    "max_position_notional_usdt", "max_margin_usage_usdt",
  ];
  if (ovr) {
    for (const k of overlayKeys) {
      if (ovr[k] != null) {
        base[k] = Number(ovr[k]);
        fieldOrigin[k] = "override";
      }
    }
  }

  // 7. fall back to symbols defaults
  const final = {
    account_balance_percent: base.account_balance_percent != null ? Number(base.account_balance_percent) : Number(sym.account_balance_percent),
    leverage: base.leverage != null ? Number(base.leverage) : Number(sym.leverage),
    position_size_multiplier: base.position_size_multiplier != null ? Number(base.position_size_multiplier) : Number(sym.position_size_multiplier),
    max_position_notional_usdt: base.max_position_notional_usdt != null ? Number(base.max_position_notional_usdt) : (sym.max_position_notional_usdt ?? null),
    max_margin_usage_usdt: base.max_margin_usage_usdt != null ? Number(base.max_margin_usage_usdt) : (sym.max_margin_usage_usdt ?? null),
  };

  return {
    blocked: blockedByRule,
    block_reason: blockReason,
    ...final,
    source: {
      snapshot: snap,
      matched_rule_id: matchedRuleId,
      matched_rule_label: matchedRuleLabel,
      override_used: !!ovr,
      field_origin: fieldOrigin,
    },
  };
}
