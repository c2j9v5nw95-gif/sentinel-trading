import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { useState } from "react";

export const Route = createFileRoute("/_app/invariants")({
  component: InvariantsPage,
});

function HealthDial({ score }: { score: number }) {
  const color =
    score >= 90 ? "text-success" :
    score >= 70 ? "text-warning" : "text-danger";
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-4xl font-semibold tabular ${color}`}>{score}</span>
      <span className="text-xs text-muted-foreground">/100 health</span>
    </div>
  );
}

function SeverityChip({ s }: { s: string }) {
  const cls = s === "critical"
    ? "bg-danger/15 text-danger border-danger/40"
    : s === "warning"
    ? "bg-warning/15 text-warning border-warning/40"
    : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase ${cls}`}>{s}</span>;
}

function InvariantsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"current" | "history" | "settings">("current");

  const { data: lastRun } = useQuery({
    queryKey: ["inv-run-last"],
    queryFn: async () => {
      const { data } = await supabase.from("invariant_runs")
        .select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
      return data;
    },
    refetchInterval: 5_000,
  });

  const { data: open } = useQuery({
    queryKey: ["inv-open"],
    queryFn: async () => {
      const { data } = await supabase.from("invariant_violations")
        .select("*").is("resolved_at", null).order("severity").order("last_seen_at", { ascending: false });
      return data ?? [];
    },
    refetchInterval: 5_000,
  });

  const { data: history } = useQuery({
    queryKey: ["inv-history"],
    queryFn: async () => {
      const { data } = await supabase.from("invariant_runs")
        .select("*").order("started_at", { ascending: false }).limit(50);
      return data ?? [];
    },
    refetchInterval: 10_000,
  });

  const { data: settings } = useQuery({
    queryKey: ["app-settings-inv"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("*").maybeSingle();
      return data;
    },
  });

  const ack = useMutation({
    mutationFn: async ({ id, note }: { id: string; note: string }) => {
      const { error } = await supabase.rpc("acknowledge_invariant_violation", { _id: id, _note: note });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inv-open"] }),
  });

  const triggerScan = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke("invariant-monitor");
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inv-open"] });
      qc.invalidateQueries({ queryKey: ["inv-run-last"] });
      qc.invalidateQueries({ queryKey: ["inv-history"] });
    },
  });

  const toggleAutoPause = useMutation({
    mutationFn: async (val: boolean) => {
      const { error } = await supabase.from("app_settings")
        .update({ auto_pause_on_critical_invariant: val }).eq("singleton", true);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app-settings-inv"] }),
  });

  const score = lastRun?.health_score ?? 100;

  return (
    <>
      <PageHeader
        title="Invariants"
        description="Continuous safety assertions over the execution engine state."
        actions={
          <button
            onClick={() => triggerScan.mutate()}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-accent"
          >
            Run scan now
          </button>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <Card title="Health score">
          <HealthDial score={score} />
          <div className="mt-1 text-xs text-muted-foreground">
            {lastRun ? `Last scan ${new Date(lastRun.started_at).toLocaleTimeString()}` : "No scans yet"}
          </div>
        </Card>
        <Card title="Critical">
          <div className="text-3xl font-semibold tabular text-danger">{lastRun?.critical_count ?? 0}</div>
        </Card>
        <Card title="Warning">
          <div className="text-3xl font-semibold tabular text-warning">{lastRun?.warning_count ?? 0}</div>
        </Card>
        <Card title="Rules failed">
          <div className="text-3xl font-semibold tabular">
            {lastRun?.checks_failed ?? 0}<span className="text-sm text-muted-foreground">/{lastRun?.checks_total ?? 9}</span>
          </div>
          {lastRun?.auto_paused && (
            <div className="mt-1 text-xs font-medium text-danger">Entries auto-paused</div>
          )}
        </Card>
      </div>

      <div className="mb-3 flex gap-1 border-b border-border">
        {(["current", "history", "settings"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm capitalize border-b-2 -mb-px ${
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "current" && (
        <Card>
          {(open?.length ?? 0) === 0 ? (
            <EmptyState title="No active violations" hint="All invariants pass." />
          ) : (
            <ul className="divide-y divide-border">
              {open!.map((v) => (
                <li key={v.id} className="flex items-start gap-3 py-3">
                  <SeverityChip s={v.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{v.rule_label}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{v.rule_code}</span>
                      <span className="text-[10px] text-muted-foreground">{v.target_kind}:{v.target_key.slice(0, 12)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{v.message}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      first {new Date(v.first_seen_at).toLocaleString()} · seen ×{v.occurrences}
                      {v.acknowledged_at && (
                        <span className="ml-2 text-success">
                          ack {new Date(v.acknowledged_at).toLocaleTimeString()}
                          {v.ack_note && ` — ${v.ack_note}`}
                        </span>
                      )}
                    </div>
                  </div>
                  {!v.acknowledged_at && (
                    <button
                      onClick={() => {
                        const note = window.prompt("Acknowledgement note (optional)") ?? "";
                        ack.mutate({ id: v.id, note });
                      }}
                      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                    >
                      Acknowledge
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === "history" && (
        <Card>
          {(history?.length ?? 0) === 0 ? (
            <EmptyState title="No scans yet" />
          ) : (
            <div className="space-y-2">
              {history!.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-md border border-border bg-card/50 px-3 py-2">
                  <div className="w-20 text-xs tabular text-muted-foreground">
                    {new Date(r.started_at).toLocaleTimeString()}
                  </div>
                  <div className="flex-1">
                    <div className="h-1.5 w-full rounded-full bg-muted">
                      <div
                        className={`h-1.5 rounded-full ${
                          r.health_score >= 90 ? "bg-success" : r.health_score >= 70 ? "bg-warning" : "bg-danger"
                        }`}
                        style={{ width: `${r.health_score}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-12 text-right text-xs font-medium tabular">{r.health_score}</div>
                  <div className="w-20 text-right text-xs">
                    <span className="text-danger">{r.critical_count}c</span>{" "}
                    <span className="text-warning">{r.warning_count}w</span>
                  </div>
                  {r.auto_paused && <span className="text-[10px] font-medium text-danger">PAUSED</span>}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "settings" && (
        <Card>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={!!settings?.auto_pause_on_critical_invariant}
              onChange={(e) => toggleAutoPause.mutate(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">Auto-pause entries on critical invariant violation</div>
              <div className="text-xs text-muted-foreground">
                When enabled, the next scan that detects a critical violation will set <code>entries_paused = true</code>.
                Exits and protection updates continue. Operator must manually re-enable entries.
              </div>
            </div>
          </label>
        </Card>
      )}
    </>
  );
}
