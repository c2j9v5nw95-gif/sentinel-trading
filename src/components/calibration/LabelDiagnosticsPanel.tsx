/**
 * Label Health Diagnostics panel + Safe Batch Recompute.
 *
 * Read-only diagnostics from `getLabelDiagnostics`, plus a 2-step recompute
 * (dry-run → commit) backed by `safeRecomputeAutoLabels`. The commit branch
 * NEVER touches confirmed labels, label_source, TradingView numbers or
 * screener_snapshot — only auto_suggested_label / quality / diagnostics
 * / needs_review (skipped for manual_override rows).
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card } from '@/components/PageHeader';
import {
  getLabelDiagnostics,
  safeRecomputeAutoLabels,
} from '@/lib/calibration/label-diagnostics.functions';

const LABELS = ['no_trades', 'rejected_backtest', 'marginal', 'profitable', 'profitable_plus'] as const;

function badge(l: string): string {
  switch (l) {
    case 'no_trades': return 'bg-slate-400/20 text-slate-700';
    case 'rejected_backtest': return 'bg-red-500/20 text-red-700';
    case 'marginal': return 'bg-yellow-500/20 text-yellow-700';
    case 'profitable': return 'bg-green-500/20 text-green-700';
    case 'profitable_plus': return 'bg-emerald-600/20 text-emerald-700';
    default: return 'bg-muted';
  }
}

function csvDownload(rows: any[], filename: string) {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const esc = (v: any) =>
    v == null ? '' : `"${String(v).replaceAll('"', '""')}"`;
  const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function LabelDiagnosticsPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState<{ title: string; rows: any[] } | null>(null);

  const diagQ = useQuery({
    queryKey: ['label-diagnostics'],
    queryFn: () => getLabelDiagnostics(),
  });

  const d = diagQ.data;

  // Recompute state
  const [strategy, setStrategy] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const dryRun = useMutation({
    mutationFn: () =>
      safeRecomputeAutoLabels({
        data: { dry_run: true, strategy_version: strategy || undefined, only_changed: true },
      }),
    onSuccess: (r) =>
      toast.success('Dry-run complete', {
        description: `${r.scanned} scanned · ${r.changed} would change · ${r.assertion_failures} assertion failures`,
      }),
    onError: (e: any) => toast.error(`Dry-run failed: ${e?.message ?? e}`),
  });

  const commit = useMutation({
    mutationFn: () =>
      safeRecomputeAutoLabels({
        data: { dry_run: false, strategy_version: strategy || undefined, only_changed: true },
      }),
    onSuccess: (r) => {
      toast.success('Recompute applied', {
        description: `${r.updated} rows updated · ${r.assertion_failures} assertion failures`,
      });
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ['label-diagnostics'] });
      qc.invalidateQueries({ queryKey: ['label-review'] });
    },
    onError: (e: any) => toast.error(`Commit failed: ${e?.message ?? e}`),
  });

  const diff = dryRun.data?.diffs ?? commit.data?.diffs ?? [];
  const shifts = (dryRun.data?.label_shifts ?? commit.data?.label_shifts ?? {}) as Record<string, number>;
  const shiftEntries = useMemo(() => Object.entries(shifts).sort((a, b) => b[1] - a[1]), [shifts]);

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Label Health Diagnostics</h3>
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▼ Skjul' : '▶ Vis'}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-4 text-xs">
          {diagQ.isLoading && <p className="text-muted-foreground">Laster diagnose…</p>}
          {diagQ.error && (
            <p className="text-red-600">Feil: {(diagQ.error as any)?.message ?? String(diagQ.error)}</p>
          )}
          {d && (
            <>
              {/* Distributions */}
              <div className="grid gap-3 md:grid-cols-2">
                <DistroBlock title="Confirmed label" map={d.confirmed} total={d.total} />
                <DistroBlock title="Auto-suggested label" map={d.suggested} total={d.total} />
              </div>

              {/* No trades + review status */}
              <div className="flex flex-wrap gap-2">
                <Pill label="num_trades = 0" value={d.no_trades} tone="slate" />
                <Pill label="needs_review (total)" value={d.needs_review.total} tone="yellow" />
                <Pill
                  label="needs_review · auto"
                  value={d.needs_review.by_source.auto ?? 0}
                  tone="yellow"
                />
                <Pill
                  label="needs_review · manual_override"
                  value={d.needs_review.by_source.manual_override ?? 0}
                  tone="blue"
                />
              </div>

              {/* kNN exclusion */}
              <div>
                <h4 className="font-semibold mb-1">kNN exclusion breakdown</h4>
                <div className="flex flex-wrap gap-2">
                  <Pill
                    label="excluded · no_trades"
                    value={d.knn_exclusion.excluded_no_trades}
                    tone="slate"
                  />
                  <Pill
                    label="excluded · needs_review (auto)"
                    value={d.knn_exclusion.excluded_needs_review_auto}
                    tone="yellow"
                  />
                  <Pill
                    label="included in kNN"
                    value={d.knn_exclusion.included}
                    tone="green"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {LABELS.map((l) => (
                    <span key={l} className={`rounded px-1.5 py-0.5 ${badge(l)}`}>
                      {l}: <strong>{d.knn_exclusion.included_by_label[l] ?? 0}</strong>
                    </span>
                  ))}
                </div>
              </div>

              {/* Disagreement matrix */}
              {d.disagreement.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-1">Disagreement (confirmed ≠ suggested)</h4>
                  <div className="overflow-x-auto">
                    <table className="text-xs">
                      <thead>
                        <tr className="text-muted-foreground">
                          <th className="pr-3 text-left">Confirmed</th>
                          <th className="pr-3 text-left">Suggested</th>
                          <th className="text-right">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.disagreement.slice(0, 20).map((row) => (
                          <tr key={`${row.confirmed}_${row.suggested}`} className="border-b border-muted/40">
                            <td className="pr-3">
                              <span className={`rounded px-1.5 py-0.5 ${badge(row.confirmed)}`}>{row.confirmed}</span>
                            </td>
                            <td className="pr-3">
                              <span className={`rounded px-1.5 py-0.5 ${badge(row.suggested)}`}>{row.suggested}</span>
                            </td>
                            <td className="text-right font-mono">{row.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Per strategy_version */}
              <div>
                <h4 className="font-semibold mb-1">Per strategy_version</h4>
                <div className="overflow-x-auto">
                  <table className="text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="pr-3 text-left">strategy_version</th>
                        {LABELS.map((l) => (
                          <th key={l} className="pr-3 text-right">{l}</th>
                        ))}
                        <th className="text-right">Σ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(d.per_strategy).map(([sv, m]) => {
                        const total = LABELS.reduce((s, k) => s + (m[k] ?? 0), 0);
                        return (
                          <tr key={sv} className="border-b border-muted/40">
                            <td className="pr-3 font-mono">{sv}</td>
                            {LABELS.map((l) => (
                              <td key={l} className="pr-3 text-right font-mono">{m[l] ?? 0}</td>
                            ))}
                            <td className="text-right font-mono">{total}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Suspicious rows */}
              <div>
                <h4 className="font-semibold mb-1">Mistenkelige rader (marginal / rejected)</h4>
                <div className="grid gap-2 md:grid-cols-2">
                  <SuspectCard
                    title="Positiv net%"
                    bucket={d.suspicious.positive_net}
                    onOpen={(rows) => setDrawer({ title: 'Positiv net% i marginal/rejected', rows })}
                  />
                  <SuspectCard
                    title="Profit factor > 1"
                    bucket={d.suspicious.profit_factor_gt_1}
                    onOpen={(rows) => setDrawer({ title: 'PF > 1 i marginal/rejected', rows })}
                  />
                  <SuspectCard
                    title="Win rate ≥ 50%"
                    bucket={d.suspicious.winrate_gte_50}
                    onOpen={(rows) => setDrawer({ title: 'Win rate ≥ 50% i marginal/rejected', rows })}
                  />
                  <SuspectCard
                    title="Recompute → profitable"
                    bucket={d.suspicious.recompute_would_upgrade}
                    onOpen={(rows) => setDrawer({ title: 'Recompute foreslår profitable+', rows })}
                  />
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground">
                Generert: {new Date(d.generated_at).toLocaleString()} ·{' '}
                <button className="underline" onClick={() => diagQ.refetch()}>refresh</button>
              </p>

              {/* Batch recompute */}
              <div className="rounded border border-muted/60 p-3 space-y-2">
                <h4 className="font-semibold">Recompute auto-suggested labels (trygg)</h4>
                <p className="text-muted-foreground text-[11px]">
                  Aldri rør confirmed label, label_source, TradingView-tall eller screener_snapshot.
                  Manual overrides får aldri needs_review=true av denne jobben.
                  num_trades = 0 → alltid no_trades (assertion).
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="rounded border bg-background px-2 py-1"
                    placeholder="strategy_version (optional)"
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value)}
                  />
                  <button
                    className="rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
                    disabled={dryRun.isPending}
                    onClick={() => dryRun.mutate()}
                  >
                    {dryRun.isPending ? 'Dry-running…' : 'Dry-run preview'}
                  </button>
                  <button
                    className="rounded bg-primary text-primary-foreground px-3 py-1 disabled:opacity-50"
                    disabled={!dryRun.data || dryRun.data.changed === 0 || commit.isPending}
                    onClick={() => setConfirmOpen(true)}
                  >
                    Commit changes
                  </button>
                </div>

                {(dryRun.data || commit.data) && (
                  <div className="text-[11px] space-y-2">
                    <div className="rounded bg-muted/40 p-2">
                      <strong>{dryRun.data?.dry_run === false || commit.data ? 'Result' : 'Dry-run'}:</strong>{' '}
                      {(commit.data ?? dryRun.data)!.scanned} scanned ·{' '}
                      {(commit.data ?? dryRun.data)!.changed} changed ·{' '}
                      {(commit.data ?? dryRun.data)!.updated} written ·{' '}
                      {(commit.data ?? dryRun.data)!.assertion_failures} assertion failures
                    </div>

                    {shiftEntries.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {shiftEntries.slice(0, 12).map(([k, v]) => {
                          const [from, to] = k.split('>>');
                          return (
                            <span key={k} className="rounded bg-muted px-1.5 py-0.5">
                              <span className={`rounded px-1 ${badge(from)}`}>{from}</span>
                              {' → '}
                              <span className={`rounded px-1 ${badge(to)}`}>{to}</span>
                              {' '}<strong>{v}</strong>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {diff.length > 0 && (
                      <div className="max-h-72 overflow-auto rounded border">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 bg-background">
                            <tr className="text-left text-muted-foreground border-b">
                              <th className="px-2 py-1">Symbol</th>
                              <th className="px-2 py-1">Date</th>
                              <th className="px-2 py-1">Confirmed</th>
                              <th className="px-2 py-1">Source</th>
                              <th className="px-2 py-1">Current auto</th>
                              <th className="px-2 py-1">New auto</th>
                              <th className="px-2 py-1 text-right">Q (old → new)</th>
                              <th className="px-2 py-1">Review?</th>
                            </tr>
                          </thead>
                          <tbody>
                            {diff.map((r) => (
                              <tr key={r.id} className={`border-b ${r.changed ? 'bg-yellow-500/5' : ''}`}>
                                <td className="px-2 py-1 font-mono">{r.symbol}</td>
                                <td className="px-2 py-1 font-mono text-muted-foreground">{r.test_date}</td>
                                <td className="px-2 py-1">
                                  <span className={`rounded px-1 ${badge(r.confirmed_label)}`}>{r.confirmed_label}</span>
                                </td>
                                <td className="px-2 py-1 text-[10px] text-muted-foreground">{r.label_source}</td>
                                <td className="px-2 py-1">{r.current_auto ?? '—'}</td>
                                <td className="px-2 py-1">
                                  <span className={`rounded px-1 ${badge(r.new_auto)}`}>{r.new_auto}</span>
                                </td>
                                <td className="px-2 py-1 text-right font-mono">
                                  {r.current_quality?.toFixed(0) ?? '—'} → {r.new_quality.toFixed(0)}
                                </td>
                                <td className="px-2 py-1">
                                  {r.will_set_needs_review ? '⚠' : r.label_source === 'manual_override' ? 'manual' : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <button
                      className="text-[11px] underline text-muted-foreground"
                      onClick={() => csvDownload(diff, 'label-recompute-diff.csv')}
                    >
                      Eksporter diff som CSV
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Drawer for suspect rows */}
      {drawer && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center"
          onClick={() => setDrawer(null)}
        >
          <div
            className="bg-background w-full md:max-w-3xl md:rounded-t md:rounded-b border-t md:border max-h-[80vh] overflow-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">{drawer.title}</h3>
              <div className="flex items-center gap-2">
                <button
                  className="text-[11px] underline text-muted-foreground"
                  onClick={() => csvDownload(drawer.rows, 'suspect-rows.csv')}
                >
                  CSV
                </button>
                <button className="text-xs" onClick={() => setDrawer(null)}>Lukk ✕</button>
              </div>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1 pr-2">Symbol</th>
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2">Label</th>
                  <th className="py-1 pr-2">Suggested</th>
                  <th className="py-1 pr-2">Recompute</th>
                  <th className="py-1 pr-2 text-right">Net%</th>
                  <th className="py-1 pr-2 text-right">PF</th>
                  <th className="py-1 pr-2 text-right">Win%</th>
                  <th className="py-1 pr-2 text-right">Trades</th>
                </tr>
              </thead>
              <tbody>
                {drawer.rows.map((r) => (
                  <tr key={r.id} className="border-b">
                    <td className="py-1 pr-2 font-mono">{r.symbol}</td>
                    <td className="py-1 pr-2 font-mono text-muted-foreground">{r.test_date}</td>
                    <td className="py-1 pr-2"><span className={`rounded px-1 ${badge(r.label)}`}>{r.label}</span></td>
                    <td className="py-1 pr-2">{r.auto_suggested_label ?? '—'}</td>
                    <td className="py-1 pr-2"><span className={`rounded px-1 ${badge(r.recomputed_suggestion)}`}>{r.recomputed_suggestion}</span></td>
                    <td className="py-1 pr-2 text-right font-mono">{r.net_profit_pct?.toFixed(1) ?? '—'}</td>
                    <td className="py-1 pr-2 text-right font-mono">{r.profit_factor?.toFixed(2) ?? '—'}</td>
                    <td className="py-1 pr-2 text-right font-mono">{r.win_rate_pct?.toFixed(1) ?? '—'}</td>
                    <td className="py-1 pr-2 text-right font-mono">{r.num_trades ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Commit confirm */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-background w-full max-w-md rounded border p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">Bekreft commit</h3>
            <p className="text-xs text-muted-foreground">
              Skriver auto_suggested_label, quality, diagnostics og needs_review
              for {dryRun.data?.changed ?? 0} rader. Aldri confirmed label,
              label_source, TradingView-tall eller screener_snapshot.
              Strategy filter: <strong>{strategy || '(alle)'}</strong>.
            </p>
            <div className="flex justify-end gap-2">
              <button className="rounded border px-3 py-1 text-xs" onClick={() => setConfirmOpen(false)}>
                Avbryt
              </button>
              <button
                className="rounded bg-primary text-primary-foreground px-3 py-1 text-xs disabled:opacity-50"
                disabled={commit.isPending}
                onClick={() => commit.mutate()}
              >
                {commit.isPending ? 'Skriver…' : 'Bekreft og skriv'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function DistroBlock({ title, map, total }: { title: string; map: Record<string, number>; total: number }) {
  return (
    <div>
      <h4 className="font-semibold mb-1">{title}</h4>
      <div className="flex flex-wrap gap-1.5">
        {LABELS.map((l) => (
          <span key={l} className={`rounded px-1.5 py-0.5 ${badge(l)}`}>
            {l}: <strong>{map[l] ?? 0}</strong>
          </span>
        ))}
        <span className="rounded px-1.5 py-0.5 bg-muted">Σ <strong>{total}</strong></span>
      </div>
    </div>
  );
}

function Pill({ label, value, tone }: { label: string; value: number; tone: 'slate' | 'yellow' | 'green' | 'blue' }) {
  const cls = {
    slate: 'bg-slate-400/20 text-slate-700',
    yellow: 'bg-yellow-500/20 text-yellow-700',
    green: 'bg-green-500/20 text-green-700',
    blue: 'bg-blue-500/20 text-blue-700',
  }[tone];
  return (
    <span className={`rounded px-2 py-1 ${cls}`}>
      {label}: <strong>{value}</strong>
    </span>
  );
}

function SuspectCard({
  title,
  bucket,
  onOpen,
}: {
  title: string;
  bucket: { count: number; top: any[] };
  onOpen: (rows: any[]) => void;
}) {
  return (
    <div className="rounded border border-muted/50 p-2 flex items-center justify-between">
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-muted-foreground text-[11px]">{bucket.count} rader</div>
      </div>
      <button
        className="text-[11px] rounded border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
        disabled={bucket.count === 0}
        onClick={() => onOpen(bucket.top)}
      >
        Vis topp 10
      </button>
    </div>
  );
}
