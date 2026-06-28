/**
 * Calibration / Label Review (Phase 0).
 *
 * Read-only operator view of all backtest observations with focus on label
 * quality. Lets the operator:
 *  - filter by label / needs-review / strategy version
 *  - dry-run + apply the upgraded classifier on existing rows
 *  - manually override a confirmed label
 *  - dismiss `needs_review` after a manual look
 *
 * Read-only with respect to execution/dispatcher/risk; only touches
 * `coin_backtest_results`.
 */

import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageHeader, Card, EmptyState } from '@/components/PageHeader';
import {
  listLabelReview,
  recomputeSuggestedLabels,
  overrideBacktestLabel,
  clearNeedsReview,
} from '@/lib/calibration/label-review.functions';

type Label = 'no_trades' | 'rejected_backtest' | 'marginal' | 'profitable' | 'profitable_plus';

const LABELS: Array<{ value: Label | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'no_trades', label: 'No Trades' },
  { value: 'rejected_backtest', label: 'Rejected' },
  { value: 'marginal', label: 'Marginal' },
  { value: 'profitable', label: 'Profitable' },
  { value: 'profitable_plus', label: 'Profitable+' },
];

function labelBadge(l: string): string {
  switch (l) {
    case 'no_trades': return 'bg-slate-400/20 text-slate-700';
    case 'rejected_backtest': return 'bg-red-500/20 text-red-700';
    case 'marginal': return 'bg-yellow-500/20 text-yellow-700';
    case 'profitable': return 'bg-green-500/20 text-green-700';
    case 'profitable_plus': return 'bg-emerald-600/20 text-emerald-700';
    default: return 'bg-muted';
  }
}

function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(dp);
}

export const Route = createFileRoute('/_app/calibration')({
  component: CalibrationPage,
});

function CalibrationPage() {
  const qc = useQueryClient();
  const [labelFilter, setLabelFilter] = useState<Label | 'all'>('all');
  const [onlyReview, setOnlyReview] = useState(true);
  const [showNoTrades, setShowNoTrades] = useState(false);
  const [strategy, setStrategy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const reviewQ = useQuery({
    queryKey: ['label-review', labelFilter, onlyReview, strategy],
    queryFn: () =>
      listLabelReview({
        data: {
          only_needs_review: onlyReview,
          label: labelFilter === 'all' ? null : labelFilter,
          strategy_version: strategy || undefined,
          limit: 300,
          offset: 0,
        },
      }),
  });

  const rows = useMemo(() => {
    const all = (reviewQ.data?.rows ?? []) as any[];
    return showNoTrades ? all : all.filter((r) => r.label !== 'no_trades');
  }, [reviewQ.data?.rows, showNoTrades]);

  const dryRun = useMutation({
    mutationFn: () =>
      recomputeSuggestedLabels({
        data: {
          dry_run: true,
          strategy_version: strategy || undefined,
        },
      }),
    onSuccess: (res) =>
      toast.success('Dry run completed', {
        description: `${res.scanned} scanned · ${res.flagged_needs_review} would be flagged for review`,
      }),
    onError: (e: any) => toast.error(`Dry run failed: ${e?.message ?? e}`),
  });

  const apply = useMutation({
    mutationFn: () =>
      recomputeSuggestedLabels({
        data: { dry_run: false, strategy_version: strategy || undefined },
      }),
    onSuccess: (res) => {
      toast.success('Classifier reapplied', {
        description: `${res.updated} updated · ${res.flagged_needs_review} need review · ${res.kept_manual_override} manual overrides kept`,
      });
      qc.invalidateQueries({ queryKey: ['label-review'] });
    },
    onError: (e: any) => toast.error(`Recompute failed: ${e?.message ?? e}`),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Calibration · Label Review"
        description="Phase 0 — kontroller backtest-labels før calibration læres tungt. Endrer ikke execution, dispatcher, risk eller signaler."
      />

      <Card>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Distribusjon</h3>
          <div className="flex flex-wrap gap-2 text-xs">
            {(['no_trades', 'rejected_backtest', 'marginal', 'profitable', 'profitable_plus'] as Label[]).map((l) => (
              <span key={l} className={`rounded px-2 py-1 ${labelBadge(l)}`}>
                {l}: <strong>{reviewQ.data?.distribution?.[l] ?? 0}</strong>
              </span>
            ))}
            <span className="rounded px-2 py-1 bg-muted">
              Total: <strong>{reviewQ.data?.total ?? 0}</strong>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
            {LABELS.map((l) => (
              <button
                key={l.value}
                className={`rounded px-2 py-1 ${labelFilter === l.value ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                onClick={() => setLabelFilter(l.value)}
              >
                {l.label}
              </button>
            ))}
            <label className="flex items-center gap-1 ml-2">
              <input
                type="checkbox"
                checked={onlyReview}
                onChange={(e) => setOnlyReview(e.target.checked)}
              />
              Only needs_review
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={showNoTrades}
                onChange={(e) => setShowNoTrades(e.target.checked)}
              />
              Show No Trades
            </label>
            <input
              className="rounded border bg-background px-2 py-1"
              placeholder="strategy_version (optional)"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            />
            <div className="ml-auto flex gap-2">
              <button
                className="rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
                disabled={dryRun.isPending}
                onClick={() => dryRun.mutate()}
              >
                {dryRun.isPending ? 'Dry-running…' : 'Dry run recompute'}
              </button>
              <button
                className="rounded bg-primary text-primary-foreground px-3 py-1 disabled:opacity-50"
                disabled={apply.isPending}
                onClick={() => apply.mutate()}
              >
                {apply.isPending ? 'Applying…' : 'Apply recompute'}
              </button>
            </div>
          </div>

          {dryRun.data && (
            <div className="rounded border border-blue-500/40 bg-blue-500/5 p-2 text-xs">
              Dry run: {dryRun.data.scanned} scanned · {dryRun.data.flagged_needs_review} would flag for review · {dryRun.data.kept_manual_override} manual overrides kept.
            </div>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold mb-2">
          Observations ({rows.length} shown / {reviewQ.data?.total ?? 0} total)
        </h3>
        {reviewQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Laster…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="Ingen rader" hint="Justér filter eller fjern 'Only needs_review'." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1 pr-2">Symbol</th>
                  <th className="py-1 pr-2">Test Date</th>
                  <th className="py-1 pr-2">Label</th>
                  <th className="py-1 pr-2">Suggested</th>
                  <th className="py-1 pr-2">Source</th>
                  <th className="py-1 pr-2 text-right">Quality</th>
                  <th className="py-1 pr-2 text-right">Net%</th>
                  <th className="py-1 pr-2 text-right">Norm Net%</th>
                  <th className="py-1 pr-2 text-right">PF</th>
                  <th className="py-1 pr-2 text-right">Trades</th>
                  <th className="py-1 pr-2">Review</th>
                  <th className="py-1 pr-2 text-right">Strategy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const open = expanded === r.id;
                  return (
                    <ReviewRow
                      key={r.id}
                      row={r}
                      open={open}
                      onToggle={() => setExpanded(open ? null : r.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewRow({
  row,
  open,
  onToggle,
}: {
  row: any;
  open: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const override = useMutation({
    mutationFn: (label: Label) => overrideBacktestLabel({ data: { id: row.id, label, clear_review: true } }),
    onSuccess: () => {
      toast.success(`Label overridden for ${row.symbol}`);
      qc.invalidateQueries({ queryKey: ['label-review'] });
      qc.invalidateQueries({ queryKey: ['backtest-history', row.symbol] });
    },
    onError: (e: any) => toast.error(`Override failed: ${e?.message ?? e}`),
  });
  const dismiss = useMutation({
    mutationFn: () => clearNeedsReview({ data: { id: row.id } }),
    onSuccess: () => {
      toast.success('Review dismissed');
      qc.invalidateQueries({ queryKey: ['label-review'] });
    },
    onError: (e: any) => toast.error(`Failed: ${e?.message ?? e}`),
  });

  const disagreement = row.auto_suggested_label && row.auto_suggested_label !== row.label;

  return (
    <>
      <tr className={`border-b cursor-pointer hover:bg-muted/30 ${row.needs_review ? 'bg-yellow-500/5' : ''}`} onClick={onToggle}>
        <td className="py-1 pr-2 font-mono">{row.symbol}</td>
        <td className="py-1 pr-2 font-mono text-muted-foreground">{row.test_date}</td>
        <td className="py-1 pr-2">
          <span className={`rounded px-1.5 py-0.5 ${labelBadge(row.label)}`}>{row.label}</span>
        </td>
        <td className="py-1 pr-2">
          {row.auto_suggested_label ? (
            <span className={`rounded px-1.5 py-0.5 ${labelBadge(row.auto_suggested_label)} ${disagreement ? 'ring-1 ring-yellow-500' : ''}`}>
              {row.auto_suggested_label}
            </span>
          ) : '—'}
        </td>
        <td className="py-1 pr-2 text-[10px] text-muted-foreground">
          {row.label_source ?? 'auto'}
        </td>
        <td className="py-1 pr-2 text-right">{fmtNum(row.backtest_quality_score, 0)}</td>
        <td className="py-1 pr-2 text-right">{fmtNum(row.net_profit_pct, 1)}</td>
        <td className="py-1 pr-2 text-right">{fmtNum(row.normalized_net_profit_pct, 1)}</td>
        <td className="py-1 pr-2 text-right">{fmtNum(row.profit_factor, 2)}</td>
        <td className="py-1 pr-2 text-right">{row.num_trades ?? '—'}</td>
        <td className="py-1 pr-2">
          {row.needs_review ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] bg-yellow-500/20 text-yellow-700" title={row.needs_review_reason ?? ''}>
              review
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">ok</span>
          )}
        </td>
        <td className="py-1 pr-2 text-right text-muted-foreground text-[10px]">{row.strategy_version}</td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/10">
          <td colSpan={12} className="p-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div>
                <div className="font-semibold mb-1">Classification summary</div>
                <p className="text-muted-foreground">{row.classification_summary ?? '—'}</p>
                {row.needs_review_reason && (
                  <p className="mt-1 text-yellow-700">{row.needs_review_reason}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  {(row.classification_reason_codes ?? []).map((c: string) => (
                    <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{c}</span>
                  ))}
                  {(row.classification_safety_overrides ?? []).map((c: string) => (
                    <span key={c} className="rounded bg-red-500/20 text-red-700 px-1.5 py-0.5 text-[10px]">override:{c}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="font-semibold mb-1">Drivers</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] text-green-700 mb-0.5">Positive</div>
                    <pre className="rounded bg-background p-1 text-[10px] overflow-auto">
                      {JSON.stringify(row.classification_positive_drivers ?? {}, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <div className="text-[10px] text-red-700 mb-0.5">Negative</div>
                    <pre className="rounded bg-background p-1 text-[10px] overflow-auto">
                      {JSON.stringify(row.classification_negative_drivers ?? {}, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground mr-1">Override label →</span>
              {(['no_trades', 'rejected_backtest', 'marginal', 'profitable', 'profitable_plus'] as Label[]).map((l) => (
                <button
                  key={l}
                  disabled={override.isPending}
                  onClick={(e) => { e.stopPropagation(); override.mutate(l); }}
                  className={`rounded px-2 py-0.5 text-[11px] ${labelBadge(l)} ${row.label === l ? 'ring-1 ring-primary' : ''}`}
                >
                  {l}
                </button>
              ))}
              {row.needs_review && (
                <button
                  disabled={dismiss.isPending}
                  onClick={(e) => { e.stopPropagation(); dismiss.mutate(); }}
                  className="ml-auto rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
                >
                  Dismiss review (keep label)
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
