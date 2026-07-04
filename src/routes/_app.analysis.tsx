/**
 * /analysis — Backtest ↔ Market Insights.
 *
 * Read-only analytics. Three tabs (Drivers, Ranking, Segments) computed
 * client-side from the flattened dataset returned by getAnalysisDataset.
 * Does not touch execution, dispatcher, sizing or signals.
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, Card, EmptyState } from '@/components/PageHeader';
import {
  getAnalysisDataset,
  ALL_FEATURES,
  TOP_LEVEL_FEATURES,
  HTQ_COMPONENT_FEATURES,
  type AnalysisRow,
  type FeatureKey,
} from '@/lib/analysis/analysis.functions';
import {
  LABEL_ORDER,
  LABEL_COLOR,
  summarizeFeature,
  correlateFeatureWithTargets,
  bucketByQuartile,
  labelMix,
  rankRows,
  DEFAULT_WEIGHTS,
  type ScoreWeights,
} from '@/lib/analysis/stats';
import { generateInsights } from '@/lib/analysis/insights';
import { InsightsPanel } from '@/components/analysis/InsightsPanel';

export const Route = createFileRoute('/_app/analysis')({
  component: AnalysisPage,
  errorComponent: ({ error }) => (
    <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700">
      Feil ved lasting av analyse: {(error as any)?.message ?? String(error)}
    </div>
  ),
  notFoundComponent: () => <EmptyState title="Ingen data" hint="Kjør backtest-import først." />,
});

type Tab = 'drivers' | 'ranking' | 'segments';

const fmt = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
const fmtInt = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString();
const fmtCompact = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(2);
};

function AnalysisPage() {
  const [tab, setTab] = useState<Tab>('drivers');
  const [strategy, setStrategy] = useState<string>('');
  const [timeframe, setTimeframe] = useState<string>('');
  const [minTrades, setMinTrades] = useState<number>(0);

  const q = useQuery({
    queryKey: ['analysis-dataset', strategy, timeframe, minTrades],
    queryFn: () =>
      getAnalysisDataset({
        data: {
          strategy_version: strategy || null,
          timeframe: timeframe || null,
          min_trades: minTrades,
        },
      }),
  });

  const data = q.data;
  const active = useMemo(() => (data?.rows ?? []).filter((r) => !r.excluded), [data]);
  const rankedForInsights = useMemo(
    () => (active.length ? rankRows(active, DEFAULT_WEIGHTS) : []),
    [active],
  );
  const insights = useMemo(
    () => (data ? generateInsights(data, active, rankedForInsights) : []),
    [data, active, rankedForInsights],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Analysis"
        description="Sammenheng mellom markedsegenskaper og backtest-resultat på tvers av alle importerte coins."
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Strategy version</span>
            <select
              className="rounded border bg-background px-2 py-1"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              <option value="">(alle)</option>
              {(data?.meta.strategies ?? []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Timeframe</span>
            <select
              className="rounded border bg-background px-2 py-1"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
            >
              <option value="">(alle)</option>
              {(data?.meta.timeframes ?? []).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Min trades</span>
            <input
              type="number"
              min={0}
              className="w-24 rounded border bg-background px-2 py-1"
              value={minTrades}
              onChange={(e) => setMinTrades(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <div className="ml-auto text-muted-foreground">
            {q.isLoading ? (
              'Laster…'
            ) : data ? (
              <>
                <strong className="text-foreground">{data.meta.included}</strong> aktive ·{' '}
                {data.meta.excluded} ekskludert · {data.meta.strategies.length} strategier ·{' '}
                {data.meta.timeframes.length} timeframes
              </>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="flex gap-1 border-b border-border text-sm">
        {(['drivers', 'ranking', 'segments'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-t px-4 py-2 capitalize transition-colors ${
              tab === t
                ? 'border border-b-transparent border-border bg-card font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {q.error && (
        <Card>
          <p className="text-sm text-red-600">
            Feil: {(q.error as any)?.message ?? String(q.error)}
          </p>
        </Card>
      )}

      {!q.isLoading && active.length === 0 && (
        <EmptyState title="Ingen aktive rader" hint="Juster filtre eller importer backtest-data." />
      )}

      {active.length > 0 && tab === 'drivers' && <DriversTab rows={active} />}
      {active.length > 0 && tab === 'ranking' && <RankingTab rows={active} />}
      {active.length > 0 && tab === 'segments' && <SegmentsTab rows={active} />}
    </div>
  );
}

// ── Drivers ──────────────────────────────────────────────────────────────

function DriversTab({ rows }: { rows: AnalysisRow[] }) {
  const summaries = useMemo(
    () =>
      ALL_FEATURES.map((f) => summarizeFeature(rows, f))
        .filter((s) => s.n > 0)
        .sort((a, b) => Math.abs(b.separation ?? 0) - Math.abs(a.separation ?? 0)),
    [rows],
  );

  const correlations = useMemo(
    () => ALL_FEATURES.map((f) => ({ f, ...correlateFeatureWithTargets(rows, f) })),
    [rows],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Feature separation (profitable vs. rejected)">
        <p className="mb-2 text-[11px] text-muted-foreground">
          Cohen's d mellom profitable+profitable_plus og rejected_backtest. Positiv = høyere
          verdi hos vinnere. |d|&gt;0.5 = merkbar forskjell, &gt;0.8 = stor.
        </p>
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-2">Feature</th>
                <th className="py-1 pr-2 text-right">n</th>
                <th className="py-1 pr-2 text-right">d</th>
                <th className="py-1 pr-2 text-right">med(rej)</th>
                <th className="py-1 pr-2 text-right">med(marg)</th>
                <th className="py-1 pr-2 text-right">med(prof)</th>
                <th className="py-1 pr-2 text-right">med(prof+)</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.feature} className="border-b border-border/40">
                  <td className="py-1 pr-2 font-mono">{s.feature}</td>
                  <td className="py-1 pr-2 text-right font-mono">{s.n}</td>
                  <td
                    className={`py-1 pr-2 text-right font-mono ${
                      s.separation == null
                        ? ''
                        : Math.abs(s.separation) >= 0.8
                        ? 'text-emerald-600 font-semibold'
                        : Math.abs(s.separation) >= 0.5
                        ? 'text-emerald-500'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {s.separation == null ? '—' : s.separation.toFixed(2)}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono">
                    {fmtCompact(s.perLabel.rejected_backtest.median)}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono">
                    {fmtCompact(s.perLabel.marginal.median)}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono">
                    {fmtCompact(s.perLabel.profitable.median)}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono">
                    {fmtCompact(s.perLabel.profitable_plus.median)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Korrelasjon (Pearson) med resultat">
        <p className="mb-2 text-[11px] text-muted-foreground">
          Positiv = høyere feature-verdi ↔ bedre resultat. r &gt; 0.3 = merkbar. Kun rader med
          gyldige verdier for begge felt.
        </p>
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-2">Feature</th>
                <th className="py-1 pr-2 text-right">n</th>
                <th className="py-1 pr-2 text-right">r(net%)</th>
                <th className="py-1 pr-2 text-right">r(PF)</th>
                <th className="py-1 pr-2 text-right">r(win%)</th>
              </tr>
            </thead>
            <tbody>
              {correlations
                .slice()
                .sort((a, b) => Math.abs(b.net ?? 0) - Math.abs(a.net ?? 0))
                .map((c) => (
                  <tr key={c.f} className="border-b border-border/40">
                    <td className="py-1 pr-2 font-mono">{c.f}</td>
                    <td className="py-1 pr-2 text-right font-mono">{c.n}</td>
                    <RCell v={c.net} />
                    <RCell v={c.pf} />
                    <RCell v={c.win} />
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="lg:col-span-2">
        <Card title="Top-6 features — distribusjon per label">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {summaries.slice(0, 6).map((s) => (
              <FeatureBoxplot key={s.feature} summary={s} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function RCell({ v }: { v: number | null }) {
  if (v == null) return <td className="py-1 pr-2 text-right font-mono text-muted-foreground">—</td>;
  const strong = Math.abs(v) >= 0.3;
  const dir = v > 0 ? 'text-emerald-600' : 'text-red-500';
  return (
    <td className={`py-1 pr-2 text-right font-mono ${strong ? dir + ' font-semibold' : 'text-muted-foreground'}`}>
      {v.toFixed(2)}
    </td>
  );
}

function FeatureBoxplot({ summary }: { summary: ReturnType<typeof summarizeFeature> }) {
  const all: number[] = [];
  for (const lbl of LABEL_ORDER) {
    const b = summary.perLabel[lbl];
    if (b.p25 != null) all.push(b.p25);
    if (b.p75 != null) all.push(b.p75);
    if (b.median != null) all.push(b.median);
  }
  if (all.length === 0) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const norm = (v: number) => ((v - min) / span) * 100;

  return (
    <div className="rounded border border-border/50 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-[11px]">{summary.feature}</span>
        <span className="text-[10px] text-muted-foreground">
          d = {summary.separation == null ? '—' : summary.separation.toFixed(2)}
        </span>
      </div>
      <div className="space-y-1">
        {LABEL_ORDER.map((lbl) => {
          const b = summary.perLabel[lbl];
          if (b.n === 0 || b.p25 == null || b.p75 == null || b.median == null) {
            return (
              <div key={lbl} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className={`w-24 rounded px-1 ${LABEL_COLOR[lbl]}`}>{lbl}</span>
                <span>ingen data</span>
              </div>
            );
          }
          const left = norm(b.p25);
          const width = Math.max(1, norm(b.p75) - norm(b.p25));
          const med = norm(b.median);
          return (
            <div key={lbl} className="flex items-center gap-2 text-[10px]">
              <span className={`w-24 shrink-0 rounded px-1 text-center ${LABEL_COLOR[lbl]}`}>{lbl}</span>
              <div className="relative h-3 flex-1 rounded bg-muted/40">
                <div
                  className="absolute inset-y-0 rounded bg-primary/40"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
                <div
                  className="absolute inset-y-0 w-[2px] bg-primary"
                  style={{ left: `${med}%` }}
                />
              </div>
              <span className="w-14 text-right font-mono text-muted-foreground">
                {fmtCompact(b.median)}
              </span>
              <span className="w-8 text-right text-muted-foreground">n={b.n}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Ranking ──────────────────────────────────────────────────────────────

function RankingTab({ rows }: { rows: AnalysisRow[] }) {
  const [weights, setWeights] = useState<ScoreWeights>(DEFAULT_WEIGHTS);
  const ranked = useMemo(() => rankRows(rows, weights), [rows, weights]);

  const exportCsv = () => {
    const header = [
      'rank', 'symbol', 'strategy_version', 'timeframe', 'label', 'net_pct', 'dd_pct',
      'profit_factor', 'win_pct', 'trades', 'quality', 'htq', 'momentum', 'fit', 'score',
    ];
    const lines = [header.join(',')];
    ranked.forEach((rr, i) => {
      const r = rr.row;
      lines.push([
        i + 1, r.symbol, r.strategy_version, r.timeframe, r.label ?? '',
        r.net_profit_pct ?? '', r.max_drawdown_pct ?? '', r.profit_factor ?? '',
        r.win_rate_pct ?? '', r.num_trades ?? '',
        r.backtest_quality_score ?? '', r.features.historical_trend_quality ?? '',
        r.features.current_momentum_score ?? '', r.features.strategy_fit_score ?? '',
        rr.score.toFixed(4),
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'analysis-ranking.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card title="Vekter (composite score)">
        <div className="grid gap-4 md:grid-cols-4">
          <WeightSlider label="Quality score" value={weights.quality}
            onChange={(v) => setWeights({ ...weights, quality: v })} />
          <WeightSlider label="Profit factor" value={weights.pf}
            onChange={(v) => setWeights({ ...weights, pf: v })} />
          <WeightSlider label="Net% / |DD%|" value={weights.riskAdj}
            onChange={(v) => setWeights({ ...weights, riskAdj: v })} />
          <WeightSlider label="Label bonus" value={weights.label}
            onChange={(v) => setWeights({ ...weights, label: v })} />
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Vekter normaliseres til sum = 1. Verdier robust-normert (5–95%-persentiler).</span>
          <button className="rounded border px-2 py-1 hover:bg-muted" onClick={exportCsv}>
            Eksporter CSV
          </button>
        </div>
      </Card>

      <Card title={`Kandidat-ranking (${ranked.length})`}>
        <div className="max-h-[720px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">Symbol</th>
                <th className="py-1 pr-2">Label</th>
                <th className="py-1 pr-2 text-right">net%</th>
                <th className="py-1 pr-2 text-right">DD%</th>
                <th className="py-1 pr-2 text-right">PF</th>
                <th className="py-1 pr-2 text-right">win%</th>
                <th className="py-1 pr-2 text-right">trades</th>
                <th className="py-1 pr-2 text-right">Q</th>
                <th className="py-1 pr-2 text-right">HTQ</th>
                <th className="py-1 pr-2 text-right">mom</th>
                <th className="py-1 pr-2 text-right">fit</th>
                <th className="py-1 pr-2 text-right">score</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((rr, i) => {
                const r = rr.row;
                return (
                  <tr key={r.id} className="border-b border-border/40 hover:bg-muted/30">
                    <td className="py-1 pr-2 text-right font-mono text-muted-foreground">{i + 1}</td>
                    <td className="py-1 pr-2 font-mono">
                      <Link
                        to="/symbols/$symbol"
                        params={{ symbol: r.symbol }}
                        className="text-primary hover:underline"
                      >
                        {r.symbol}
                      </Link>
                    </td>
                    <td className="py-1 pr-2">
                      {r.label ? (
                        <span className={`rounded px-1 ${LABEL_COLOR[r.label]}`}>{r.label}</span>
                      ) : '—'}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.net_profit_pct, 1)}</td>
                    <td className="py-1 pr-2 text-right font-mono text-red-600">
                      {fmt(r.max_drawdown_pct, 1)}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.profit_factor)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.win_rate_pct, 1)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmtInt(r.num_trades)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.backtest_quality_score, 0)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.features.historical_trend_quality)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.features.current_momentum_score)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(r.features.strategy_fit_score)}</td>
                    <td className="py-1 pr-2 text-right font-mono font-semibold text-primary">
                      {rr.score.toFixed(3)}
                    </td>
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

function WeightSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="flex items-center justify-between text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono text-foreground">{value.toFixed(2)}</span>
      </span>
      <input
        type="range" min={0} max={1} step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// ── Segments ─────────────────────────────────────────────────────────────

function SegmentsTab({ rows }: { rows: AnalysisRow[] }) {
  const [xFeature, setXFeature] = useState<FeatureKey>('historical_trend_quality');
  const [yFeature, setYFeature] = useState<FeatureKey>('spread_bps');

  const featuresWithData = useMemo(
    () =>
      ALL_FEATURES.filter((f) => {
        let c = 0;
        for (const r of rows) if (r.features[f] != null) { c++; if (c > 3) return true; }
        return false;
      }),
    [rows],
  );

  return (
    <div className="space-y-4">
      <Card title="Label-mix per kvartil">
        <p className="mb-3 text-[11px] text-muted-foreground">
          For hver feature: splitt aktive rader i 4 like store bøtter (Q1 = lavest verdi, Q4 =
          høyest) og vis andel profitable/profitable_plus per bøtte. En "sweet spot" viser seg
          som én kvartil med mye høyere grønn andel enn resten.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {featuresWithData.map((f) => (
            <QuartileBars key={f} rows={rows} feature={f} />
          ))}
        </div>
      </Card>

      <Card title="2D heatmap (win-share per celle)">
        <div className="mb-3 flex flex-wrap gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">X-akse (kvartiler)</span>
            <select
              className="rounded border bg-background px-2 py-1"
              value={xFeature}
              onChange={(e) => setXFeature(e.target.value as FeatureKey)}
            >
              {featuresWithData.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Y-akse (kvartiler)</span>
            <select
              className="rounded border bg-background px-2 py-1"
              value={yFeature}
              onChange={(e) => setYFeature(e.target.value as FeatureKey)}
            >
              {featuresWithData.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        </div>
        <Heatmap2D rows={rows} xFeature={xFeature} yFeature={yFeature} />
      </Card>
    </div>
  );
}

function QuartileBars({ rows, feature }: { rows: AnalysisRow[]; feature: FeatureKey }) {
  const bucketed = useMemo(() => bucketByQuartile(rows, feature), [rows, feature]);
  if (!bucketed) {
    return (
      <div className="rounded border border-border/40 p-2 text-[11px] text-muted-foreground">
        {feature}: for få verdier
      </div>
    );
  }
  const { edges, buckets } = bucketed;
  return (
    <div className="rounded border border-border/50 p-2">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-mono">{feature}</span>
        <span className="text-muted-foreground">
          {fmtCompact(edges[0])} → {fmtCompact(edges[4])}
        </span>
      </div>
      <div className="space-y-1">
        {buckets.map((b, i) => {
          const mix = labelMix(b);
          const pct = (v: number) => (b.length === 0 ? 0 : (v / b.length) * 100);
          return (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="w-16 shrink-0 text-muted-foreground">
                Q{i + 1} <span className="text-foreground/70">≤{fmtCompact(edges[i + 1])}</span>
              </span>
              <div className="flex h-3 flex-1 overflow-hidden rounded bg-muted/40">
                <div className="bg-red-500/60" style={{ width: `${pct(mix.counts.rejected_backtest)}%` }} />
                <div className="bg-yellow-500/60" style={{ width: `${pct(mix.counts.marginal)}%` }} />
                <div className="bg-green-500/70" style={{ width: `${pct(mix.counts.profitable)}%` }} />
                <div className="bg-emerald-600/80" style={{ width: `${pct(mix.counts.profitable_plus)}%` }} />
              </div>
              <span className="w-12 text-right font-mono">
                {(mix.winShare * 100).toFixed(0)}%
              </span>
              <span className="w-10 text-right text-muted-foreground">n={b.length}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Heatmap2D({ rows, xFeature, yFeature }: { rows: AnalysisRow[]; xFeature: FeatureKey; yFeature: FeatureKey }) {
  const bx = useMemo(() => bucketByQuartile(rows, xFeature), [rows, xFeature]);
  const by = useMemo(() => bucketByQuartile(rows, yFeature), [rows, yFeature]);
  if (!bx || !by) {
    return <p className="text-xs text-muted-foreground">For få verdier for valgt kombinasjon.</p>;
  }

  const rowIndex = new Map<string, { x: number; y: number }>();
  bx.buckets.forEach((b, xi) => b.forEach((r) => {
    const prev = rowIndex.get(r.id) ?? { x: -1, y: -1 };
    rowIndex.set(r.id, { ...prev, x: xi });
  }));
  by.buckets.forEach((b, yi) => b.forEach((r) => {
    const prev = rowIndex.get(r.id) ?? { x: -1, y: -1 };
    rowIndex.set(r.id, { ...prev, y: yi });
  }));

  const cells: AnalysisRow[][][] = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => [] as AnalysisRow[]));
  for (const r of rows) {
    const p = rowIndex.get(r.id);
    if (!p || p.x < 0 || p.y < 0) continue;
    cells[p.y][p.x].push(r);
  }

  return (
    <div className="inline-block">
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="p-1 text-right font-normal text-muted-foreground">↑ {yFeature} \ {xFeature} →</th>
            {[0, 1, 2, 3].map((xi) => (
              <th key={xi} className="p-1 font-mono font-normal text-muted-foreground">
                Q{xi + 1}
                <div>≤{fmtCompact(bx.edges[xi + 1])}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[3, 2, 1, 0].map((yi) => (
            <tr key={yi}>
              <th className="p-1 text-right font-mono font-normal text-muted-foreground">
                Q{yi + 1} ≤{fmtCompact(by.edges[yi + 1])}
              </th>
              {[0, 1, 2, 3].map((xi) => {
                const cell = cells[yi][xi];
                const mix = labelMix(cell);
                const w = mix.winShare;
                const alpha = 0.15 + w * 0.75;
                const bg = cell.length === 0
                  ? 'rgb(148 163 184 / 0.15)'
                  : `rgb(16 185 129 / ${alpha.toFixed(2)})`;
                return (
                  <td key={xi} className="p-0" style={{ background: bg }}>
                    <div className="flex h-16 w-24 flex-col items-center justify-center">
                      <span className="font-mono font-semibold text-foreground">
                        {cell.length === 0 ? '—' : `${(w * 100).toFixed(0)}%`}
                      </span>
                      <span className="text-muted-foreground">n={cell.length}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Grønn fylling = høyere win-share (profitable + profitable_plus / n).
      </p>
    </div>
  );
}
