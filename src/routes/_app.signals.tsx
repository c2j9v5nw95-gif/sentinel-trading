import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { replaySignal } from "@/lib/signals.functions";

export const Route = createFileRoute("/_app/signals")({
  component: SignalsPage,
});

type Signal = {
  id: string;
  created_at: string;
  transport: string;
  symbol: string | null;
  action: string | null;
  strategy: string | null;
  tag: string | null;
  portion: string;
  status: string;
  decision_reason: string | null;
  decision_trail: Array<{ step: string; outcome: string; reason?: string; metrics?: Record<string, unknown>; at: string }> | null;
  replay_of: string | null;
  retry_count: number | null;
  error_stack: string | null;
};

type DiagnosticRow = {
  id: string;
  mode: string;
  ok: boolean;
  created_at: string;
  checks: Record<string, unknown> | null;
};

function SignalsPage() {
  const qc = useQueryClient();
  const replay = useServerFn(replaySignal);
  const [selected, setSelected] = useState<Signal | null>(null);
  const [bypass, setBypass] = useState(false);

  const all = useQuery({
    queryKey: ["signals"],
    queryFn: async () => {
      const { data } = await supabase.from("signals").select("*")
        .order("created_at", { ascending: false }).limit(200);
      return (data ?? []) as Signal[];
    },
    refetchInterval: 5_000,
  });

  const dead = (all.data ?? []).filter((s) => s.status === "dead_letter");
  const live = (all.data ?? []).filter((s) => s.status !== "dead_letter");

  const diagnostics = useQuery({
    queryKey: ["bybit_diagnostics", "live", "gate_debug"],
    queryFn: async () => {
      const { data } = await supabase.from("bybit_diagnostics")
        .select("id,mode,ok,created_at,checks")
        .eq("mode", "live")
        .eq("ok", true)
        .order("created_at", { ascending: false })
        .limit(25);
      return (data ?? []) as DiagnosticRow[];
    },
    refetchInterval: 5_000,
  });

  const latestGateBlock = live.find((s) => s.decision_reason?.startsWith("live_gate:alternate_base_requires_passing_diagnostic")) ?? null;

  const replayMut = useMutation({
    mutationFn: async (args: { signalId: string; bypassDedupe: boolean }) => {
      try {
        return await replay({ data: args });
      } catch (err) {
        // Middleware (requireSupabaseAuth) throws raw Response BEFORE .handler() runs,
        // so it bypasses server-side normalization. Convert here so we don't see "[object Response]".
        if (err instanceof Response) {
          const body = await err.text().catch(() => err.statusText);
          throw new Error(`Replay failed (${err.status}): ${body || err.statusText}`);
        }
        if (err instanceof Error) throw err;
        throw new Error(typeof err === "string" ? err : JSON.stringify(err));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["signals"] }),
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface readable error in the sheet via alert as a fallback (replaces blank-screen [object Response])
      console.error("[replaySignal] failed:", msg);
      alert(`Replay failed: ${msg}`);
    },
  });

  return (
    <>
      <PageHeader title="Signals" description="Normalized + deduped signal stream with full decision trail." />

      <LiveGateDebugPanel diagnostics={diagnostics.data ?? []} latestGateBlock={latestGateBlock} />

      {dead.length > 0 && (
        <Card title={`Dead-letter queue (${dead.length})`}>
          <SignalTable rows={dead} onSelect={setSelected} dead />
        </Card>
      )}

      <Card>
        {(live.length === 0) ? (
          <EmptyState title="No signals yet" />
        ) : (
          <SignalTable rows={live} onSelect={setSelected} />
        )}
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[480px] sm:w-[560px] sm:max-w-[560px] overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {selected.action ?? "—"} {selected.symbol ?? ""}
                </SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded bg-muted">status: {selected.status}</span>
                  <span className="px-2 py-0.5 rounded bg-muted">transport: {selected.transport}</span>
                  <span className="px-2 py-0.5 rounded bg-muted">portion: {selected.portion}</span>
                  {selected.replay_of && (
                    <span className="px-2 py-0.5 rounded bg-muted">↺ replay of {selected.replay_of.slice(0, 8)}</span>
                  )}
                  {(selected.retry_count ?? 0) > 0 && (
                    <span className="px-2 py-0.5 rounded bg-muted">retries: {selected.retry_count}</span>
                  )}
                </div>
                {selected.decision_reason && (
                  <div>
                    <div className="text-xs uppercase text-muted-foreground mb-1">Decision</div>
                    <div className="font-mono text-xs break-all">{selected.decision_reason}</div>
                    {selected.decision_reason.startsWith("bybit_transport_") && (
                      <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-muted-foreground">
                        <strong className="text-destructive">Cloudflare/WAF/egress block.</strong>{" "}
                        The request was rejected by an upstream edge before reaching Bybit. This is not an API-key issue.
                        Open <span className="font-mono">Settings → Bybit diagnostics</span> and run the live check —
                        the <em>order endpoint reachability</em> row shows the cf-ray, server and body snippet you can forward to Bybit support.
                        Workaround: set the <code>BYBIT_API_BASE_URL</code> secret to <code>https://api.bytick.com</code>.
                      </div>
                    )}
                  </div>
                )}
                <div>
                  <div className="text-xs uppercase text-muted-foreground mb-2">Decision trail</div>
                  <ol className="space-y-1">
                    {(selected.decision_trail ?? []).map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <span
                          className={
                            "mt-0.5 inline-block w-14 text-[10px] uppercase tracking-wide " +
                            (s.outcome === "fail" ? "text-destructive"
                              : s.outcome === "pass" ? "text-success"
                              : "text-muted-foreground")
                          }
                        >
                          {s.outcome}
                        </span>
                        <span className="font-mono">{s.step}</span>
                        {s.reason && <span className="text-muted-foreground">— {s.reason}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
                {selected.error_stack && (
                  <div>
                    <div className="text-xs uppercase text-muted-foreground mb-1">Error stack</div>
                    <pre className="text-[10px] bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap">{selected.error_stack}</pre>
                  </div>
                )}
                <div className="flex items-center gap-3 pt-2 border-t border-border">
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
                    Bypass dedupe
                  </label>
                  <Button
                    size="sm"
                    onClick={() => replayMut.mutate({ signalId: selected.id, bypassDedupe: bypass })}
                    disabled={replayMut.isPending}
                  >
                    {replayMut.isPending ? "Replaying…" : "Replay signal"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function LiveGateDebugPanel({ diagnostics, latestGateBlock }: { diagnostics: DiagnosticRow[]; latestGateBlock: Signal | null }) {
  const FRESHNESS_MS = 24 * 60 * 60 * 1000;
  const parsedBlockedBase = latestGateBlock?.decision_reason?.match(/alternate_base_requires_passing_diagnostic:([^\s]+)/)?.[1] ?? null;
  const latestPassing = diagnostics[0] ?? null;
  const latestChecks = latestPassing?.checks as Record<string, any> | null;
  const meta = latestChecks?._meta?.detail ?? latestChecks?._meta ?? null;
  const activeBase = parsedBlockedBase ?? meta?.base_url ?? "unknown";
  const symbol = latestGateBlock?.symbol ?? meta?.symbol ?? latestChecks?.read_positions_by_symbol?.detail?.query?.symbol ?? "any";
  const matched = diagnostics.find((d) => {
    const checks = d.checks as Record<string, any> | null;
    const dMeta = checks?._meta?.detail ?? checks?._meta ?? null;
    const age = Date.now() - new Date(d.created_at).getTime();
    return dMeta?.base_url === activeBase && age <= FRESHNESS_MS;
  }) ?? null;
  const ageMs = matched ? Date.now() - new Date(matched.created_at).getTime() : null;
  const whyBlocked = latestGateBlock?.decision_reason ?? (matched ? "gate_has_recent_matching_diagnostic" : "no_recent_matching_diagnostic_visible_to_ui");

  return (
    <Card title="Temporary live gate debug">
      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <DebugItem label="Active base_url" value={activeBase} />
        <DebugItem label="Lookup mode" value="live" />
        <DebugItem label="Lookup symbol" value={symbol ?? "any"} />
        <DebugItem label="Gate decision" value={matched ? "matching diagnostic visible" : "blocked / no match"} tone={matched ? "ok" : "bad"} />
        <DebugItem label="Latest passing diagnostic" value={latestPassing ? latestPassing.id : "none"} />
        <DebugItem label="Selected diagnostic" value={matched ? matched.id : "none"} tone={matched ? "ok" : "bad"} />
        <DebugItem label="Passed at" value={matched ? new Date(matched.created_at).toLocaleString() : "—"} />
        <DebugItem label="Age" value={ageMs == null ? "—" : `${Math.round(ageMs / 60000)}m`} />
      </div>
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
        <div className="mb-1 text-muted-foreground">Executor lookup query</div>
        <code className="break-all">
          bybit_diagnostics where mode=live and ok=true order by created_at desc limit 25; expected base_url={activeBase}; freshness=24h
        </code>
      </div>
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
        <div className="mb-1 text-muted-foreground">Why gate blocked / current decision input</div>
        <code className="break-all">{whyBlocked}</code>
      </div>
    </Card>
  );
}

function DebugItem({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={"mt-1 break-all font-mono " + (tone === "ok" ? "text-success" : tone === "bad" ? "text-destructive" : "")}>{value}</div>
    </div>
  );
}

function SignalTable({ rows, onSelect, dead }: { rows: Signal[]; onSelect: (s: Signal) => void; dead?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2">Time</th>
            <th>Transport</th>
            <th>Symbol</th>
            <th>Action</th>
            <th>Strategy</th>
            <th>Tag</th>
            <th>Portion</th>
            <th>Status</th>
            <th>Decision</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((s) => (
            <tr
              key={s.id}
              className={"cursor-pointer hover:bg-muted/40 " + (dead ? "bg-destructive/5" : "")}
              onClick={() => onSelect(s)}
            >
              <td className="py-2 text-xs text-muted-foreground">
                {new Date(s.created_at).toLocaleTimeString()}
              </td>
              <td className="text-xs">{s.transport}</td>
              <td className="font-medium">
                {s.symbol ?? "—"}
                {s.replay_of && <span className="ml-1 text-[10px] text-muted-foreground">↺</span>}
              </td>
              <td>{s.action ?? "—"}</td>
              <td>{s.strategy ?? "—"}</td>
              <td className="text-xs text-muted-foreground">{s.tag}</td>
              <td className="text-xs">{s.portion}</td>
              <td
                className={
                  s.status === "rejected" || s.status === "error" || s.status === "dead_letter"
                    ? "text-destructive text-xs uppercase"
                    : s.status === "accepted"
                    ? "text-success text-xs uppercase"
                    : "text-xs uppercase text-muted-foreground"
                }
              >
                {s.status}
              </td>
              <td className="text-xs text-muted-foreground max-w-[280px] truncate" title={s.decision_reason ?? ""}>
                {s.decision_reason ?? "—"}
              </td>
              <td className="text-xs text-muted-foreground">→</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
