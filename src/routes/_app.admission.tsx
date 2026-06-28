import { createFileRoute } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { startAdmissionRun } from '@/lib/admission/admission.functions';
import {
  listLatestBacktestPerSymbol,
  listBacktestResults,
  recalcCalibrationForSymbol,
  getBacktestScreenshotUrl,
} from '@/lib/calibration/calibration.functions';
import { PageHeader, Card, EmptyState } from '@/components/PageHeader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BacktestResultDialog, type BacktestDialogPrefill } from '@/components/calibration/BacktestResultDialog';
import {
  computeCandidateScore,
  candidateBucketBadgeClass,
  candidateBucketBarClass,
  candidateBucketLabel,
  type CandidateScoreResult,
  type CandidateBucket,
  type BtTrust,
} from '@/lib/admission/candidate-score';




const COLUMN_TOOLTIPS: Record<string, string> = {
  Symbol: 'Bybit perp-symbol (LinearPerpetual USDT).',
  Status: 'Admission-resultat: Approved / Watchlist / Trend Candidate / Rejected. Bestemmes av modus (Strict eller Trend Adjusted), hard kill rules, soft requirements og evt. HTQ-kompensasjon.',
  Class: 'Trend Classification fra HTQ v2: Trend Friendly (≥75), Neutral (55–74), Choppy (<55).',
  Fit: 'Strategy Fit Score = 0.6 × Robustness + 0.4 × HTQ. Brukes til Trend Adjusted-status.',
  Robust: 'Robustness Score (0–100). Vektet sum av Rank, Turnover (24h/7d), OI, Spread, Age og Wick Risk.',
  HTQ: 'Historical Trend Quality (0–100). Måler historisk trendvennlighet over valgt lookback. Komponenter: 1h Persistence (30%), MTF Alignment (20%), 5m Tradeability (20%), Flip Frequency (15%), Smoothness (10%), Wick Penalty (5%).',
  Mom: 'Current Momentum Score (0–100). Live EMA-alignment på 5m/15m/1h + ADX/ATR/Chop/Pullback på siste candle. Kun informativ — påvirker ikke status.',
  Rank: 'CoinGecko market-cap rank for base-coin. Lavere = større.',
  '24h TO': '24-timers turnover i USDT fra Bybit /v5/market/tickers.',
  OI: 'Open Interest Value (USDT) fra Bybit tickers.',
  Spread: 'Bid/ask-spread i basispunkter ((ask − bid) / mid × 10000).',
  Age: 'Dager siden Bybit listing (launchTime).',
  'Wick%': 'Største 1h wick som % av high (max (high − low) / high på siste 30d hourly). Lav er bra.',
  'Hard Kills': 'Brudd som ALDRI kan overstyres (f.eks. for ny, for lav likviditet, ekstreme wicks). Trigger automatisk Rejected.',
  Soft: 'Krav som KAN lempes ved høy HTQ i Trend Adjusted-modus (f.eks. lavere rank/turnover-grenser).',
  Reason: 'Kort menneskelig forklaring på statusen (hvilke regler som slo inn / hvorfor lempet).',
  'Last BT Class': 'Siste registrerte backtest-label for symbolet (test_date desc, deretter created_at desc).',
  'Last BT Date': 'Test-dato på siste registrerte backtest (kan være satt manuelt).',
  'Last BT Ver': 'Strategy version brukt på siste registrerte backtest.',
  '# BT': 'Antall backtest-observasjoner registrert for dette symbolet (append-only).',
  'BT Score': 'Backtest Quality Score (0–100) for siste backtest av dette symbolet. no_trades → N/A. Marker med ⚠ hvis needs_review.',
  'BT Class': 'Klassifisering av siste backtest. no_trades vises som "No Setup".',
  'BT Summary': 'Kort menneskelig oppsummering av siste backtest (drivers/safety).',
  'Calib Score': 'Calibration Score: hvor mye dagens coin-profil ligner historiske profitable observasjoner (kNN).',
  'Priority': 'Candidate Priority Score (0–100) — sekundær prioriteringsscore. Endrer IKKE admission-status.',
  'Candidate': 'Coin Candidate Score (0–100) = samlet kvalitetsvurdering av coinen for denne strategien. Vektet sum: Market 25% · HTQ 25% · Calib 20% · BT 20% · Mom 10%. Manglende komponenter redistribueres — gir IKKE 0-straff. Hard kill capper score til ≤49 og blokkerer trading-egnethet, men endrer IKKE admission-status eller execution.',
};


function HeaderCell({
  label,
  align,
  className,
  sortKey,
  activeSort,
  onSort,
}: {
  label: string;
  align?: 'right';
  className?: string;
  sortKey?: SortKey;
  activeSort?: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSort?: (k: SortKey) => void;
}) {
  const tip = COLUMN_TOOLTIPS[label];
  const base = `py-1 pr-2${align === 'right' ? ' text-right' : ''}${className ? ' ' + className : ''}`;
  const isActive = !!sortKey && activeSort?.key === sortKey;
  const arrow = isActive ? (activeSort!.dir === 'desc' ? ' ▼' : ' ▲') : '';
  const labelNode = (
    <span
      className={
        sortKey
          ? `cursor-pointer select-none hover:text-foreground ${isActive ? 'text-foreground font-semibold' : ''}`
          : ''
      }
      onClick={sortKey && onSort ? () => onSort(sortKey) : undefined}
    >
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-4">
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
            {tip}
          </TooltipContent>
        </Tooltip>
      ) : (
        label
      )}
      {arrow && <span className="ml-0.5 text-[10px]">{arrow}</span>}
    </span>
  );
  return <th className={base}>{labelNode}</th>;
}

type SortKey =
  | 'symbol'
  | 'status'
  | 'class'
  | 'fit'
  | 'robust'
  | 'htq'
  | 'momentum'
  | 'rank'
  | 'turnover_24h'
  | 'oi'
  | 'spread'
  | 'age'
  | 'wick'
  | 'hard_kills'
  | 'soft'
  | 'reason'
  | 'last_bt_class'
  | 'last_bt_date'
  | 'last_bt_ver'
  | 'bt_count'
  | 'bt_score'
  | 'calib_score'
  | 'calibrated_fit'
  | 'priority'
  | 'candidate_score';


const STATUS_ORDER: Record<string, number> = { approved: 0, trend_candidate: 1, watchlist: 2, rejected: 3 };
const CLASS_ORDER: Record<string, number> = { trend_friendly: 0, neutral: 1, choppy: 2 };
const LABEL_ORDER: Record<string, number> = {
  profitable_plus: 0,
  profitable: 1,
  marginal: 2,
  rejected_backtest: 3,
  no_trades: 4,
};

function sortValue(r: Result, k: SortKey): number | string | null {
  switch (k) {
    case 'symbol': return r.symbol;
    case 'status': return STATUS_ORDER[r.status] ?? 99;
    case 'class': return r.trend_classification ? CLASS_ORDER[r.trend_classification] : 99;
    case 'fit': return r.strategy_fit_score;
    case 'robust': return r.score;
    case 'htq': return r.historical_trend_quality;
    case 'momentum': return r.current_momentum_score;
    case 'rank': return r.rank;
    case 'turnover_24h': return r.turnover_24h;
    case 'oi': return r.open_interest_value;
    case 'spread': return r.spread_bps;
    case 'age': return r.listing_age_days;
    case 'wick': return r.max_1h_drop_pct;
    case 'hard_kills': return r.hard_kill_rules?.length ?? 0;
    case 'soft': return r.soft_failures?.length ?? 0;
    case 'reason': return r.admission_reason ?? '';
    case 'last_bt_class': return r.last_backtest_label ? (LABEL_ORDER[r.last_backtest_label] ?? 99) : 99;
    case 'last_bt_date': return r.last_backtest_date ?? '';
    case 'last_bt_ver': return r.last_backtest_strategy_version ?? '';
    case 'bt_count': return r.backtest_count ?? 0;
    case 'bt_score':
      // no_trades treated as null (sinks to bottom), so it never looks "weak".
      return r.last_backtest_label === 'no_trades' ? null : (r.last_bt_score ?? null);
    case 'calib_score': return r.calibration_score ?? null;
    case 'calibrated_fit': return r.calibrated_strategy_fit ?? null;
    case 'priority': return r.candidate_priority_score ?? null;
    case 'candidate_score': return r.candidate_score?.score ?? null;
  }
}

const DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = {
  symbol: 'asc', status: 'asc', class: 'asc', fit: 'desc', robust: 'desc',
  htq: 'desc', momentum: 'desc', rank: 'asc', turnover_24h: 'desc', oi: 'desc',
  spread: 'asc', age: 'desc', wick: 'asc', hard_kills: 'desc', soft: 'desc', reason: 'asc',
  last_bt_class: 'asc', last_bt_date: 'desc', last_bt_ver: 'asc', bt_count: 'desc',
  bt_score: 'desc', calib_score: 'desc', calibrated_fit: 'desc', priority: 'desc',
  candidate_score: 'desc',
};


// ---- Backtest Quality + Candidate Priority helpers ---------------------------

function btScoreBucket(score: number): 'strong' | 'good' | 'mixed' | 'weak' {
  if (score >= 80) return 'strong';
  if (score >= 65) return 'good';
  if (score >= 40) return 'mixed';
  return 'weak';
}

function btBucketBadgeClass(b: 'strong' | 'good' | 'mixed' | 'weak' | 'no_setup'): string {
  switch (b) {
    case 'strong': return 'bg-emerald-500/20 text-emerald-700';
    case 'good': return 'bg-green-500/20 text-green-700';
    case 'mixed': return 'bg-yellow-500/20 text-yellow-700';
    case 'weak': return 'bg-red-500/20 text-red-700';
    case 'no_setup': return 'bg-slate-400/20 text-slate-700';
  }
}

function btClassDisplay(label: string | null | undefined): string {
  if (!label) return '—';
  if (label === 'no_trades') return 'No Setup';
  return label;
}

/**
 * Freshness / review-quality proxy used in Candidate Priority blend.
 * Pure review trust signal — does not include calendar age in v1.
 */
function reviewQuality(r: Result): number {
  if (r.last_label_source === 'manual_override') return 100;
  if (r.last_needs_review) return 40;
  if (r.last_label_source === 'auto') return 80;
  return 60;
}

/**
 * Candidate Priority Score (v1) — pure surfacing/sort metric.
 * NEVER feeds into admission status or execution.
 */
function computeCandidatePriority(r: Result): number | null {
  const fit = r.calibrated_strategy_fit ?? r.strategy_fit_score ?? null;
  const calib = r.calibration_score ?? null;
  const hasCalib = calib != null;
  const isNoTrades = r.last_backtest_label === 'no_trades';
  const btScore = isNoTrades ? null : (r.last_bt_score ?? null);
  const hasBT = btScore != null;
  const trusted = hasBT && !(r.last_needs_review && r.last_label_source === 'auto');
  const rq = reviewQuality(r);

  if (!hasCalib) {
    return r.strategy_fit_score ?? null;
  }
  if (hasBT && trusted) {
    if (fit == null) return null;
    return 0.45 * fit + 0.30 * calib! + 0.15 * btScore! + 0.10 * rq;
  }
  if (hasBT && !trusted) {
    if (fit == null) return null;
    return 0.50 * fit + 0.35 * calib! + 0.075 * btScore! + 0.075 * rq;
  }
  // No backtest OR no_trades → use calibration + fit only
  if (fit == null) return null;
  return 0.60 * fit + 0.40 * calib!;
}

// ---- BT cell + detail components ---------------------------------------------

function BtScoreCell({ r }: { r: Result }) {
  const isNoTrades = r.last_backtest_label === 'no_trades';
  if (isNoTrades) {
    return (
      <td className="py-1 pr-2 text-right">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-xs ${btBucketBadgeClass('no_setup')}`}
          title="No trades during test period — strategy found no valid setup"
        >
          N/A
        </span>
      </td>
    );
  }
  const s = r.last_bt_score;
  if (s == null) {
    return <td className="py-1 pr-2 text-right text-muted-foreground">—</td>;
  }
  const bucket = btScoreBucket(s);
  const pct = Math.max(0, Math.min(100, s));
  const warn = r.last_needs_review && r.last_label_source === 'auto';
  return (
    <td className="py-1 pr-2 text-right">
      <div className="inline-flex flex-col items-end gap-0.5 min-w-[64px]">
        <div className="flex items-center gap-1">
          <span className={`rounded px-1.5 py-0.5 text-xs font-mono font-semibold ${btBucketBadgeClass(bucket)}`}>
            {s.toFixed(0)}
          </span>
          {warn && (
            <span className="text-yellow-600" title="Backtest label needs review — score may be unreliable.">⚠</span>
          )}
        </div>
        <div className="h-1 w-16 rounded bg-muted overflow-hidden">
          <div
            className={
              bucket === 'strong' ? 'h-full bg-emerald-500'
              : bucket === 'good' ? 'h-full bg-green-500'
              : bucket === 'mixed' ? 'h-full bg-yellow-500'
              : 'h-full bg-red-500'
            }
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </td>
  );
}

function BtClassCell({ r }: { r: Result }) {
  const label = r.last_backtest_label;
  if (!label) return <td className="py-1 pr-2 text-xs text-muted-foreground">—</td>;
  const display = btClassDisplay(label);
  const cls =
    label === 'profitable_plus' ? 'bg-emerald-500/20 text-emerald-700'
    : label === 'profitable' ? 'bg-green-500/20 text-green-700'
    : label === 'marginal' ? 'bg-yellow-500/20 text-yellow-700'
    : label === 'rejected_backtest' ? 'bg-red-500/20 text-red-700'
    : 'bg-slate-400/20 text-slate-700';
  return (
    <td className="py-1 pr-2 text-xs">
      <span className={`rounded px-1.5 py-0.5 ${cls}`}>{display}</span>
      {r.last_label_source === 'manual_override' && (
        <span className="ml-1 text-[10px] text-muted-foreground">✓</span>
      )}
    </td>
  );
}

function LastBacktestDetail({ r }: { r: Result }) {
  const hasAny =
    r.last_backtest_label != null ||
    r.last_bt_score != null ||
    r.last_num_trades != null;
  if (!hasAny) return null;
  const isNoTrades = r.last_backtest_label === 'no_trades';
  const warn = r.last_needs_review && r.last_label_source === 'auto';
  const pos = Array.isArray(r.last_positive_drivers) ? r.last_positive_drivers : [];
  const neg = Array.isArray(r.last_negative_drivers) ? r.last_negative_drivers : [];
  const safety = Array.isArray(r.last_safety_overrides) ? r.last_safety_overrides : [];
  const hasDiagnostics = pos.length > 0 || neg.length > 0 || safety.length > 0 || !!r.last_bt_summary;
  return (
    <div className="mt-3 rounded border bg-background p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h4 className="font-semibold text-sm">Last Backtest</h4>
        <span className="text-muted-foreground">{r.last_backtest_date ?? '—'}</span>
        <span className="text-muted-foreground">{r.last_backtest_strategy_version ?? ''}</span>
        {warn && (
          <span className="rounded bg-yellow-500/20 text-yellow-700 px-1.5 py-0.5">
            ⚠ Backtest label needs review — score may be unreliable.
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div>
          <div className="text-muted-foreground">BT Score</div>
          <div className="font-mono font-semibold">
            {isNoTrades ? 'N/A' : (r.last_bt_score != null ? r.last_bt_score.toFixed(1) : '—')}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Confirmed Label</div>
          <div>{btClassDisplay(r.last_backtest_label)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Auto Suggested</div>
          <div>{btClassDisplay(r.last_auto_suggested_label)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Source / Review</div>
          <div>
            {r.last_label_source ?? '—'}
            {r.last_needs_review ? <span className="ml-1 text-yellow-600">· needs review</span> : null}
          </div>
        </div>
      </div>
      {hasDiagnostics ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <div className="text-muted-foreground mb-1">Summary</div>
            <div>{r.last_bt_summary ?? '—'}</div>
          </div>
          <div>
            <div className="text-muted-foreground mb-1">Positive drivers</div>
            {pos.length === 0 ? <div className="text-muted-foreground">—</div> : (
              <ul className="list-disc pl-4">
                {pos.map((d: any, i: number) => (
                  <li key={i}>{typeof d === 'string' ? d : (d?.label ?? d?.reason ?? JSON.stringify(d))}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-muted-foreground mb-1">Negative drivers</div>
            {neg.length === 0 ? <div className="text-muted-foreground">—</div> : (
              <ul className="list-disc pl-4">
                {neg.map((d: any, i: number) => (
                  <li key={i}>{typeof d === 'string' ? d : (d?.label ?? d?.reason ?? JSON.stringify(d))}</li>
                ))}
              </ul>
            )}
          </div>
          {safety.length > 0 && (
            <div className="md:col-span-3">
              <div className="text-muted-foreground mb-1">Safety overrides</div>
              <div className="flex flex-wrap gap-1">
                {safety.map((s, i) => (
                  <span key={i} className="rounded bg-red-500/15 text-red-700 px-1.5 py-0.5">{s}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground mb-3">No diagnostics available</div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Net Profit %" value={r.last_net_profit_pct} dp={2} />
        <Metric label="Normalized Net %" value={r.last_normalized_net_profit_pct} dp={2} />
        <Metric label="Leverage-adj Net %" value={r.last_leverage_adjusted_net_profit_pct} dp={2} />
        <Metric label="Profit Factor" value={r.last_profit_factor} dp={2} />
        <Metric label="Win Rate %" value={r.last_win_rate_pct} dp={1} />
        <Metric label="Max Drawdown %" value={r.last_max_drawdown_pct} dp={2} />
        <Metric label="Trades" value={r.last_num_trades} dp={0} />
        {r.last_needs_review_reason && (
          <div>
            <div className="text-muted-foreground">Review reason</div>
            <div>{r.last_needs_review_reason}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, dp }: { label: string; value: number | null | undefined; dp: number }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono">{value == null || !Number.isFinite(value) ? '—' : value.toFixed(dp)}</div>
    </div>
  );
}


export const Route = createFileRoute('/_app/admission')({
  component: AdmissionPage,
});

type Profile = {
  id: string;
  name: string;
  description: string | null;
  thresholds: Record<string, number>;
  weights: Record<string, number>;
};

type Run = {
  id: string;
  started_at: string;
  finished_at: string | null;
  profile_name: string;
  status: string;
  symbols_total: number | null;
  progress_done: number | null;
  approved_n: number | null;
  watchlist_n: number | null;
  rejected_n: number | null;
  error: string | null;
  admission_mode: string | null;
  include_trend_quality: boolean | null;
};

type Result = {
  id: string;
  symbol: string;
  status: 'approved' | 'watchlist' | 'trend_candidate' | 'rejected';
  score: number | null;
  trend_score: number | null;
  strategy_fit_score: number | null;
  strategy_fit_label: string | null;
  admission_reason: string | null;
  admission_mode: string | null;
  hard_kill_rules: string[] | null;
  soft_failures: string[] | null;
  rank: number | null;
  turnover_24h: number | null;
  turnover_7d_median: number | null;
  open_interest_value: number | null;
  spread_bps: number | null;
  listing_age_days: number | null;
  funding_rate: number | null;
  max_1h_drop_pct: number | null;
  wick_risk_score: number | null;
  kill_rules_triggered: string[] | null;
  components: Record<string, number> | null;
  trend_components: Record<string, number> | null;
  historical_trend_quality: number | null;
  htq_components: Record<string, number> | null;
  htq_lookback_days: number | null;
  htq_mode: string | null;
  trend_classification: 'trend_friendly' | 'neutral' | 'choppy' | null;
  htq_reason: string | null;
  current_momentum_score: number | null;
  current_momentum_components: Record<string, number> | null;
  fetch_error: string | null;
  // Calibration (best-effort, may be absent)
  calibration_score?: number | null;
  calibration_label?: string | null;
  calibration_confidence?: string | null;
  calibration_status?: string | null;
  calibration_reason?: string | null;
  calibrated_strategy_fit?: number | null;
  calibration_computed_at?: string | null;
  // Augmented client-side from listLatestBacktestPerSymbol
  last_backtest_label?: string | null;
  last_backtest_date?: string | null;
  last_backtest_strategy_version?: string | null;
  backtest_count?: number;
  last_bt_score?: number | null;
  last_auto_suggested_label?: string | null;
  last_label_source?: string | null;
  last_needs_review?: boolean | null;
  last_needs_review_reason?: string | null;
  last_bt_summary?: string | null;
  last_positive_drivers?: any;
  last_negative_drivers?: any;
  last_safety_overrides?: string[] | null;
  last_net_profit_pct?: number | null;
  last_normalized_net_profit_pct?: number | null;
  last_leverage_adjusted_net_profit_pct?: number | null;
  last_profit_factor?: number | null;
  last_win_rate_pct?: number | null;
  last_max_drawdown_pct?: number | null;
  last_num_trades?: number | null;
  // Computed client-side
  candidate_priority_score?: number | null;
  candidate_score?: CandidateScoreResult | null;
};


type StatusFilter = 'all' | 'approved' | 'watchlist' | 'trend_candidate' | 'rejected';
type ClassFilter = 'all' | 'trend_friendly' | 'neutral' | 'choppy';
type Mode = 'strict' | 'trend_adjusted';
type Lookback = 5 | 10 | 14 | 30 | 90;


function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}
function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}

function statusBadgeClass(s: Result['status']): string {
  switch (s) {
    case 'approved': return 'bg-green-500/20 text-green-700';
    case 'watchlist': return 'bg-yellow-500/20 text-yellow-700';
    case 'trend_candidate': return 'bg-purple-500/20 text-purple-700';
    case 'rejected': return 'bg-red-500/20 text-red-700';
  }
}

function classBadgeClass(c: NonNullable<Result['trend_classification']>): string {
  switch (c) {
    case 'trend_friendly': return 'bg-emerald-500/20 text-emerald-700';
    case 'neutral': return 'bg-slate-500/20 text-slate-700';
    case 'choppy': return 'bg-orange-500/20 text-orange-700';
  }
}


function AdmissionPage() {
  const qc = useQueryClient();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [maxSymbols, setMaxSymbols] = useState<string>('150');
  const [skipWick, setSkipWick] = useState(false);
  const [mode, setMode] = useState<Mode>('trend_adjusted');
  const [includeTrend, setIncludeTrend] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [hideHardRejections, setHideHardRejections] = useState(false);
  const [onlyTrendCandidates, setOnlyTrendCandidates] = useState(false);
  const [minTrend, setMinTrend] = useState<string>('');
  const [minFit, setMinFit] = useState<string>('');
  const [classFilter, setClassFilter] = useState<ClassFilter>('all');
  const [lookback, setLookback] = useState<Lookback>(30);
  const [confirmLongRun, setConfirmLongRun] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'candidate_score', dir: 'desc' });
  const [includeCalibration, setIncludeCalibration] = useState(true);
  const [backtestPrefill, setBacktestPrefill] = useState<BacktestDialogPrefill | null>(null);
  // BT-related filters
  const [minBtScore, setMinBtScore] = useState<string>('');
  const [hideNoTrades, setHideNoTrades] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<'any' | 'only' | 'hide'>('any');
  const [sourceFilter, setSourceFilter] = useState<'any' | 'manual_override' | 'auto'>('any');
  const [btClassFilter, setBtClassFilter] = useState<string>('all');
  // Candidate Score filters
  const [minCandidateScore, setMinCandidateScore] = useState<string>('');
  const [bucketFilter, setBucketFilter] = useState<'all' | CandidateBucket>('all');
  const [hideCapped, setHideCapped] = useState(false);
  const [tradeEligibleOnly, setTradeEligibleOnly] = useState(false);


  const toggleSort = (k: SortKey) => {
    setSort((prev) => prev.key === k
      ? { key: k, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key: k, dir: DEFAULT_DIR[k] });
  };


  const profilesQ = useQuery({
    queryKey: ['admission-profiles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('coin_admission_profiles')
        .select('id, name, description, thresholds, weights')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return (data ?? []) as unknown as Profile[];
    },
  });

  const firstProfile = profilesQ.data?.[0]?.id;
  if (firstProfile && !selectedProfileId) setSelectedProfileId(firstProfile);

  const runsQ = useQuery({
    queryKey: ['admission-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('coin_admission_runs')
        .select('id, started_at, finished_at, profile_name, status, symbols_total, progress_done, approved_n, watchlist_n, rejected_n, error, admission_mode, include_trend_quality')
        .order('started_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as Run[];
    },
    refetchInterval: 4000,
  });

  const activeRunId = selectedRunId
    ?? runsQ.data?.find((r) => r.status === 'completed')?.id
    ?? runsQ.data?.[0]?.id
    ?? null;

  const resultsQ = useQuery({
    enabled: !!activeRunId,
    queryKey: ['admission-results', activeRunId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('coin_admission_results')
        .select('*')
        .eq('run_id', activeRunId!)
        .order('strategy_fit_score', { ascending: false, nullsFirst: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as Result[];
    },
  });

  // Augment results with the latest backtest observation per symbol. Single
  // batch round-trip per run, refreshed when the symbol set changes or after
  // a save (key invalidation by ['backtest-latest-map']).
  const symbolList = useMemo(
    () => (resultsQ.data ?? []).map((r) => r.symbol),
    [resultsQ.data],
  );
  const latestBtQ = useQuery({
    enabled: symbolList.length > 0,
    queryKey: ['backtest-latest-map', activeRunId, symbolList.length],
    queryFn: async () => {
      // Chunk to stay safely under the server-side array cap and keep payloads small.
      const CHUNK = 400;
      const merged: Record<string, any> = {};
      for (let i = 0; i < symbolList.length; i += CHUNK) {
        const slice = symbolList.slice(i, i + CHUNK);
        const part = await listLatestBacktestPerSymbol({ data: { symbols: slice } });
        Object.assign(merged, part?.per_symbol ?? {});
      }
      return { per_symbol: merged };
    },
  });



  const startRun = useMutation({
    mutationFn: async () => {
      if (!selectedProfileId) throw new Error('no_profile');
      const cap = parseInt(maxSymbols, 10);
      return await startAdmissionRun({
        data: {
          profileId: selectedProfileId,
          maxSymbols: Number.isFinite(cap) && cap > 0 ? cap : undefined,
          skipWickAnalysis: skipWick,
          mode,
          includeTrendQuality: includeTrend,
          htqLookbackDays: lookback,
          includeCalibration,
        },
      });
    },
    onSuccess: (res) => {

      setSelectedRunId(res.runId);
      qc.invalidateQueries({ queryKey: ['admission-runs'] });
      qc.invalidateQueries({ queryKey: ['admission-results'] });
    },
  });

  const filteredResults = useMemo(() => {
    const map = latestBtQ.data?.per_symbol ?? {};
    const all = (resultsQ.data ?? []).map((r) => {
      const m = map[r.symbol];
      const merged: Result = {
        ...r,
        last_backtest_label: m?.last_label ?? null,
        last_backtest_date: m?.last_test_date ?? null,
        last_backtest_strategy_version: m?.last_strategy_version ?? null,
        backtest_count: m?.count ?? 0,
        last_bt_score: m?.last_bt_score ?? null,
        last_auto_suggested_label: m?.last_auto_suggested_label ?? null,
        last_label_source: m?.last_label_source ?? null,
        last_needs_review: m?.last_needs_review ?? null,
        last_needs_review_reason: m?.last_needs_review_reason ?? null,
        last_bt_summary: m?.last_summary ?? null,
        last_positive_drivers: m?.last_positive_drivers ?? null,
        last_negative_drivers: m?.last_negative_drivers ?? null,
        last_safety_overrides: m?.last_safety_overrides ?? null,
        last_net_profit_pct: m?.last_net_profit_pct ?? null,
        last_normalized_net_profit_pct: m?.last_normalized_net_profit_pct ?? null,
        last_leverage_adjusted_net_profit_pct: m?.last_leverage_adjusted_net_profit_pct ?? null,
        last_profit_factor: m?.last_profit_factor ?? null,
        last_win_rate_pct: m?.last_win_rate_pct ?? null,
        last_max_drawdown_pct: m?.last_max_drawdown_pct ?? null,
        last_num_trades: m?.last_num_trades ?? null,
      };
      merged.candidate_priority_score = computeCandidatePriority(merged);
      // Resolve BT trust signal.
      let btTrust: BtTrust;
      if (merged.last_backtest_label === 'no_trades') btTrust = 'no_trades';
      else if (merged.last_bt_score == null) btTrust = 'missing';
      else if (merged.last_needs_review && merged.last_label_source === 'auto') btTrust = 'needs_review';
      else btTrust = 'trusted';
      merged.candidate_score = computeCandidateScore({
        robustness: merged.score,
        htq: merged.historical_trend_quality,
        calibration: merged.calibration_score ?? null,
        calibrationConfidence: (merged.calibration_confidence as any) ?? null,
        btScore: btTrust === 'no_trades' ? null : (merged.last_bt_score ?? null),
        btTrust,
        momentum: merged.current_momentum_score,
        hardKills: merged.hard_kill_rules ?? [],
        fallbackStrategyFit: merged.strategy_fit_score ?? null,
      });
      return merged;
    });
    const minTrendN = parseFloat(minTrend);
    const minFitN = parseFloat(minFit);
    const minBtN = parseFloat(minBtScore);
    const minCandN = parseFloat(minCandidateScore);

    const filtered = all.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (classFilter !== 'all' && r.trend_classification !== classFilter) return false;
      if (onlyTrendCandidates && r.status !== 'trend_candidate') return false;
      if (hideHardRejections && (r.hard_kill_rules?.length ?? 0) > 0) return false;
      if (search && !r.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      if (Number.isFinite(minTrendN) && (r.historical_trend_quality ?? -1) < minTrendN) return false;
      if (Number.isFinite(minFitN) && (r.strategy_fit_score ?? -1) < minFitN) return false;
      if (Number.isFinite(minBtN)) {
        // no_trades has no BT score; exclude when threshold is set
        if (r.last_backtest_label === 'no_trades' || r.last_bt_score == null) return false;
        if (r.last_bt_score < minBtN) return false;
      }
      if (hideNoTrades && r.last_backtest_label === 'no_trades') return false;
      if (reviewFilter === 'only' && !r.last_needs_review) return false;
      if (reviewFilter === 'hide' && r.last_needs_review) return false;
      if (sourceFilter !== 'any' && r.last_label_source !== sourceFilter) return false;
      if (btClassFilter !== 'all' && r.last_backtest_label !== btClassFilter) return false;
      // Candidate score filters
      if (Number.isFinite(minCandN)) {
        if (r.candidate_score?.score == null || r.candidate_score.score < minCandN) return false;
      }
      if (bucketFilter !== 'all' && r.candidate_score?.bucket !== bucketFilter) return false;
      if (hideCapped && r.candidate_score?.hardKillCapped) return false;
      if (tradeEligibleOnly && r.candidate_score?.tradeEligible === false) return false;
      return true;
    });

    const dir = sort.dir === 'desc' ? -1 : 1;
    const sorted = [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const aNull = av == null || (typeof av === 'number' && !Number.isFinite(av));
      const bNull = bv == null || (typeof bv === 'number' && !Number.isFinite(bv));
      if (aNull && bNull) return 0;
      if (aNull) return 1;   // nulls always last
      if (bNull) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return sorted;
  }, [resultsQ.data, latestBtQ.data, statusFilter, classFilter, search, hideHardRejections, onlyTrendCandidates, minTrend, minFit, minBtScore, hideNoTrades, reviewFilter, sourceFilter, btClassFilter, sort]);


  const counts = useMemo(() => {
    const all = resultsQ.data ?? [];
    return {
      approved: all.filter((r) => r.status === 'approved').length,
      watchlist: all.filter((r) => r.status === 'watchlist').length,
      trend_candidate: all.filter((r) => r.status === 'trend_candidate').length,
      rejected: all.filter((r) => r.status === 'rejected').length,
      total: all.length,
      avgFit: all.length
        ? all.reduce((a, r) => a + (r.strategy_fit_score ?? 0), 0) / all.length
        : 0,
    };
  }, [resultsQ.data]);

  const selectedProfile = profilesQ.data?.find((p) => p.id === selectedProfileId);
  const activeRun = runsQ.data?.find((r) => r.id === activeRunId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Coin Admission Screener"
        description="Pre-kvalifisering av Bybit USDT perpetuals før de legges inn i botens univers. Påvirker IKKE pågående trading."
      />

      <Card>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Kjør ny vurdering</h3>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">Modus:</span>
            {(['strict', 'trend_adjusted'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  if (m === 'trend_adjusted') setIncludeTrend(true);
                }}
                className={`rounded px-2.5 py-1 text-xs font-medium ${
                  mode === m ? 'bg-primary text-primary-foreground' : 'bg-muted'
                }`}
              >
                {m === 'strict' ? 'Strict Robustness' : 'Trend Adjusted'}
              </button>
            ))}

            <span className="text-xs text-muted-foreground ml-4 mr-1">HTQ Lookback:</span>
            {([5, 10, 14, 30, 90] as Lookback[]).map((d) => (
              <button
                key={d}
                onClick={() => { setLookback(d); if (d !== 90) setConfirmLongRun(false); }}
                className={`rounded px-2 py-1 text-xs ${
                  lookback === d ? 'bg-primary text-primary-foreground' : 'bg-muted'
                }`}
                title={d < 14 ? 'Emerging mode — informativ only, ingen approval' : `${d} dager historisk lookback`}
              >
                {d}d{d < 14 ? '*' : ''}
              </button>
            ))}
          </div>

          {lookback === 90 && (
            <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700">
              ⚠ 90d lookback henter ~2160 1h-bars per symbol (3 sider). Forventet
              kjøretid: 5-10× lengre enn 30d. Bekreft før start.
              <label className="ml-3 inline-flex items-center gap-1">
                <input type="checkbox" checked={confirmLongRun} onChange={(e) => setConfirmLongRun(e.target.checked)} />
                Jeg forstår
              </label>
            </div>
          )}
          {lookback < 14 && (
            <div className="rounded border border-purple-500/40 bg-purple-500/10 p-2 text-xs text-purple-700">
              ℹ Emerging mode ({lookback}d): HTQ er informativ. Trend-adjusted
              status promoteres ikke til Approved/Trend Candidate uten egen
              robusthet.
            </div>
          )}


          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Profil</label>
              <select
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={selectedProfileId ?? ''}
                onChange={(e) => setSelectedProfileId(e.target.value)}
              >
                {(profilesQ.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                Maks symboler (24h turnover desc)
              </label>
              <input
                type="number"
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={maxSymbols}
                onChange={(e) => setMaxSymbols(e.target.value)}
                min={10}
                max={1000}
              />
            </div>
            <div className="flex flex-col justify-end gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={skipWick} onChange={(e) => setSkipWick(e.target.checked)} />
                Hopp over wick-analyse
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeTrend}
                  onChange={(e) => setIncludeTrend(e.target.checked)}
                  disabled={mode === 'trend_adjusted'}
                />
                Inkluder Trend Quality
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeCalibration}
                  onChange={(e) => setIncludeCalibration(e.target.checked)}
                />
                Inkluder Calibration (kNN)
              </label>
            </div>
            <div className="flex items-end">
              <button
                className="rounded bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={startRun.isPending || !selectedProfileId || (lookback === 90 && !confirmLongRun)}
                onClick={() => startRun.mutate()}
              >
                {startRun.isPending ? 'Kjører…' : 'Start screener'}
              </button>
            </div>
          </div>

          {selectedProfile && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Profil-detaljer: {selectedProfile.name}</summary>
              <p className="mt-1">{selectedProfile.description}</p>
              <pre className="mt-1 overflow-auto rounded bg-muted/30 p-2">
                {JSON.stringify({ thresholds: selectedProfile.thresholds, weights: selectedProfile.weights }, null, 2)}
              </pre>
            </details>
          )}

          {startRun.isError && (
            <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-600">
              {(startRun.error as Error).message}
            </div>
          )}
          {startRun.isSuccess && startRun.data && (
            <div className="rounded border border-green-500/40 bg-green-500/10 p-2 text-sm">
              ✓ Ferdig. {startRun.data.symbols_total} symboler →{' '}
              <strong>{startRun.data.approved}</strong> approved /{' '}
              <strong>{startRun.data.watchlist}</strong> watchlist /{' '}
              <strong>{startRun.data.trend_candidate}</strong> trend candidate /{' '}
              <strong>{startRun.data.rejected}</strong> rejected
              {startRun.data.calibration && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Calibration: {startRun.data.calibration.ok} ok / {startRun.data.calibration.unavailable} unavailable ·{' '}
                  {startRun.data.calibration.used} observations brukt
                </div>
              )}
              {startRun.data.calibration_error && (
                <div className="mt-1 text-xs text-yellow-700">
                  Calibration feilet (admission fullført): {startRun.data.calibration_error}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold mb-2">Tidligere kjøringer</h3>
        {runsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Laster…</p>
        ) : (runsQ.data ?? []).length === 0 ? (
          <EmptyState title="Ingen kjøringer enda" hint="Start en screener over for å lage den første rapporten." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-1 pr-2">Startet</th>
                  <th className="py-1 pr-2">Profil</th>
                  <th className="py-1 pr-2">Modus</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2">Progress</th>
                  <th className="py-1 pr-2">A / W / R</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {(runsQ.data ?? []).map((r) => {
                  const isActive = r.id === activeRunId;
                  return (
                    <tr key={r.id} className={`border-b ${isActive ? 'bg-muted/30' : ''}`}>
                      <td className="py-1 pr-2 font-mono text-xs">{new Date(r.started_at).toLocaleString()}</td>
                      <td className="py-1 pr-2">{r.profile_name}</td>
                      <td className="py-1 pr-2 text-xs">
                        {r.admission_mode ?? 'strict'}{r.include_trend_quality ? ' +TQ' : ''}
                      </td>
                      <td className="py-1 pr-2">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          r.status === 'completed' ? 'bg-green-500/20 text-green-700' :
                          r.status === 'failed' ? 'bg-red-500/20 text-red-700' :
                          'bg-yellow-500/20 text-yellow-700'
                        }`}>{r.status}</span>
                      </td>
                      <td className="py-1 pr-2 text-xs">{r.progress_done ?? 0} / {r.symbols_total ?? '?'}</td>
                      <td className="py-1 pr-2 text-xs">
                        <span className="text-green-600">{r.approved_n ?? 0}</span>{' / '}
                        <span className="text-yellow-600">{r.watchlist_n ?? 0}</span>{' / '}
                        <span className="text-red-600">{r.rejected_n ?? 0}</span>
                      </td>
                      <td className="py-1 text-right">
                        <button className="text-xs underline" onClick={() => setSelectedRunId(r.id)}>
                          {isActive ? 'aktiv' : 'vis'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {activeRunId && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <Card><div className="text-xs text-muted-foreground">Approved</div><div className="text-2xl font-semibold text-green-600">{counts.approved}</div></Card>
          <Card><div className="text-xs text-muted-foreground">Watchlist</div><div className="text-2xl font-semibold text-yellow-600">{counts.watchlist}</div></Card>
          <Card><div className="text-xs text-muted-foreground">Trend Candidate</div><div className="text-2xl font-semibold text-purple-600">{counts.trend_candidate}</div></Card>
          <Card><div className="text-xs text-muted-foreground">Rejected</div><div className="text-2xl font-semibold text-red-600">{counts.rejected}</div></Card>
          <Card><div className="text-xs text-muted-foreground">Avg Strategy Fit</div><div className="text-2xl font-semibold">{counts.avgFit.toFixed(1)}</div><div className="text-[10px] text-muted-foreground">{activeRun?.admission_mode ?? 'strict'}</div></Card>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold mr-auto">
            Resultater
            {activeRunId && (
              <span className="ml-2 text-xs text-muted-foreground">({counts.total} totalt)</span>
            )}
          </h3>
          <input
            className="rounded border bg-background px-2 py-1 text-sm"
            placeholder="Søk symbol…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {(['all', 'approved', 'watchlist', 'trend_candidate', 'rejected'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              className={`rounded px-2 py-1 text-xs ${statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'trend_candidate' ? 'trend cand.' : s}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={onlyTrendCandidates} onChange={(e) => setOnlyTrendCandidates(e.target.checked)} />
            Kun Trend Candidates
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={hideHardRejections} onChange={(e) => setHideHardRejections(e.target.checked)} />
            Skjul hard rejections
          </label>
          <label className="flex items-center gap-1">
            Min HTQ
            <input type="number" min={0} max={100} className="w-16 rounded border bg-background px-1 py-0.5" value={minTrend} onChange={(e) => setMinTrend(e.target.value)} />
          </label>
          <label className="flex items-center gap-1">
            Min Strategy Fit
            <input type="number" min={0} max={100} className="w-16 rounded border bg-background px-1 py-0.5" value={minFit} onChange={(e) => setMinFit(e.target.value)} />
          </label>
          <span className="ml-2 text-muted-foreground">Klassifisering:</span>
          {(['all', 'trend_friendly', 'neutral', 'choppy'] as ClassFilter[]).map((c) => (
            <button
              key={c}
              className={`rounded px-2 py-0.5 ${classFilter === c ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              onClick={() => setClassFilter(c)}
            >
              {c === 'all' ? 'alle' : c === 'trend_friendly' ? 'trend-friendly' : c}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
          <span className="text-muted-foreground">Backtest:</span>
          <label className="flex items-center gap-1">
            Min BT Score
            <input
              type="number"
              min={0}
              max={100}
              className="w-16 rounded border bg-background px-1 py-0.5"
              value={minBtScore}
              onChange={(e) => setMinBtScore(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={hideNoTrades} onChange={(e) => setHideNoTrades(e.target.checked)} />
            Skjul no_trades
          </label>
          <span className="ml-2 text-muted-foreground">Review:</span>
          {(['any', 'only', 'hide'] as const).map((v) => (
            <button
              key={v}
              className={`rounded px-2 py-0.5 ${reviewFilter === v ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              onClick={() => setReviewFilter(v)}
            >
              {v === 'any' ? 'alle' : v === 'only' ? 'needs review' : 'hide review'}
            </button>
          ))}
          <span className="ml-2 text-muted-foreground">Source:</span>
          {(['any', 'manual_override', 'auto'] as const).map((v) => (
            <button
              key={v}
              className={`rounded px-2 py-0.5 ${sourceFilter === v ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              onClick={() => setSourceFilter(v)}
            >
              {v === 'any' ? 'alle' : v}
            </button>
          ))}
          <span className="ml-2 text-muted-foreground">BT Class:</span>
          <select
            className="rounded border bg-background px-1 py-0.5"
            value={btClassFilter}
            onChange={(e) => setBtClassFilter(e.target.value)}
          >
            <option value="all">alle</option>
            <option value="profitable_plus">profitable_plus</option>
            <option value="profitable">profitable</option>
            <option value="marginal">marginal</option>
            <option value="rejected_backtest">rejected_backtest</option>
            <option value="no_trades">no_trades</option>
          </select>
        </div>


        {!activeRunId ? (
          <EmptyState title="Velg en kjøring" hint="Trykk vis på en kjøring over for å se resultatene." />
        ) : resultsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Laster resultater…</p>
        ) : filteredResults.length === 0 ? (
          <EmptyState title="Ingen treff" hint="Endre filter eller søkeord." />
        ) : (
          <div className="overflow-x-auto">
            <TooltipProvider delayDuration={150}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <HeaderCell label="Symbol" sortKey="symbol" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Status" sortKey="status" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Class" sortKey="class" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Fit" align="right" sortKey="fit" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Robust" align="right" sortKey="robust" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="HTQ" align="right" sortKey="htq" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Mom" align="right" sortKey="momentum" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Rank" align="right" sortKey="rank" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="24h TO" align="right" sortKey="turnover_24h" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="OI" align="right" sortKey="oi" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Spread" align="right" sortKey="spread" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Age" align="right" sortKey="age" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Wick%" align="right" sortKey="wick" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Hard Kills" sortKey="hard_kills" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Soft" sortKey="soft" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Reason" sortKey="reason" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="BT Score" align="right" sortKey="bt_score" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="BT Class" sortKey="last_bt_class" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="BT Summary" />
                  <HeaderCell label="Calib Score" align="right" sortKey="calib_score" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Priority" align="right" sortKey="priority" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Last BT Date" sortKey="last_bt_date" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="Last BT Ver" sortKey="last_bt_ver" activeSort={sort} onSort={toggleSort} />
                  <HeaderCell label="# BT" align="right" sortKey="bt_count" activeSort={sort} onSort={toggleSort} />

                </tr>
              </thead>



              <tbody>
                {filteredResults.map((r) => {
                  const isOpen = expanded === r.id;
                  return (
                    <>
                      <tr
                        key={r.id}
                        className="border-b cursor-pointer hover:bg-muted/30"
                        onClick={() => setExpanded(isOpen ? null : r.id)}
                      >
                        <td className="py-1 pr-2 font-mono">{r.symbol}</td>
                        <td className="py-1 pr-2">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${statusBadgeClass(r.status)}`}>
                            {r.status === 'trend_candidate' ? 'trend cand.' : r.status}
                          </span>
                        </td>
                        <td className="py-1 pr-2">
                          {r.trend_classification ? (
                            <span className={`rounded px-1.5 py-0.5 text-xs ${classBadgeClass(r.trend_classification)}`}>
                              {r.trend_classification === 'trend_friendly' ? 'trend' : r.trend_classification}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono font-semibold">{fmtNum(r.strategy_fit_score, 1)}</td>
                        <td className="py-1 pr-2 text-right font-mono">{fmtNum(r.score, 1)}</td>
                        <td
                          className="py-1 pr-2 text-right font-mono"
                          title={r.htq_lookback_days ? `${r.htq_lookback_days}d · ${r.htq_mode ?? ''}` : ''}
                        >
                          {r.historical_trend_quality != null ? fmtNum(r.historical_trend_quality, 1) : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono text-muted-foreground">
                          {r.current_momentum_score != null ? fmtNum(r.current_momentum_score, 1) : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right">{r.rank ?? '—'}</td>
                        <td className="py-1 pr-2 text-right">{fmtUsd(r.turnover_24h)}</td>
                        <td className="py-1 pr-2 text-right">{fmtUsd(r.open_interest_value)}</td>
                        <td className="py-1 pr-2 text-right">{fmtNum(r.spread_bps, 2)}</td>
                        <td className="py-1 pr-2 text-right">{r.listing_age_days ?? '—'}</td>
                        <td className="py-1 pr-2 text-right">{fmtNum(r.max_1h_drop_pct, 1)}</td>
                        <td className="py-1 pr-2 text-xs text-red-600 max-w-[160px] truncate" title={(r.hard_kill_rules ?? []).join(', ')}>
                          {(r.hard_kill_rules ?? []).join(', ') || '—'}
                        </td>
                        <td className="py-1 pr-2 text-xs text-yellow-700 max-w-[160px] truncate" title={(r.soft_failures ?? []).join(', ')}>
                          {(r.soft_failures ?? []).join(', ') || '—'}
                        </td>
                        <td className="py-1 pr-2 text-xs max-w-[200px] truncate" title={r.admission_reason ?? ''}>
                          {r.admission_reason ?? '—'}
                        </td>
                        <BtScoreCell r={r} />
                        <BtClassCell r={r} />
                        <td className="py-1 pr-2 text-xs text-muted-foreground max-w-[220px] truncate" title={r.last_bt_summary ?? ''}>
                          {r.last_bt_summary ?? '—'}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">
                          {r.calibration_score != null ? fmtNum(r.calibration_score, 1) : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono font-semibold">
                          {r.candidate_priority_score != null ? fmtNum(r.candidate_priority_score, 1) : '—'}
                          {r.last_needs_review && r.last_label_source === 'auto' && (
                            <span className="ml-1 text-yellow-600" title="Backtest label needs review — BT contribution reduced.">⚠</span>
                          )}
                        </td>
                        <td className="py-1 pr-2 text-xs font-mono text-muted-foreground">{r.last_backtest_date ?? '—'}</td>
                        <td className="py-1 pr-2 text-xs text-muted-foreground max-w-[120px] truncate" title={r.last_backtest_strategy_version ?? ''}>
                          {r.last_backtest_strategy_version ?? '—'}
                        </td>
                        <td className="py-1 pr-2 text-right">{r.backtest_count ?? 0}</td>
                      </tr>

                      {isOpen && (
                        <tr key={`${r.id}-x`} className="border-b bg-muted/20">
                          <td colSpan={24} className="p-3">

                            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
                              <div>
                                <h4 className="font-semibold mb-1">Robustness components</h4>
                                <pre className="rounded bg-background p-2 overflow-auto">
                                  {JSON.stringify(r.components ?? {}, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <h4 className="font-semibold mb-1">
                                  HTQ v2 ({r.htq_lookback_days ?? '—'}d · {r.htq_mode ?? '—'})
                                </h4>
                                <pre className="rounded bg-background p-2 overflow-auto">
                                  {JSON.stringify(r.htq_components ?? { note: 'not computed' }, null, 2)}
                                </pre>
                                {r.htq_reason && (
                                  <p className="mt-1 text-muted-foreground">{r.htq_reason}</p>
                                )}
                              </div>
                              <div>
                                <h4 className="font-semibold mb-1">Current Momentum (live)</h4>
                                <pre className="rounded bg-background p-2 overflow-auto">
                                  {r.current_momentum_components
                                    ? JSON.stringify(
                                        {
                                          momentum_score: r.current_momentum_score,
                                          ...r.current_momentum_components,
                                        },
                                        null,
                                        2,
                                      )
                                    : JSON.stringify(
                                        { momentum_score: r.current_momentum_score },
                                        null,
                                        2,
                                      )}
                                </pre>
                                {!r.current_momentum_components && (
                                  <p className="mt-1 text-muted-foreground">
                                    Live momentum snapshot — no component breakdown available.
                                  </p>
                                )}
                              </div>
                              <div>
                                <h4 className="font-semibold mb-1">Details</h4>
                                <pre className="rounded bg-background p-2 overflow-auto whitespace-pre-wrap">
                                  {JSON.stringify({
                                    admission_reason: r.admission_reason,
                                    admission_mode: r.admission_mode,
                                    strategy_fit_label: r.strategy_fit_label,
                                    trend_classification: r.trend_classification,
                                    hard_kill_rules: r.hard_kill_rules,
                                    soft_failures: r.soft_failures,
                                    wick_risk_score: r.wick_risk_score,
                                    fetch_error: r.fetch_error,
                                  }, null, 2)}
                                </pre>
                              </div>
                            </div>
                            <LastBacktestDetail r={r} />
                            <BacktestHistorySection symbol={r.symbol} />
                            <div className="mt-3 flex flex-wrap justify-end gap-2">
                              {activeRunId && (
                                <RecalcCalibrationButton
                                  runId={activeRunId}
                                  symbol={r.symbol}
                                  onDone={() =>
                                    qc.invalidateQueries({ queryKey: ['admission-results'] })
                                  }
                                />
                              )}
                              <button
                                className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setBacktestPrefill({
                                    symbol: r.symbol,
                                    admission_result_id: r.id,
                                    admission_run_id: activeRunId,
                                    screener_snapshot: {
                                      robustness: r.score,
                                      historical_trend_quality: r.historical_trend_quality,
                                      htq_components: r.htq_components,
                                      current_momentum_score: r.current_momentum_score,
                                      turnover_24h: r.turnover_24h,
                                      turnover_7d_median: (r as any).turnover_7d_median ?? null,
                                      open_interest_value: r.open_interest_value,
                                      spread_bps: r.spread_bps,
                                      listing_age_days: r.listing_age_days,
                                      strategy_fit_score: r.strategy_fit_score,
                                      htq_lookback_days: r.htq_lookback_days,
                                      htq_mode: r.htq_mode,
                                    },
                                  });
                                }}
                              >
                                + Add Backtest Result
                              </button>
                            </div>

                          </td>


                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
            </TooltipProvider>
          </div>

        )}
      </Card>

      <BacktestResultDialog
        open={!!backtestPrefill}
        onOpenChange={(o) => { if (!o) setBacktestPrefill(null); }}
        prefill={backtestPrefill ?? undefined}
        onSaved={(info) => {
          setBacktestPrefill(null);
          qc.invalidateQueries({ queryKey: ['admission-results'] });
          qc.invalidateQueries({ queryKey: ['backtest-latest-map'] });
          if (info?.symbol) {
            qc.invalidateQueries({ queryKey: ['backtest-history', info.symbol] });
          } else {
            qc.invalidateQueries({ queryKey: ['backtest-history'] });
          }
          qc.invalidateQueries({ queryKey: ['calibration-strategy-versions'] });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded-row helpers
// ---------------------------------------------------------------------------

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function BacktestHistorySection({ symbol }: { symbol: string }) {
  const historyQ = useQuery({
    queryKey: ['backtest-history', symbol],
    queryFn: () => listBacktestResults({ data: { symbol, limit: 100 } }),
    enabled: !!symbol,
  });

  if (historyQ.isLoading) {
    return <p className="mt-3 text-xs text-muted-foreground">Laster backtest-historikk…</p>;
  }
  const rows = historyQ.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Ingen backtest-observasjoner registrert for {symbol} ennå.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded border bg-background/60 p-2">
      <div className="mb-1 text-xs font-semibold">
        Backtest History ({rows.length} observasjon{rows.length === 1 ? '' : 'er'})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b">
              <th className="py-0.5 pr-2">Test Date</th>
              <th className="py-0.5 pr-2">Label</th>
              <th className="py-0.5 pr-2">Strategy</th>
              <th className="py-0.5 pr-2 text-right">Net %</th>
              <th className="py-0.5 pr-2 text-right">DD %</th>
              <th className="py-0.5 pr-2 text-right">PF</th>
              <th className="py-0.5 pr-2 text-right">Trades</th>
              <th className="py-0.5 pr-2">Source</th>
              <th className="py-0.5 pr-2">Saved</th>
              <th className="py-0.5 pr-2">Screenshot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any) => (
              <BacktestHistoryRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BacktestHistoryRow({ row }: { row: any }) {
  const [open, setOpen] = useState(false);
  const lev = row.leverage_enabled ? row.leverage ?? null : null;
  return (
    <>
      <tr className="border-b last:border-b-0">
        <td className="py-0.5 pr-2 font-mono">
          <button
            className="mr-1 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-label="toggle details"
          >
            {open ? '▾' : '▸'}
          </button>
          {row.test_date}
        </td>
        <td className="py-0.5 pr-2">
          <span className="rounded bg-muted px-1.5 py-0.5">{row.label}</span>
        </td>
        <td className="py-0.5 pr-2 text-muted-foreground">{row.strategy_version}</td>
        <td className="py-0.5 pr-2 text-right">{fmtNum(row.net_profit_pct, 1)}</td>
        <td className="py-0.5 pr-2 text-right">{fmtNum(row.max_drawdown_pct, 1)}</td>
        <td className="py-0.5 pr-2 text-right">{fmtNum(row.profit_factor, 2)}</td>
        <td className="py-0.5 pr-2 text-right">{row.num_trades ?? '—'}</td>
        <td className="py-0.5 pr-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${row.extraction_source === 'screenshot_ocr' ? 'bg-blue-500/15 text-blue-700' : 'bg-muted'}`}>
            {row.extraction_source === 'screenshot_ocr' ? 'OCR' : 'manual'}
          </span>
        </td>
        <td className="py-0.5 pr-2 text-muted-foreground">{fmtTs(row.created_at)}</td>
        <td className="py-0.5 pr-2">
          {row.screenshot_storage_path ? <ScreenshotLink id={row.id} /> : '—'}
        </td>
      </tr>
      {open && (
        <tr className="border-b last:border-b-0 bg-muted/20">
          <td colSpan={10} className="px-2 py-2">
            <div className="mb-1 text-[10px] text-muted-foreground">
              Sizing: {row.position_size_pct ?? '—'}% of equity
              {lev != null ? ` · ${lev}x leverage` : ' · no leverage'}
              {' · notional '}
              {row.notional_exposure_pct != null ? `${fmtNum(row.notional_exposure_pct, 1)}%` : '—'}
              {' · capital '}
              {row.initial_capital_usd != null ? `$${row.initial_capital_usd}` : '—'}
              {row.sizing_assumption_source ? ` · src: ${row.sizing_assumption_source}` : ''}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <MetricsCard
                title="Account (TradingView)"
                items={[
                  ['Net profit %', fmtNum(row.net_profit_pct, 2)],
                  ['Max drawdown %', fmtNum(row.max_drawdown_pct, 2)],
                  ['Avg PnL %', fmtNum(row.avg_pnl_pct, 2)],
                  ['Profit factor', fmtNum(row.profit_factor, 2)],
                  ['Win rate %', fmtNum(row.win_rate_pct, 1)],
                  ['Trades', row.num_trades ?? '—'],
                ]}
              />
              <MetricsCard
                title="Position-size normalized"
                hint="per-unit (÷ position %)"
                items={[
                  ['Norm. net %', fmtNum(row.normalized_net_profit_pct, 2)],
                  ['Norm. drawdown %', fmtNum(row.normalized_drawdown_pct, 2)],
                  ['Norm. avg trade %', fmtNum(row.normalized_avg_trade_pct, 3)],
                ]}
              />
              <MetricsCard
                title={`Leverage-adjusted${lev ? ` (${lev}x)` : ''}`}
                hint="estimate; excludes funding/slippage/liq"
                items={[
                  ['Lev. net %', fmtNum(row.leverage_adjusted_net_profit_pct, 2)],
                  ['Lev. drawdown %', fmtNum(row.leverage_adjusted_drawdown_pct, 2)],
                ]}
              />
            </div>
            {row.notes && (
              <p className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap">
                <span className="font-medium">Notes:</span> {row.notes}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function MetricsCard({
  title,
  hint,
  items,
}: {
  title: string;
  hint?: string;
  items: Array<[string, React.ReactNode]>;
}) {
  return (
    <div className="rounded border bg-background p-2">
      <div className="text-[11px] font-semibold">{title}</div>
      {hint && <div className="text-[10px] text-muted-foreground mb-1">{hint}</div>}
      <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
        {items.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-mono">{v ?? '—'}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function ScreenshotLink({ id }: { id: string }) {
  const [loading, setLoading] = useState(false);
  const open = async () => {
    setLoading(true);
    try {
      const res = await getBacktestScreenshotUrl({ data: { id } });
      if (res.url) window.open(res.url, '_blank', 'noopener');
      else toast.error('Screenshot ikke tilgjengelig');
    } catch (e: any) {
      toast.error(`Kunne ikke hente screenshot: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      className="text-blue-600 hover:underline disabled:opacity-50"
      onClick={open}
      disabled={loading}
    >
      {loading ? '…' : 'view'}
    </button>
  );
}

function RecalcCalibrationButton({
  runId,
  symbol,
  onDone,
}: {
  runId: string;
  symbol: string;
  onDone?: () => void;
}) {
  const m = useMutation({
    mutationFn: () => recalcCalibrationForSymbol({ data: { run_id: runId, symbol } }),
    onSuccess: (res) => {
      if (res.status === 'ok') {
        toast.success(`Calibration oppdatert for ${symbol}`, {
          description: `Score: ${res.calibration_score ?? '—'} · Label: ${res.calibration_label ?? '—'} · ${res.observations_used} observasjoner brukt.`,
        });
      } else {
        toast.warning(`Calibration unavailable for ${symbol}`, {
          description: res.reason ?? 'unknown',
        });
      }
      onDone?.();
    },
    onError: (e: any) => toast.error(`Recalc feilet: ${e?.message ?? e}`),
  });
  return (
    <button
      className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
      onClick={(e) => {
        e.stopPropagation();
        m.mutate();
      }}
      disabled={m.isPending}
    >
      {m.isPending ? 'Recalculating…' : 'Recalculate calibration for this symbol'}
    </button>
  );
}

