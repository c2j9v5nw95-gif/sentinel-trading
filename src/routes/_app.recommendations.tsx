import { createFileRoute, Link } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { PageHeader, Card, EmptyState } from '@/components/PageHeader';
import { listLatestBacktestPerSymbol } from '@/lib/calibration/calibration.functions';
import {
  computeCandidateScore,
  type CandidateScoreResult,
  type BtTrust,
} from '@/lib/admission/candidate-score';
import {
  classifySymbol,
  actionLabel,
  actionBadgeClass,
  type ClassifyResult,
  type RecommendationAction,
} from '@/lib/recommendations/classify';

export const Route = createFileRoute('/_app/recommendations')({
  component: RecommendationsPage,
});

const HEALTH_STALE_MIN = 120;

type HealthStatus = 'open' | 'blocked' | 'stale' | 'no_data';

interface RowVM {
  symbol: string;
  isActive: boolean;
  admissionStatus: string | null;
  candidateScore: CandidateScoreResult | null;
  rawCandidateScore: number | null;
  htq: number | null;
  robustness: number | null;
  momentum: number | null;
  calibrationScore: number | null;
  calibrationConfidence: 'low' | 'medium' | 'high' | null;
  hardKills: string[];
  softFailures: string[];
  btTrust: BtTrust;
  btScore: number | null;
  btLabel: string | null;
  btSummary: string | null;
  btNumTrades: number | null;
  btNetPct: number | null;
  btProfitFactor: number | null;
  btWinRate: number | null;
  btMaxDD: number | null;
  healthStatus: HealthStatus | null;
  healthCapturedAt: string | null;
  healthPf: number | null;
  healthNet: number | null;
  healthWr: number | null;
  classification: ClassifyResult;
}

function fmt(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}

function scoreColor(n: number | null | undefined): string {
  if (n == null) return 'text-muted-foreground';
  if (n >= 80) return 'text-emerald-700';
  if (n >= 65) return 'text-green-700';
  if (n >= 50) return 'text-yellow-700';
  if (n >= 35) return 'text-orange-700';
  return 'text-red-700';
}

function ago(ts: string | null): string {
  if (!ts) return '—';
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function RecommendationsPage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState<'all' | 'new' | 'active'>('all');
  const [minScore, setMinScore] = useState<string>('');
  const [tradeOnly, setTradeOnly] = useState(false);
  const [hideCapped, setHideCapped] = useState(false);
  const [showCount, setShowCount] = useState(20);

  // --- queries ---
  const runQ = useQuery({
    queryKey: ['rec-latest-run'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('coin_admission_runs')
        .select('id, started_at, finished_at, status, profile_name')
        .eq('status', 'completed')
        .order('started_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0] ?? null;
    },
    refetchInterval: 30_000,
  });
  const runId = runQ.data?.id ?? null;

  const resultsQ = useQuery({
    enabled: !!runId,
    queryKey: ['rec-results', runId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('coin_admission_results')
        .select('*')
        .eq('run_id', runId!)
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const activeQ = useQuery({
    queryKey: ['rec-active-symbols'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('symbols')
        .select('symbol, enabled')
        .eq('enabled', true);
      if (error) throw error;
      return new Set((data ?? []).map((r) => r.symbol as string));
    },
    refetchInterval: 30_000,
  });

  const symbolList = useMemo(
    () => (resultsQ.data ?? []).map((r: any) => r.symbol as string),
    [resultsQ.data],
  );

  const latestBtQ = useQuery({
    enabled: symbolList.length > 0,
    queryKey: ['rec-bt-latest', runId, symbolList.length],
    queryFn: async () => {
      const CHUNK = 400;
      const merged: Record<string, any> = {};
      for (let i = 0; i < symbolList.length; i += CHUNK) {
        const slice = symbolList.slice(i, i + CHUNK);
        const part = await listLatestBacktestPerSymbol({ data: { symbols: slice } });
        Object.assign(merged, part?.per_symbol ?? {});
      }
      return merged;
    },
  });

  // Health: latest HEALTH_ALL snapshot per active symbol. Also include health
  // thresholds for blocked detection.
  const healthQ = useQuery({
    enabled: !!activeQ.data && activeQ.data.size > 0,
    queryKey: ['rec-health', activeQ.data ? Array.from(activeQ.data).sort().join(',') : ''],
    refetchInterval: 60_000,
    queryFn: async () => {
      const syms = Array.from(activeQ.data ?? []);
      if (syms.length === 0) return { per: {} as Record<string, any>, t: null };
      const { data: strat } = await supabase
        .from('strategies')
        .select('health_min_profit_factor,health_min_net_profit,health_min_winrate')
        .eq('name', 'HEALTH_ALL')
        .eq('tag', '')
        .maybeSingle();
      const t = {
        pf: strat?.health_min_profit_factor != null ? Number(strat.health_min_profit_factor) : null,
        net: strat?.health_min_net_profit != null ? Number(strat.health_min_net_profit) : null,
        wr: strat?.health_min_winrate != null ? Number(strat.health_min_winrate) : null,
      };
      const { data: snaps, error } = await supabase
        .from('health_snapshots')
        .select('symbol,profit_factor,net_profit,winrate,created_at')
        .eq('strategy', 'HEALTH_ALL')
        .eq('tag', '')
        .in('symbol', syms)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      const per: Record<string, any> = {};
      for (const s of snaps ?? []) {
        if (!per[s.symbol as string]) per[s.symbol as string] = s;
      }
      return { per, t };
    },
  });

  // --- assemble VMs ---
  const rows: RowVM[] = useMemo(() => {
    const admissionRows = (resultsQ.data ?? []) as any[];
    const btMap = latestBtQ.data ?? {};
    const active = activeQ.data ?? new Set<string>();
    const healthMap = healthQ.data?.per ?? {};
    const t = healthQ.data?.t ?? null;

    // Build VMs from admission results (will cover all screened symbols).
    const vms: RowVM[] = admissionRows.map((r) => {
      const m = btMap[r.symbol] ?? {};
      const isActive = active.has(r.symbol);
      const btLabel = m.last_label ?? null;
      const btScoreRaw = m.last_bt_score ?? null;
      let btTrust: BtTrust;
      if (btLabel === 'no_trades') btTrust = 'no_trades';
      else if (btScoreRaw == null) btTrust = 'missing';
      else if (m.last_needs_review && m.last_label_source === 'auto') btTrust = 'needs_review';
      else btTrust = 'trusted';

      const cs = computeCandidateScore({
        robustness: r.score,
        htq: r.historical_trend_quality,
        calibration: r.calibration_score ?? null,
        calibrationConfidence: (r.calibration_confidence as any) ?? null,
        btScore: btTrust === 'no_trades' ? null : btScoreRaw,
        btTrust,
        momentum: r.current_momentum_score,
        hardKills: r.hard_kill_rules ?? [],
        fallbackStrategyFit: r.strategy_fit_score ?? null,
      });

      // Health
      const h = healthMap[r.symbol];
      let healthStatus: HealthStatus | null = null;
      let healthCapturedAt: string | null = null;
      let pf: number | null = null, net: number | null = null, wr: number | null = null;
      if (isActive) {
        if (!h) {
          healthStatus = 'no_data';
        } else {
          healthCapturedAt = h.created_at;
          pf = h.profit_factor != null ? Number(h.profit_factor) : null;
          net = h.net_profit != null ? Number(h.net_profit) : null;
          wr = h.winrate != null ? Number(h.winrate) : null;
          const ageMs = Date.now() - new Date(h.created_at).getTime();
          const stale = ageMs > HEALTH_STALE_MIN * 60_000;
          let breach = false;
          if (t?.pf != null && pf != null && pf < t.pf) breach = true;
          if (t?.net != null && net != null && net < t.net) breach = true;
          if (t?.wr != null && wr != null && wr < t.wr) breach = true;
          healthStatus = stale ? 'stale' : breach ? 'blocked' : 'open';
        }
      }

      const input = {
        symbol: r.symbol as string,
        isActive,
        admissionStatus: (r.status as string) ?? null,
        candidateScore: cs,
        hardKills: (r.hard_kill_rules ?? []) as string[],
        softFailures: (r.soft_failures ?? []) as string[],
        htq: r.historical_trend_quality,
        robustness: r.score,
        calibrationConfidence: (r.calibration_confidence as any) ?? null,
        btTrust,
        btScore: btScoreRaw,
        healthStatus,
        healthCapturedAt,
        healthStaleMinutes: HEALTH_STALE_MIN,
      };
      const classification = classifySymbol(input);

      return {
        symbol: r.symbol,
        isActive,
        admissionStatus: r.status ?? null,
        candidateScore: cs,
        rawCandidateScore: cs.rawScore,
        htq: r.historical_trend_quality,
        robustness: r.score,
        momentum: r.current_momentum_score,
        calibrationScore: r.calibration_score ?? null,
        calibrationConfidence: (r.calibration_confidence as any) ?? null,
        hardKills: r.hard_kill_rules ?? [],
        softFailures: r.soft_failures ?? [],
        btTrust,
        btScore: btScoreRaw,
        btLabel,
        btSummary: m.last_summary ?? null,
        btNumTrades: m.last_num_trades ?? null,
        btNetPct: m.last_net_profit_pct ?? null,
        btProfitFactor: m.last_profit_factor ?? null,
        btWinRate: m.last_win_rate_pct ?? null,
        btMaxDD: m.last_max_drawdown_pct ?? null,
        healthStatus,
        healthCapturedAt,
        healthPf: pf,
        healthNet: net,
        healthWr: wr,
        classification,
      } satisfies RowVM;
    });

    // Add any active symbols that DON'T have admission data — surface as "needs screening".
    const screened = new Set(vms.map((v) => v.symbol));
    for (const sym of active) {
      if (screened.has(sym)) continue;
      const stub: ClassifyResult = {
        action: 'watch_closely',
        candidateTier: null,
        reason: 'Active symbol without recent admission data — run screener to evaluate.',
        positives: [],
        negatives: ['No admission data'],
        healthStale: false,
        healthMissing: true,
      };
      vms.push({
        symbol: sym,
        isActive: true,
        admissionStatus: null,
        candidateScore: null,
        rawCandidateScore: null,
        htq: null,
        robustness: null,
        momentum: null,
        calibrationScore: null,
        calibrationConfidence: null,
        hardKills: [],
        softFailures: [],
        btTrust: 'missing',
        btScore: null,
        btLabel: null,
        btSummary: null,
        btNumTrades: null,
        btNetPct: null,
        btProfitFactor: null,
        btWinRate: null,
        btMaxDD: null,
        healthStatus: 'no_data',
        healthCapturedAt: null,
        healthPf: null,
        healthNet: null,
        healthWr: null,
        classification: stub,
      });
    }
    return vms;
  }, [resultsQ.data, latestBtQ.data, activeQ.data, healthQ.data]);

  // Filtering helpers
  const passesFilters = (r: RowVM): boolean => {
    if (showFilter === 'new' && r.isActive) return false;
    if (showFilter === 'active' && !r.isActive) return false;
    const min = parseFloat(minScore);
    if (Number.isFinite(min) && (r.candidateScore?.score ?? -1) < min) return false;
    if (tradeOnly && !(r.candidateScore?.tradeEligible ?? false)) return false;
    if (hideCapped && r.candidateScore?.hardKillCapped) return false;
    return true;
  };

  const buckets = useMemo(() => {
    const newCandidates: RowVM[] = [];
    const keep: RowVM[] = [];
    const watch: RowVM[] = [];
    const red: RowVM[] = [];
    for (const r of rows) {
      if (!passesFilters(r)) continue;
      switch (r.classification.action) {
        case 'add_candidate': newCandidates.push(r); break;
        case 'keep_active': keep.push(r); break;
        case 'watch_closely': watch.push(r); break;
        case 'consider_remove': red.push(r); break;
      }
    }
    const byScore = (a: RowVM, b: RowVM) =>
      (b.candidateScore?.score ?? -1) - (a.candidateScore?.score ?? -1)
      || (b.calibrationScore ?? -1) - (a.calibrationScore ?? -1)
      || (b.btScore ?? -1) - (a.btScore ?? -1);
    newCandidates.sort(byScore);
    keep.sort(byScore);
    // Watch & red: worst first
    watch.sort((a, b) => (a.candidateScore?.score ?? 999) - (b.candidateScore?.score ?? 999));
    red.sort((a, b) => (a.candidateScore?.score ?? 999) - (b.candidateScore?.score ?? 999));
    return { newCandidates, keep, watch, red };
  }, [rows, showFilter, minScore, tradeOnly, hideCapped]);

  const totals = useMemo(() => {
    const activeAll = rows.filter((r) => r.isActive);
    const staleMissing = activeAll.filter((r) => r.classification.healthStale || r.classification.healthMissing).length;
    return {
      activeTotal: activeAll.length,
      newCount: buckets.newCandidates.length,
      keepCount: buckets.keep.length,
      watchCount: buckets.watch.length,
      redCount: buckets.red.length,
      staleMissing,
    };
  }, [rows, buckets]);

  const runStale = runQ.data?.started_at
    ? (Date.now() - new Date(runQ.data.started_at).getTime()) > 24 * 60 * 60 * 1000
    : true;

  // --- render ---
  return (
    <div className="space-y-4">
      <PageHeader
        title="Recommendation Center"
        subtitle="Decision support · sorts coins into Add / Keep / Watch / Red flag. No changes to execution or active symbols."
      />

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-7">
        <SummaryCard label="New candidates" value={totals.newCount} tone="blue" />
        <SummaryCard label="Active healthy" value={totals.keepCount} tone="green" />
        <SummaryCard label="Watch closely" value={totals.watchCount} tone="yellow" />
        <SummaryCard label="Red flags" value={totals.redCount} tone="red" />
        <SummaryCard label="Active total" value={totals.activeTotal} tone="neutral" />
        <SummaryCard label="Stale/missing health" value={totals.staleMissing} tone={totals.staleMissing > 0 ? 'yellow' : 'neutral'} />
        <SummaryCard
          label="Latest screener run"
          value={runQ.data?.started_at ? ago(runQ.data.started_at) : '—'}
          tone={runStale ? 'yellow' : 'neutral'}
          small
        />
      </div>

      {runStale && (
        <Card className="border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-900">
          Admission data may be stale — run the screener again from the{' '}
          <Link to="/admission" className="underline">Admission page</Link>.
        </Card>
      )}

      {/* Filters */}
      <Card className="flex flex-wrap items-end gap-3 px-3 py-3 text-xs">
        <div>
          <div className="mb-0.5 text-muted-foreground">Show</div>
          <select className="rounded border border-border bg-background px-2 py-1" value={showFilter} onChange={(e) => setShowFilter(e.target.value as any)}>
            <option value="all">All</option>
            <option value="new">New candidates</option>
            <option value="active">Active only</option>
          </select>
        </div>
        <div>
          <div className="mb-0.5 text-muted-foreground">Min Candidate Score</div>
          <input type="number" className="w-20 rounded border border-border bg-background px-2 py-1" value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="—" />
        </div>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} />
          Trade eligible only
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={hideCapped} onChange={(e) => setHideCapped(e.target.checked)} />
          Hide hard-kill capped
        </label>
        <div className="ml-auto">
          <div className="mb-0.5 text-muted-foreground">New candidates limit</div>
          <select className="rounded border border-border bg-background px-2 py-1" value={showCount} onChange={(e) => setShowCount(parseInt(e.target.value, 10))}>
            <option value={10}>Top 10</option>
            <option value={20}>Top 20</option>
            <option value={50}>Top 50</option>
            <option value={9999}>All</option>
          </select>
        </div>
      </Card>

      {(resultsQ.isLoading || activeQ.isLoading) ? (
        <Card><EmptyState title="Loading recommendations…" /></Card>
      ) : !runId ? (
        <Card><EmptyState title="No completed admission run yet" hint="Run the screener from the Admission page to populate recommendations." /></Card>
      ) : (
        <>
          <Section
            title="Recommended New Coins"
            subtitle="Coins not in the active universe that look strong in the screener."
            rows={buckets.newCandidates.slice(0, showCount)}
            totalCount={buckets.newCandidates.length}
            expanded={expanded}
            onExpand={(s) => setExpanded(expanded === s ? null : s)}
          />
          <Section
            title="Active — Keep / Healthy"
            subtitle="Active symbols with a strong profile and no health concerns."
            rows={buckets.keep}
            totalCount={buckets.keep.length}
            expanded={expanded}
            onExpand={(s) => setExpanded(expanded === s ? null : s)}
          />
          <Section
            title="Active — Watch Closely"
            subtitle="Active symbols with weakened score, low confidence, or soft warnings."
            rows={buckets.watch}
            totalCount={buckets.watch.length}
            expanded={expanded}
            onExpand={(s) => setExpanded(expanded === s ? null : s)}
          />
          <Section
            title="Active — Red Flag / Consider Remove"
            subtitle="Active symbols with hard kills, severe health alerts, or very low score. Review manually — no automatic action."
            rows={buckets.red}
            totalCount={buckets.red.length}
            expanded={expanded}
            onExpand={(s) => setExpanded(expanded === s ? null : s)}
            tone="red"
          />
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label, value, tone, small,
}: { label: string; value: string | number; tone: 'green' | 'yellow' | 'red' | 'blue' | 'neutral'; small?: boolean }) {
  const toneCls = {
    green: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-900',
    yellow: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-900',
    red: 'border-red-500/40 bg-red-500/10 text-red-900',
    blue: 'border-blue-500/40 bg-blue-500/10 text-blue-900',
    neutral: 'border-border bg-card text-foreground',
  }[tone];
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className={small ? 'mt-0.5 text-sm font-semibold' : 'mt-0.5 text-xl font-semibold'}>{value}</div>
    </div>
  );
}

function Section({
  title, subtitle, rows, totalCount, expanded, onExpand, tone,
}: {
  title: string;
  subtitle: string;
  rows: RowVM[];
  totalCount: number;
  expanded: string | null;
  onExpand: (s: string) => void;
  tone?: 'red';
}) {
  return (
    <Card className="overflow-hidden">
      <div className={`flex items-baseline justify-between border-b border-border px-3 py-2 ${tone === 'red' ? 'bg-red-500/5' : ''}`}>
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <div className="text-xs text-muted-foreground">{rows.length} of {totalCount}</div>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">No symbols in this bucket.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-1.5">Symbol</th>
              <th className="px-2 py-1.5">Action</th>
              <th className="px-2 py-1.5 text-right">Cand</th>
              <th className="px-2 py-1.5">Status</th>
              <th className="px-2 py-1.5 text-right">Robust</th>
              <th className="px-2 py-1.5 text-right">HTQ</th>
              <th className="px-2 py-1.5 text-right">Calib</th>
              <th className="px-2 py-1.5 text-right">BT</th>
              <th className="px-2 py-1.5">Health</th>
              <th className="px-2 py-1.5">Reason</th>
              <th className="px-1 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.symbol}>
                <tr className="border-b border-border/60 hover:bg-muted/30">
                  <td className="px-3 py-1.5">
                    <Link to="/admission" className="font-mono font-semibold hover:underline">{r.symbol}</Link>
                    {r.isActive && <span className="ml-1 rounded bg-emerald-500/20 px-1 text-[9px] text-emerald-700">ACTIVE</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${actionBadgeClass(r.classification.action)}`}>
                      {actionLabel(r.classification.action)}
                    </span>
                    {r.classification.action === 'add_candidate' && r.classification.candidateTier && (
                      <span className="ml-1 text-[9px] uppercase text-muted-foreground">{r.classification.candidateTier}</span>
                    )}
                  </td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${scoreColor(r.candidateScore?.score)}`}>
                    {fmt(r.candidateScore?.score, 0)}
                    {r.candidateScore?.hardKillCapped && <span className="ml-0.5 text-red-700" title="hard-kill capped">⛔</span>}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{r.admissionStatus ?? '—'}</td>
                  <td className={`px-2 py-1.5 text-right ${scoreColor(r.robustness)}`}>{fmt(r.robustness, 0)}</td>
                  <td className={`px-2 py-1.5 text-right ${scoreColor(r.htq)}`}>{fmt(r.htq, 0)}</td>
                  <td className={`px-2 py-1.5 text-right ${scoreColor(r.calibrationScore)}`}>
                    {fmt(r.calibrationScore, 0)}
                    {r.calibrationConfidence && <span className="ml-0.5 text-[9px] text-muted-foreground">{r.calibrationConfidence[0]}</span>}
                  </td>
                  <td className={`px-2 py-1.5 text-right ${scoreColor(r.btScore)}`}>
                    {r.btTrust === 'no_trades' ? <span className="text-muted-foreground">N/T</span> : fmt(r.btScore, 0)}
                    {r.btTrust === 'needs_review' && <span className="ml-0.5 text-yellow-700" title="needs review">⚠</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.isActive ? (
                      <span className={
                        r.healthStatus === 'open' ? 'text-emerald-700'
                        : r.healthStatus === 'blocked' ? 'text-red-700'
                        : 'text-yellow-700'
                      }>
                        {r.healthStatus ?? '—'}
                        <span className="ml-1 text-[10px] text-muted-foreground">{ago(r.healthCapturedAt)}</span>
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground max-w-[28ch] truncate" title={r.classification.reason}>
                    {r.classification.reason}
                  </td>
                  <td className="px-1 py-1.5">
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => onExpand(r.symbol)}
                    >
                      {expanded === r.symbol ? '▾' : '▸'}
                    </button>
                  </td>
                </tr>
                {expanded === r.symbol && <ExpandedRow row={r} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ExpandedRow({ row }: { row: RowVM }) {
  return (
    <tr className="border-b border-border/60 bg-muted/20">
      <td colSpan={11} className="px-4 py-3">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Candidate breakdown */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Candidate Score breakdown</div>
            {row.candidateScore?.components.length ? (
              <table className="w-full text-[11px]">
                <tbody>
                  {row.candidateScore.components.map((c) => (
                    <tr key={c.key}>
                      <td className="py-0.5 text-muted-foreground">{c.label}</td>
                      <td className="py-0.5 text-right">{c.value != null ? c.value.toFixed(0) : '—'}</td>
                      <td className="py-0.5 text-right text-muted-foreground">w {c.effectiveWeight.toFixed(0)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border/40">
                    <td className="py-0.5 text-muted-foreground">Final</td>
                    <td className={`py-0.5 text-right font-semibold ${scoreColor(row.candidateScore.score)}`}>{fmt(row.candidateScore.score, 0)}</td>
                    <td className="py-0.5 text-right text-muted-foreground">{row.candidateScore.hardKillCapped ? 'capped' : ''}</td>
                  </tr>
                </tbody>
              </table>
            ) : <div className="text-[11px] text-muted-foreground">No score data.</div>}
          </div>

          {/* Backtest summary */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Last backtest</div>
            <table className="w-full text-[11px]">
              <tbody>
                <tr><td className="py-0.5 text-muted-foreground">Label</td><td className="py-0.5 text-right">{row.btLabel ?? '—'}</td></tr>
                <tr><td className="py-0.5 text-muted-foreground">BT Score</td><td className={`py-0.5 text-right ${scoreColor(row.btScore)}`}>{fmt(row.btScore, 0)}</td></tr>
                <tr><td className="py-0.5 text-muted-foreground">Trades</td><td className="py-0.5 text-right">{row.btNumTrades ?? '—'}</td></tr>
                <tr><td className="py-0.5 text-muted-foreground">Win %</td><td className="py-0.5 text-right">{fmt(row.btWinRate, 1)}</td></tr>
                <tr><td className="py-0.5 text-muted-foreground">Net %</td><td className="py-0.5 text-right">{fmt(row.btNetPct, 1)}</td></tr>
                <tr><td className="py-0.5 text-muted-foreground">PF</td><td className="py-0.5 text-right">{fmt(row.btProfitFactor, 2)}</td></tr>
                <tr><td className="py-0.5 text-muted-foreground">Max DD %</td><td className="py-0.5 text-right">{fmt(row.btMaxDD, 1)}</td></tr>
              </tbody>
            </table>
            {row.btSummary && <div className="mt-1 text-[11px] italic text-muted-foreground">{row.btSummary}</div>}
          </div>

          {/* Health */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Health · Control Center</div>
            {row.isActive ? (
              <table className="w-full text-[11px]">
                <tbody>
                  <tr><td className="py-0.5 text-muted-foreground">Active</td><td className="py-0.5 text-right text-emerald-700">yes</td></tr>
                  <tr><td className="py-0.5 text-muted-foreground">Status</td><td className="py-0.5 text-right">{row.healthStatus ?? '—'}</td></tr>
                  <tr><td className="py-0.5 text-muted-foreground">Captured</td><td className="py-0.5 text-right">{ago(row.healthCapturedAt)}</td></tr>
                  <tr><td className="py-0.5 text-muted-foreground">PF · Net · WR</td>
                    <td className="py-0.5 text-right">{fmt(row.healthPf, 2)} · {fmt(row.healthNet, 1)} · {fmt(row.healthWr, 1)}</td></tr>
                </tbody>
              </table>
            ) : <div className="text-[11px] text-muted-foreground">Not active.</div>}
            {(row.classification.healthStale || row.classification.healthMissing) && (
              <div className="mt-1 text-[11px] text-yellow-700">
                {row.classification.healthMissing ? 'Health alert missing.' : 'Health alert stale.'}
              </div>
            )}
          </div>

          {/* Reason / drivers / rules */}
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recommendation explanation</div>
            <div className="text-[11px]">{row.classification.reason}</div>
            {row.classification.positives.length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-wider text-emerald-700">Positives</div>
                <ul className="text-[11px] text-muted-foreground">
                  {row.classification.positives.map((p, i) => <li key={i}>+ {p}</li>)}
                </ul>
              </div>
            )}
            {row.classification.negatives.length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-wider text-red-700">Negatives</div>
                <ul className="text-[11px] text-muted-foreground">
                  {row.classification.negatives.map((p, i) => <li key={i}>− {p}</li>)}
                </ul>
              </div>
            )}
            {row.hardKills.length > 0 && (
              <div className="mt-2 text-[11px] text-red-700">Hard kills: {row.hardKills.join(', ')}</div>
            )}
            {row.softFailures.length > 0 && (
              <div className="mt-1 text-[11px] text-yellow-700">Soft warnings: {row.softFailures.join(', ')}</div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
