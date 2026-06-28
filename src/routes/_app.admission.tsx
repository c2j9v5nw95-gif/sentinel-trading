import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { startAdmissionRun } from '@/lib/admission/admission.functions';
import { PageHeader, Card, EmptyState } from '@/components/PageHeader';

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
};

type Result = {
  id: string;
  symbol: string;
  status: 'approved' | 'watchlist' | 'rejected';
  score: number | null;
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
  fetch_error: string | null;
};

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

function AdmissionPage() {
  const qc = useQueryClient();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [maxSymbols, setMaxSymbols] = useState<string>('150');
  const [skipWick, setSkipWick] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'watchlist' | 'rejected'>('approved');
  const [search, setSearch] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  // Auto-select first profile
  const firstProfile = profilesQ.data?.[0]?.id;
  if (firstProfile && !selectedProfileId) setSelectedProfileId(firstProfile);

  const runsQ = useQuery({
    queryKey: ['admission-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('coin_admission_runs')
        .select('id, started_at, finished_at, profile_name, status, symbols_total, progress_done, approved_n, watchlist_n, rejected_n, error')
        .order('started_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as Run[];
    },
    refetchInterval: 4000,
  });

  // Pick latest completed run by default
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
        .order('score', { ascending: false, nullsFirst: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as Result[];
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
    const all = resultsQ.data ?? [];
    return all.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (search && !r.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [resultsQ.data, statusFilter, search]);

  const counts = useMemo(() => {
    const all = resultsQ.data ?? [];
    return {
      approved: all.filter((r) => r.status === 'approved').length,
      watchlist: all.filter((r) => r.status === 'watchlist').length,
      rejected: all.filter((r) => r.status === 'rejected').length,
      total: all.length,
    };
  }, [resultsQ.data]);

  const selectedProfile = profilesQ.data?.find((p) => p.id === selectedProfileId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Coin Admission Screener"
        description="Pre-kvalifisering av Bybit USDT perpetuals før de legges inn i botens univers. Påvirker IKKE pågående trading."
      />

      <Card>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Kjør ny vurdering</h3>
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
                Maks symboler (sortert på 24h turnover)
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
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={skipWick}
                  onChange={(e) => setSkipWick(e.target.checked)}
                />
                Hopp over wick-analyse (raskere)
              </label>
            </div>
            <div className="flex items-end">
              <button
                className="rounded bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={startRun.isPending || !selectedProfileId}
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
              <strong>{startRun.data.rejected}</strong> rejected
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
                      <td className="py-1 pr-2 font-mono text-xs">
                        {new Date(r.started_at).toLocaleString()}
                      </td>
                      <td className="py-1 pr-2">{r.profile_name}</td>
                      <td className="py-1 pr-2">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          r.status === 'completed' ? 'bg-green-500/20 text-green-700' :
                          r.status === 'failed' ? 'bg-red-500/20 text-red-700' :
                          'bg-yellow-500/20 text-yellow-700'
                        }`}>{r.status}</span>
                      </td>
                      <td className="py-1 pr-2 text-xs">
                        {r.progress_done ?? 0} / {r.symbols_total ?? '?'}
                      </td>
                      <td className="py-1 pr-2 text-xs">
                        <span className="text-green-600">{r.approved_n ?? 0}</span>
                        {' / '}
                        <span className="text-yellow-600">{r.watchlist_n ?? 0}</span>
                        {' / '}
                        <span className="text-red-600">{r.rejected_n ?? 0}</span>
                      </td>
                      <td className="py-1 text-right">
                        <button
                          className="text-xs underline"
                          onClick={() => setSelectedRunId(r.id)}
                        >
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

      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold mr-auto">
            Resultater
            {activeRunId && (
              <span className="ml-2 text-xs text-muted-foreground">
                ({counts.approved} approved · {counts.watchlist} watchlist · {counts.rejected} rejected · {counts.total} totalt)
              </span>
            )}
          </h3>
          <input
            className="rounded border bg-background px-2 py-1 text-sm"
            placeholder="Søk symbol…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {(['all', 'approved', 'watchlist', 'rejected'] as const).map((s) => (
            <button
              key={s}
              className={`rounded px-2 py-1 text-xs ${
                statusFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted'
              }`}
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>

        {!activeRunId ? (
          <EmptyState title="Velg en kjøring" hint="Trykk vis på en kjøring over for å se resultatene." />
        ) : resultsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Laster resultater…</p>
        ) : filteredResults.length === 0 ? (
          <EmptyState title="Ingen treff" hint="Endre filter eller søkeord." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-1 pr-2">Symbol</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2 text-right">Score</th>
                  <th className="py-1 pr-2 text-right">Rank</th>
                  <th className="py-1 pr-2 text-right">24h TO</th>
                  <th className="py-1 pr-2 text-right">7d med</th>
                  <th className="py-1 pr-2 text-right">OI</th>
                  <th className="py-1 pr-2 text-right">Spread bps</th>
                  <th className="py-1 pr-2 text-right">Age d</th>
                  <th className="py-1 pr-2 text-right">Funding</th>
                  <th className="py-1 pr-2 text-right">Max 1h wick %</th>
                  <th className="py-1 pr-2">Kill rules</th>
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
                          <span className={`rounded px-1.5 py-0.5 text-xs ${
                            r.status === 'approved' ? 'bg-green-500/20 text-green-700' :
                            r.status === 'watchlist' ? 'bg-yellow-500/20 text-yellow-700' :
                            'bg-red-500/20 text-red-700'
                          }`}>{r.status}</span>
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">{fmtNum(r.score, 1)}</td>
                        <td className="py-1 pr-2 text-right">{r.rank ?? '—'}</td>
                        <td className="py-1 pr-2 text-right">{fmtUsd(r.turnover_24h)}</td>
                        <td className="py-1 pr-2 text-right">{fmtUsd(r.turnover_7d_median)}</td>
                        <td className="py-1 pr-2 text-right">{fmtUsd(r.open_interest_value)}</td>
                        <td className="py-1 pr-2 text-right">{fmtNum(r.spread_bps, 2)}</td>
                        <td className="py-1 pr-2 text-right">{r.listing_age_days ?? '—'}</td>
                        <td className="py-1 pr-2 text-right">
                          {r.funding_rate != null ? `${(r.funding_rate * 100).toFixed(4)}%` : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right">{fmtNum(r.max_1h_drop_pct, 1)}</td>
                        <td className="py-1 pr-2 text-xs text-red-600">
                          {(r.kill_rules_triggered ?? []).join(', ')}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr key={`${r.id}-x`} className="border-b bg-muted/20">
                          <td colSpan={12} className="p-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              <div>
                                <h4 className="font-semibold mb-1">Score-komponenter (0–100)</h4>
                                <pre className="rounded bg-background p-2 overflow-auto">
                                  {JSON.stringify(r.components ?? {}, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <h4 className="font-semibold mb-1">Rådata</h4>
                                <pre className="rounded bg-background p-2 overflow-auto">
                                  {JSON.stringify({
                                    wick_risk_score: r.wick_risk_score,
                                    fetch_error: r.fetch_error,
                                    kill_rules: r.kill_rules_triggered,
                                  }, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
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
