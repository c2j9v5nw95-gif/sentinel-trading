import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/_app/performance")({
  component: PerformancePage,
});

type Snap = {
  symbol: string;
  strategy: string;
  tag: string;
  winrate: number | null;
  profit_factor: number | null;
  net_profit: number | null;
  bar_time: string | null;
  created_at: string;
};

type SymbolRow = Record<string, any>;
type Override = Record<string, any>;

type Rule = {
  id: string;
  priority: number;
  enabled: boolean;
  label: string;
  condition: { all?: Array<{ metric: string; op: string; value: number }> };
  action: { block?: boolean; set?: Record<string, number> };
};

function PerformancePage() {
  const [tab, setTab] = useState<"symbols" | "rules">("symbols");
  return (
    <>
      <PageHeader
        title="Performance"
        description="Helsemålinger fra TradingView, regelbasert sizing og per-coin overstyringer."
      />
      <div className="mb-4 flex gap-2">
        <TabBtn active={tab === "symbols"} onClick={() => setTab("symbols")}>Symbols</TabBtn>
        <TabBtn active={tab === "rules"} onClick={() => setTab("rules")}>Sizing rules</TabBtn>
      </div>
      {tab === "symbols" ? <SymbolsTab /> : <RulesTab />}
    </>
  );
}

function TabBtn({ active, onClick, children }: any) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/40"
      }`}
    >
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------
// Symbols tab — health snapshots × symbols × overrides + rule preview
// --------------------------------------------------------------------------

function SymbolsTab() {
  const { data: snaps } = useQuery({
    queryKey: ["health-latest"],
    queryFn: async () => {
      const { data } = await supabase
        .from("health_snapshots")
        .select("symbol,strategy,tag,winrate,profit_factor,net_profit,bar_time,created_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      const seen = new Set<string>();
      const latest: Snap[] = [];
      for (const r of (data ?? []) as Snap[]) {
        const k = `${r.symbol}|${r.strategy}|${r.tag ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        latest.push(r);
      }
      return latest;
    },
  });
  const { data: symbols } = useQuery({
    queryKey: ["symbols-perf"],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("*");
      return (data ?? []) as SymbolRow[];
    },
  });
  const { data: overrides } = useQuery({
    queryKey: ["overrides"],
    queryFn: async () => {
      const { data } = await supabase.from("symbol_strategy_overrides").select("*");
      return (data ?? []) as Override[];
    },
  });
  const { data: rules } = useQuery({
    queryKey: ["sizing-rules"],
    queryFn: async () => {
      const { data } = await supabase
        .from("sizing_rules")
        .select("*")
        .eq("enabled", true)
        .order("priority", { ascending: true });
      return (data ?? []) as Rule[];
    },
  });

  const [editing, setEditing] = useState<Snap | null>(null);

  const rows = useMemo(() => {
    if (!snaps || !symbols) return [];
    const symMap = new Map(symbols.map((s) => [s.symbol, s]));
    const ovMap = new Map(
      (overrides ?? []).map((o) => [`${o.symbol}|${o.strategy}|${o.tag ?? ""}`, o]),
    );
    return snaps.map((s) => {
      const sym = symMap.get(s.symbol);
      const ov = ovMap.get(`${s.symbol}|${s.strategy}|${s.tag ?? ""}`);
      const eval_ = evaluateClient(s, sym, ov, rules ?? []);
      return { snap: s, sym, ov, eval: eval_ };
    });
  }, [snaps, symbols, overrides, rules]);

  return (
    <Card>
      {rows.length === 0 ? (
        <EmptyState
          title="Ingen health-snapshots ennå"
          hint="TradingView-strategier som sender HEALTH-alerts vil vises her."
        />
      ) : (
        <table className="w-full text-sm tabular">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-2">Symbol</th>
              <th>Strategy / tag</th>
              <th className="text-right">Winrate</th>
              <th className="text-right">PF</th>
              <th className="text-right">Net profit</th>
              <th className="text-right">% equity</th>
              <th className="text-right">Lev</th>
              <th>Status</th>
              <th>Kilde</th>
              <th>Sist</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={`${r.snap.symbol}|${r.snap.strategy}|${r.snap.tag}`}>
                <td className="py-2 font-medium">{r.snap.symbol}</td>
                <td className="text-xs text-muted-foreground">
                  {r.snap.strategy}{r.snap.tag ? ` / ${r.snap.tag}` : ""}
                </td>
                <td className="text-right">{fmtNum(r.snap.winrate, 1)}{r.snap.winrate != null ? "%" : ""}</td>
                <td className="text-right">{fmtNum(r.snap.profit_factor, 2)}</td>
                <td className={`text-right ${r.snap.net_profit != null && r.snap.net_profit < 0 ? "text-destructive" : ""}`}>
                  {fmtNum(r.snap.net_profit, 2)}
                </td>
                <td className="text-right">{fmtNum(r.eval.balance_pct, 1)}</td>
                <td className="text-right">{fmtNum(r.eval.leverage, 0)}x</td>
                <td>
                  {r.eval.blocked ? (
                    <span className="rounded bg-destructive/20 px-2 py-0.5 text-xs text-destructive">BLOCKED</span>
                  ) : r.snap == null ? (
                    <span className="rounded bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-600">no data</span>
                  ) : (
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-600">trades</span>
                  )}
                </td>
                <td className="text-xs text-muted-foreground">{r.eval.source}</td>
                <td className="text-xs text-muted-foreground">
                  {r.snap.bar_time ? new Date(r.snap.bar_time).toLocaleString() : "—"}
                </td>
                <td className="text-right">
                  <button
                    className="rounded border border-border px-2 py-1 text-xs hover:bg-accent/40"
                    onClick={() => setEditing(r.snap)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <OverrideDrawer
          snap={editing}
          symbol={symbols?.find((s) => s.symbol === editing.symbol)}
          override={overrides?.find(
            (o) => o.symbol === editing.symbol && o.strategy === editing.strategy && (o.tag ?? "") === (editing.tag ?? ""),
          )}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function evaluateClient(snap: Snap, sym: any, ov: any, rules: Rule[]) {
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

function matches(cond: Rule["condition"], snap: Snap): boolean {
  if (!cond?.all?.length) return false;
  for (const c of cond.all) {
    const v = (snap as any)[c.metric];
    if (v == null) return false;
    const n = Number(v); const t = Number(c.value);
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

function fmtNum(v: number | null | undefined, dec: number) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(dec);
}

// --------------------------------------------------------------------------
// Override drawer (per-tuple)
// --------------------------------------------------------------------------

function OverrideDrawer({ snap, symbol, override, onClose }: any) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    account_balance_percent: override?.account_balance_percent ?? "",
    leverage: override?.leverage ?? "",
    position_size_multiplier: override?.position_size_multiplier ?? "",
    max_position_notional_usdt: override?.max_position_notional_usdt ?? "",
    max_margin_usage_usdt: override?.max_margin_usage_usdt ?? "",
    force_state: override?.force_state ?? "",
    notes: override?.notes ?? "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload: any = {
        symbol: snap.symbol,
        strategy: snap.strategy,
        tag: snap.tag ?? "",
      };
      for (const k of ["account_balance_percent","leverage","position_size_multiplier","max_position_notional_usdt","max_margin_usage_usdt"]) {
        const v = (form as any)[k];
        payload[k] = v === "" || v == null ? null : Number(v);
      }
      payload.force_state = form.force_state || null;
      payload.notes = form.notes || null;
      const { error } = await supabase.from("symbol_strategy_overrides").upsert(payload, { onConflict: "symbol,strategy,tag" });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["overrides"] }); onClose(); },
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!override?.id) return;
      const { error } = await supabase.from("symbol_strategy_overrides").delete().eq("id", override.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["overrides"] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/70 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4">
          <div className="text-sm text-muted-foreground">{snap.strategy}{snap.tag ? ` / ${snap.tag}` : ""}</div>
          <h2 className="text-lg font-semibold">{snap.symbol}</h2>
          <div className="mt-1 text-xs text-muted-foreground">
            Symbol-default: bal {symbol?.account_balance_percent}% · lev {symbol?.leverage}x · mult {symbol?.position_size_multiplier}
          </div>
        </div>

        <div className="space-y-3 text-sm">
          <Field label="Account balance %" value={form.account_balance_percent} onChange={(v) => setForm({ ...form, account_balance_percent: v })} placeholder="(bruk regel/default)" />
          <Field label="Leverage" value={form.leverage} onChange={(v) => setForm({ ...form, leverage: v })} placeholder="(bruk regel/default)" />
          <Field label="Position size multiplier" value={form.position_size_multiplier} onChange={(v) => setForm({ ...form, position_size_multiplier: v })} placeholder="(bruk regel/default)" />
          <Field label="Max notional USDT" value={form.max_position_notional_usdt} onChange={(v) => setForm({ ...form, max_position_notional_usdt: v })} placeholder="(symbol cap)" />
          <Field label="Max margin USDT" value={form.max_margin_usage_usdt} onChange={(v) => setForm({ ...form, max_margin_usage_usdt: v })} placeholder="(symbol cap)" />
          <div>
            <label className="block text-xs text-muted-foreground">Force state</label>
            <select
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"
              value={form.force_state}
              onChange={(e) => setForm({ ...form, force_state: e.target.value })}
            >
              <option value="">— ingen, bruk regler —</option>
              <option value="allow">Allow (overstyr blokkering)</option>
              <option value="block">Block (alltid stengt)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground">Notater</label>
            <input
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-between">
          <button
            className="rounded border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-30"
            onClick={() => remove.mutate()}
            disabled={!override?.id || remove.isPending}
          >
            Slett override
          </button>
          <div className="flex gap-2">
            <button className="rounded border border-border px-3 py-1.5 text-sm" onClick={onClose}>Avbryt</button>
            <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Lagrer…" : "Lagre"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: any) {
  return (
    <div>
      <label className="block text-xs text-muted-foreground">{label}</label>
      <input
        type="number"
        step="any"
        className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// --------------------------------------------------------------------------
// Rules tab — global ordered list
// --------------------------------------------------------------------------

function RulesTab() {
  const qc = useQueryClient();
  const { data: rules } = useQuery({
    queryKey: ["sizing-rules-all"],
    queryFn: async () => {
      const { data } = await supabase.from("sizing_rules").select("*").order("priority", { ascending: true });
      return (data ?? []) as Rule[];
    },
  });
  const [editing, setEditing] = useState<Rule | "new" | null>(null);

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("sizing_rules").update({ enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sizing-rules-all"] }),
  });

  const move = useMutation({
    mutationFn: async ({ id, dir }: { id: string; dir: -1 | 1 }) => {
      if (!rules) return;
      const idx = rules.findIndex((r) => r.id === id);
      const swap = rules[idx + dir];
      if (!swap) return;
      const a = rules[idx]; const b = swap;
      await supabase.from("sizing_rules").update({ priority: b.priority }).eq("id", a.id);
      await supabase.from("sizing_rules").update({ priority: a.priority }).eq("id", b.id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sizing-rules-all"] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("sizing_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sizing-rules-all"] }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">Regler evalueres top-down. Første treff vinner.</div>
        <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => setEditing("new")}>+ Ny regel</button>
      </div>
      {(rules?.length ?? 0) === 0 ? (
        <EmptyState title="Ingen regler" hint="Klikk + Ny regel for å lage en." />
      ) : (
        <table className="w-full text-sm tabular">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-2 w-10">#</th>
              <th>Label</th>
              <th>Betingelse</th>
              <th>Effekt</th>
              <th>På</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rules!.map((r, i) => (
              <tr key={r.id}>
                <td className="py-2 text-muted-foreground">{i + 1}</td>
                <td className="font-medium">{r.label}</td>
                <td className="text-xs">{describeCond(r.condition)}</td>
                <td className="text-xs">{describeAction(r.action)}</td>
                <td>
                  <input type="checkbox" checked={r.enabled} onChange={(e) => toggle.mutate({ id: r.id, enabled: e.target.checked })} />
                </td>
                <td className="text-right space-x-1">
                  <button className="rounded border border-border px-2 py-0.5 text-xs disabled:opacity-30" onClick={() => move.mutate({ id: r.id, dir: -1 })} disabled={i === 0}>↑</button>
                  <button className="rounded border border-border px-2 py-0.5 text-xs disabled:opacity-30" onClick={() => move.mutate({ id: r.id, dir: 1 })} disabled={i === (rules!.length - 1)}>↓</button>
                  <button className="rounded border border-border px-2 py-0.5 text-xs" onClick={() => setEditing(r)}>Edit</button>
                  <button className="rounded border border-destructive px-2 py-0.5 text-xs text-destructive" onClick={() => remove.mutate(r.id)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          nextPriority={(rules?.[rules.length - 1]?.priority ?? 0) + 10}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function describeCond(c: Rule["condition"]) {
  if (!c?.all?.length) return "(ingen)";
  return c.all.map((x) => `${x.metric} ${x.op} ${x.value}`).join(" AND ");
}
function describeAction(a: Rule["action"]) {
  if (a?.block) return "BLOCK";
  if (a?.set) return Object.entries(a.set).map(([k, v]) => `${k} = ${v}`).join(", ");
  return "—";
}

function RuleEditor({ rule, nextPriority, onClose }: any) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(rule?.label ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [conds, setConds] = useState<Array<{ metric: string; op: string; value: string }>>(
    rule?.condition?.all?.map((c: any) => ({ metric: c.metric, op: c.op, value: String(c.value) })) ?? [{ metric: "winrate", op: ">=", value: "55" }],
  );
  const [actionType, setActionType] = useState<"set" | "block">(rule?.action?.block ? "block" : "set");
  const [setFields, setSetFields] = useState({
    account_balance_percent: rule?.action?.set?.account_balance_percent ?? "",
    leverage: rule?.action?.set?.leverage ?? "",
    position_size_multiplier: rule?.action?.set?.position_size_multiplier ?? "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const condition = { all: conds.map((c) => ({ metric: c.metric, op: c.op, value: Number(c.value) })) };
      const action: any = actionType === "block"
        ? { block: true }
        : { set: Object.fromEntries(Object.entries(setFields).filter(([_, v]) => v !== "" && v != null).map(([k, v]) => [k, Number(v)])) };
      const payload: any = { label, enabled, condition, action };
      if (rule?.id) {
        const { error } = await supabase.from("sizing_rules").update(payload).eq("id", rule.id);
        if (error) throw error;
      } else {
        payload.priority = nextPriority;
        const { error } = await supabase.from("sizing_rules").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sizing-rules-all"] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/70 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">{rule ? "Rediger regel" : "Ny regel"}</h2>
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-muted-foreground">Label</label>
            <input className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>

          <div>
            <label className="block text-xs text-muted-foreground">Betingelser (AND)</label>
            {conds.map((c, i) => (
              <div key={i} className="mt-1 flex gap-2">
                <select className="flex-1 rounded border border-border bg-background px-2 py-1" value={c.metric} onChange={(e) => updateCond(i, { metric: e.target.value })}>
                  <option value="winrate">winrate</option>
                  <option value="profit_factor">profit_factor</option>
                  <option value="net_profit">net_profit</option>
                </select>
                <select className="rounded border border-border bg-background px-2 py-1" value={c.op} onChange={(e) => updateCond(i, { op: e.target.value })}>
                  <option value=">">{">"}</option>
                  <option value=">=">{"≥"}</option>
                  <option value="<">{"<"}</option>
                  <option value="<=">{"≤"}</option>
                  <option value="==">{"="}</option>
                </select>
                <input type="number" step="any" className="w-24 rounded border border-border bg-background px-2 py-1" value={c.value} onChange={(e) => updateCond(i, { value: e.target.value })} />
                <button className="rounded border border-border px-2 text-xs" onClick={() => setConds(conds.filter((_, j) => j !== i))} disabled={conds.length === 1}>×</button>
              </div>
            ))}
            <button className="mt-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setConds([...conds, { metric: "winrate", op: ">=", value: "0" }])}>+ legg til betingelse</button>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground">Effekt</label>
            <div className="mt-1 flex gap-2">
              <label className="flex items-center gap-1 text-xs"><input type="radio" checked={actionType === "set"} onChange={() => setActionType("set")} /> Sett verdier</label>
              <label className="flex items-center gap-1 text-xs"><input type="radio" checked={actionType === "block"} onChange={() => setActionType("block")} /> Blokkér handel</label>
            </div>
            {actionType === "set" && (
              <div className="mt-2 space-y-2">
                <Field label="Account balance %" value={setFields.account_balance_percent} onChange={(v: string) => setSetFields({ ...setFields, account_balance_percent: v })} placeholder="(la stå tom for ingen endring)" />
                <Field label="Leverage" value={setFields.leverage} onChange={(v: string) => setSetFields({ ...setFields, leverage: v })} placeholder="(tom = ingen endring)" />
                <Field label="Position size multiplier" value={setFields.position_size_multiplier} onChange={(v: string) => setSetFields({ ...setFields, position_size_multiplier: v })} placeholder="(tom = ingen endring)" />
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Aktivert
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded border border-border px-3 py-1.5 text-sm" onClick={onClose}>Avbryt</button>
          <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => save.mutate()} disabled={save.isPending || !label.trim()}>
            {save.isPending ? "Lagrer…" : "Lagre"}
          </button>
        </div>
      </div>
    </div>
  );

  function updateCond(i: number, patch: Partial<{ metric: string; op: string; value: string }>) {
    setConds(conds.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
}
