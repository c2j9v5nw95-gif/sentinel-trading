// Shared client-side sizing evaluator. Mirrors supabase/functions/_shared/sizing-resolver.ts
// for display purposes only — the server is still the source of truth for live executions.

export type EvalSnap = {
  symbol: string;
  strategy: string;
  tag: string;
  winrate: number | null;
  profit_factor: number | null;
  net_profit: number | null;
};

export type EvalRule = {
  id: string;
  priority: number;
  enabled: boolean;
  label: string;
  condition: { all?: Array<{ metric: string; op: string; value: number }> };
  action: { block?: boolean; set?: Record<string, number> };
};

export type EvalResult = {
  blocked: boolean;
  balance_pct: number | null;
  leverage: number | null;
  source: string;
};

export function matches(cond: EvalRule["condition"], snap: EvalSnap | null): boolean {
  if (!cond?.all?.length) return false;
  if (!snap) return false;
  for (const c of cond.all) {
    const v = (snap as any)[c.metric];
    if (v == null) return false;
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

export function evaluateClient(
  snap: EvalSnap | null,
  sym: any,
  ov: any,
  rules: EvalRule[],
): EvalResult {
  if (!sym) return { blocked: false, balance_pct: null, leverage: null, source: "no symbol" };
  if (ov?.force_state === "block") {
    return { blocked: true, balance_pct: null, leverage: null, source: "override:block" };
  }
  let base: any = {};
  let source = "default";
  if (ov?.force_state !== "allow") {
    for (const r of rules) {
      if (!matches(r.condition, snap)) continue;
      if (r.action?.block) {
        return { blocked: true, balance_pct: null, leverage: null, source: `rule:${r.label}` };
      }
      if (r.action?.set) {
        base = { ...r.action.set };
        source = `rule:${r.label}`;
        break;
      }
    }
  } else {
    source = "override:allow";
  }
  const overlay = (k: string) => (ov?.[k] != null ? Number(ov[k]) : (base[k] ?? Number(sym[k])));
  return {
    blocked: false,
    balance_pct: overlay("account_balance_percent"),
    leverage: overlay("leverage"),
    source: ov && (ov.account_balance_percent != null || ov.leverage != null) ? `override:${sym.symbol}` : source,
  };
}
