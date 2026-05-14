import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_app/analytics-debug")({
  component: AnalyticsDebugPage,
});

const ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

type EndpointResponse = { status: number; body: unknown };

async function callAnalyticsEndpoint(path: string, body: unknown): Promise<EndpointResponse> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = await res.text().catch(() => null); }
  return { status: res.status, body: parsed };
}

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Pre({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function fmtVal(v: unknown, d = 2): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(d) : "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function KV({ items }: { items: Array<[string, unknown, number?]> }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-3 md:grid-cols-4">
      {items.map(([k, v, d]) => (
        <div key={k} className="flex items-baseline justify-between gap-2 border-b border-border/30 py-0.5">
          <span className="text-muted-foreground">{k}</span>
          <span className="font-mono text-foreground">{fmtVal(v, d ?? 4)}</span>
        </div>
      ))}
    </div>
  );
}

function TfSourceBadge({ source, hasTf }: { source: unknown; hasTf: boolean }) {
  if (!hasTf) {
    return (
      <span className="ml-1 inline-block rounded border border-dashed border-border px-1 py-0 text-[9px] text-muted-foreground">
        none
      </span>
    );
  }
  const s = typeof source === "string" ? source : "payload";
  if (s === "health_snapshot") {
    return (
      <span className="ml-1 inline-block rounded bg-warning/20 px-1 py-0 text-[9px] text-warning">
        health
      </span>
    );
  }
  return (
    <span className="ml-1 inline-block rounded bg-muted px-1 py-0 text-[9px] text-muted-foreground">
      {s}
    </span>
  );
}

const TRADE_FIELDS: Array<[string, number?]> = [
  ["regime_class", 0], ["tf_source", 0],
  ["atr", 6], ["atr_pct", 4],
  ["candle_range_pct", 4], ["rel_volume_20", 3],
  ["ema20", 6], ["ema50", 6],
  ["ema200", 6], ["ema_slope_pct", 4],
  ["dist_from_ema50_pct", 4], ["rsi14", 2],
  ["adx14", 2], ["volume", 2],
];

const CONTEXT_FIELDS: Array<[string, number?]> = [
  ["regime_class", 0], ["ema_slope_pct", 4],
  ["adx14", 2], ["atr_pct", 4],
  ["rel_volume_20", 3], ["dist_from_ema50_pct", 4],
];

function ResponseBlock({ resp, busy }: { resp: EndpointResponse | null; busy: boolean }) {
  if (busy) return <div className="text-xs text-muted-foreground">Running…</div>;
  if (!resp) return <div className="text-xs text-muted-foreground">No response yet.</div>;
  const b = resp.body as any;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="rounded bg-muted px-2 py-0.5">HTTP {resp.status}</span>
        {b && typeof b === "object" && "ok" in b && (
          <span className={`rounded px-2 py-0.5 ${b.ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}`}>
            ok={String(b.ok)}
          </span>
        )}
        {b && typeof b === "object" && "rows_written" in b && (
          <span className="rounded bg-muted px-2 py-0.5">rows_written={String(b.rows_written)}</span>
        )}
        {b && typeof b === "object" && "api_calls" in b && (
          <span className="rounded bg-muted px-2 py-0.5">api_calls={String(b.api_calls)}</span>
        )}
        {b && typeof b === "object" && "dry_run" in b && (
          <span className="rounded bg-muted px-2 py-0.5">dry_run={String(b.dry_run)}</span>
        )}
        {b && typeof b === "object" && Array.isArray(b.errors) && (
          <span className={`rounded px-2 py-0.5 ${b.errors.length ? "bg-warning/20 text-warning" : "bg-muted"}`}>
            errors={b.errors.length}
          </span>
        )}
      </div>
      <Pre value={resp.body} />
    </div>
  );
}

function AnalyticsDebugPage() {
  // Latest data ----------------------------------------------------------
  const runs = useQuery({
    queryKey: ["analytics-runs"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("analytics_snapshot_runs")
        .select("id, writer, started_at, finished_at, ok, symbols_processed, rows_written, api_calls, errors")
        .order("started_at", { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });

  const ctxSnapshots = useQuery({
    queryKey: ["analytics-ctx"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("signal_context_snapshots")
        .select("id, created_at, signal_id, symbol, strategy, environment, timeframe, tf_role, bar_time, payload")
        .order("created_at", { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });

  const regimeSnapshots = useQuery({
    queryKey: ["analytics-regime"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("regime_snapshots")
        .select("id, captured_at, symbol, timeframe, bar_time, regime_class, payload")
        .order("captured_at", { ascending: false })
        .limit(30);
      return data ?? [];
    },
  });

  // Recent signals to choose from ---------------------------------------
  const recentSignals = useQuery({
    queryKey: ["analytics-recent-signals"],
    refetchInterval: 10_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("signals")
        .select("id, created_at, symbol, strategy, type, action, payload")
        .eq("type", "trade")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  const enabledSymbols = useQuery({
    queryKey: ["analytics-enabled-symbols"],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("symbol").eq("enabled", true).order("symbol");
      return (data ?? []).map((r) => r.symbol);
    },
  });

  // Form state -----------------------------------------------------------
  const [signalId, setSignalId] = useState<string>("");
  const [signalResp, setSignalResp] = useState<EndpointResponse | null>(null);
  const [signalBusy, setSignalBusy] = useState(false);

  const [regimeSchedule, setRegimeSchedule] = useState<"trade" | "context" | "manual">("manual");
  const [regimeSymbols, setRegimeSymbols] = useState<string>("BTCUSDT,ETHUSDT");
  const [regimeTfs, setRegimeTfs] = useState<string>("1h");
  const [regimeDry, setRegimeDry] = useState(true);
  const [regimeResp, setRegimeResp] = useState<EndpointResponse | null>(null);
  const [regimeBusy, setRegimeBusy] = useState(false);

  const [expandedCtx, setExpandedCtx] = useState<Set<string>>(new Set());
  const [expandedRegime, setExpandedRegime] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSet(n);
  };

  const signalChoices = useMemo(() => recentSignals.data ?? [], [recentSignals.data]);

  async function runSignalCtx() {
    if (!signalId) return;
    setSignalBusy(true); setSignalResp(null);
    try {
      const r = await callAnalyticsEndpoint("/api/public/hooks/snapshot-signal-context", { signal_id: signalId });
      setSignalResp(r);
      runs.refetch(); ctxSnapshots.refetch();
    } finally { setSignalBusy(false); }
  }

  async function runRegime(dryOverride?: boolean) {
    setRegimeBusy(true); setRegimeResp(null);
    const body: Record<string, unknown> = { schedule: regimeSchedule, dry_run: dryOverride ?? regimeDry };
    if (regimeSchedule === "manual" || regimeSymbols.trim()) {
      const syms = regimeSymbols.split(",").map((s) => s.trim()).filter(Boolean);
      if (syms.length) body.symbols = syms;
    }
    if (regimeSchedule === "manual" || regimeTfs.trim()) {
      const tfs = regimeTfs.split(",").map((s) => s.trim()).filter(Boolean);
      if (tfs.length) body.timeframes = tfs;
    }
    try {
      const r = await callAnalyticsEndpoint("/api/public/hooks/snapshot-regime-tick", body);
      setRegimeResp(r);
      runs.refetch(); regimeSnapshots.refetch();
    } finally { setRegimeBusy(false); }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold">Analytics Debug (Phase 2A)</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Read-only validation surface for analytics snapshot writers. No execution, no cron, no signal triggers.
          Bridge passthrough is restricted to public market data (<code>/v5/market/kline</code>, <code>/v5/market/tickers</code>).
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Run signal-context snapshot">
          <div className="space-y-3">
            <label className="block text-xs text-muted-foreground">signal_id</label>
            <div className="flex gap-2">
              <input
                value={signalId}
                onChange={(e) => setSignalId(e.target.value)}
                placeholder="uuid"
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs font-mono"
              />
              <select
                onChange={(e) => setSignalId(e.target.value)}
                value=""
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                <option value="">— pick recent —</option>
                {signalChoices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.symbol ?? "?"} · {s.type}/{s.action ?? ""} · {new Date(s.created_at).toLocaleString()} · {s.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={runSignalCtx}
              disabled={!signalId || signalBusy}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              Run snapshot-signal-context
            </button>
            <ResponseBlock resp={signalResp} busy={signalBusy} />
          </div>
        </Card>

        <Card title="Run regime tick">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground">schedule</label>
                <select
                  value={regimeSchedule}
                  onChange={(e) => setRegimeSchedule(e.target.value as any)}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  <option value="manual">manual</option>
                  <option value="trade">trade (5m,15m,30m)</option>
                  <option value="context">context (1h,4h,1d)</option>
                </select>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={regimeDry} onChange={(e) => setRegimeDry(e.target.checked)} />
                  dry_run
                </label>
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground">
                symbols (comma sep; blank = enabled universe). Enabled: {enabledSymbols.data?.length ?? 0}
              </label>
              <input
                value={regimeSymbols}
                onChange={(e) => setRegimeSymbols(e.target.value)}
                placeholder="BTCUSDT,ETHUSDT"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground">
                timeframes (comma sep; required for manual)
              </label>
              <input
                value={regimeTfs}
                onChange={(e) => setRegimeTfs(e.target.value)}
                placeholder="1h,4h"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => runRegime(true)}
                disabled={regimeBusy}
                className="rounded border border-border bg-background px-3 py-1.5 text-xs font-medium disabled:opacity-40"
              >
                Run dry_run
              </button>
              <button
                onClick={() => runRegime(false)}
                disabled={regimeBusy}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                Run write mode
              </button>
            </div>
            <ResponseBlock resp={regimeResp} busy={regimeBusy} />
          </div>
        </Card>
      </div>

      <Card title={`Latest analytics_snapshot_runs (${runs.data?.length ?? 0})`}>
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">started_at</th>
                <th className="px-2 py-1 text-left">writer</th>
                <th className="px-2 py-1 text-right">syms</th>
                <th className="px-2 py-1 text-right">rows</th>
                <th className="px-2 py-1 text-right">api</th>
                <th className="px-2 py-1 text-left">ok</th>
                <th className="px-2 py-1 text-left">errors</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data ?? []).map((r) => (
                <tr key={r.id} className="border-t border-border/50">
                  <td className="px-2 py-1 font-mono">{new Date(r.started_at).toLocaleTimeString()}</td>
                  <td className="px-2 py-1">{r.writer}</td>
                  <td className="px-2 py-1 text-right">{r.symbols_processed}</td>
                  <td className="px-2 py-1 text-right">{r.rows_written}</td>
                  <td className="px-2 py-1 text-right">{r.api_calls}</td>
                  <td className={`px-2 py-1 ${r.ok ? "text-success" : "text-danger"}`}>{String(r.ok)}</td>
                  <td className="px-2 py-1 truncate font-mono">
                    {Array.isArray(r.errors) && r.errors.length
                      ? `${(r.errors as any[]).length}: ${JSON.stringify((r.errors as any[])[0]).slice(0, 80)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Latest signal_context_snapshots (${ctxSnapshots.data?.length ?? 0})`}>
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">created_at</th>
                <th className="px-2 py-1 text-left">symbol</th>
                <th className="px-2 py-1 text-left">tf</th>
                <th className="px-2 py-1 text-left">role</th>
                <th className="px-2 py-1 text-left">env</th>
                <th className="px-2 py-1 text-left">strategy</th>
                <th className="px-2 py-1 text-left">payload</th>
              </tr>
            </thead>
            <tbody>
              {(ctxSnapshots.data ?? []).map((r) => (
                <tr key={r.id} className="border-t border-border/50 align-top">
                  <td className="px-2 py-1 font-mono">{new Date(r.created_at).toLocaleTimeString()}</td>
                  <td className="px-2 py-1">{r.symbol}</td>
                  <td className="px-2 py-1">{r.timeframe ?? "—"}</td>
                  <td className="px-2 py-1">{r.tf_role}</td>
                  <td className="px-2 py-1">{r.environment ?? "—"}</td>
                  <td className="px-2 py-1">{r.strategy ?? "—"}</td>
                  <td className="px-2 py-1 max-w-md truncate font-mono">{JSON.stringify(r.payload).slice(0, 160)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Latest regime_snapshots (${regimeSnapshots.data?.length ?? 0})`}>
        <div className="overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">captured_at</th>
                <th className="px-2 py-1 text-left">symbol</th>
                <th className="px-2 py-1 text-left">tf</th>
                <th className="px-2 py-1 text-left">regime</th>
                <th className="px-2 py-1 text-right">atr%</th>
                <th className="px-2 py-1 text-right">adx14</th>
                <th className="px-2 py-1 text-right">slope%</th>
                <th className="px-2 py-1 text-right">relVol</th>
              </tr>
            </thead>
            <tbody>
              {(regimeSnapshots.data ?? []).map((r) => {
                const p = (r.payload ?? {}) as any;
                const fmt = (v: unknown, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
                return (
                  <tr key={r.id} className="border-t border-border/50">
                    <td className="px-2 py-1 font-mono">{new Date(r.captured_at).toLocaleTimeString()}</td>
                    <td className="px-2 py-1">{r.symbol}</td>
                    <td className="px-2 py-1">{r.timeframe}</td>
                    <td className="px-2 py-1">{r.regime_class ?? "—"}</td>
                    <td className="px-2 py-1 text-right">{fmt(p.atr_pct)}</td>
                    <td className="px-2 py-1 text-right">{fmt(p.adx14, 1)}</td>
                    <td className="px-2 py-1 text-right">{fmt(p.ema_slope_pct)}</td>
                    <td className="px-2 py-1 text-right">{fmt(p.rel_volume_20)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
