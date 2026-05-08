import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, EmptyState } from "@/components/PageHeader";

const KIND_TONE: Record<string, string> = {
  entry: "bg-primary/15 text-primary border-primary/30",
  exit: "bg-warning/15 text-warning border-warning/40",
  replay: "bg-accent text-accent-foreground border-border",
  reconcile: "bg-muted text-muted-foreground border-border",
  protect: "bg-success/15 text-success border-success/30",
  manual: "bg-danger/15 text-danger border-danger/40",
};

function KindChip({ kind }: { kind: string }) {
  const cls = KIND_TONE[kind] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {kind}
    </span>
  );
}

function fmtAge(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h`;
}

export function ExecutionLocksPanel() {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["execution_locks"],
    queryFn: async () => {
      const { data } = await supabase
        .from("current_execution_locks")
        .select("*")
        .order("acquired_at", { ascending: true });
      return data ?? [];
    },
    refetchInterval: 2_000,
  });

  const steal = useMutation({
    mutationFn: async (symbol: string) => {
      const { error, data } = await supabase.rpc("steal_execution_lock", { _symbol: symbol });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["execution_locks"] }),
  });

  return (
    <Card title="Execution locks">
      {(data?.length ?? 0) === 0 ? (
        <EmptyState title="No symbol locks held" hint="Active executions will appear here." />
      ) : (
        <table className="w-full text-sm tabular">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-2">Symbol</th>
              <th>Kind</th>
              <th>Owner</th>
              <th>Age</th>
              <th>Heartbeat</th>
              <th>Expires in</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data!.map((l: any) => {
              const stale = l.is_stale as boolean;
              const dying = !stale && (l.heartbeat_age_seconds ?? 0) > Math.max(15, l.ttl_seconds * 0.66);
              const rowCls = stale ? "bg-danger/5" : dying ? "bg-warning/5" : "";
              return (
                <tr key={l.symbol} className={rowCls}>
                  <td className="py-2 font-medium">{l.symbol}</td>
                  <td><KindChip kind={l.kind} /></td>
                  <td className="font-mono text-[11px] text-muted-foreground" title={l.owner_id}>
                    {String(l.owner_id).slice(0, 8)}…
                  </td>
                  <td>{fmtAge(l.age_seconds ?? 0)}</td>
                  <td className={dying ? "text-warning" : "text-muted-foreground"}>
                    {fmtAge(l.heartbeat_age_seconds ?? 0)} ago
                  </td>
                  <td className={stale ? "text-danger" : ""}>
                    {stale ? "expired" : `${l.seconds_until_expiry}s`}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Steal lock on ${l.symbol}? This forces the holder to abort.`)) {
                          steal.mutate(l.symbol);
                        }
                      }}
                      disabled={steal.isPending}
                      className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      Steal
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Exits automatically preempt entries / reconciles / protects on the same symbol.
        Stuck locks expire automatically after their TTL; use <em>Steal</em> only as a manual override.
      </p>
    </Card>
  );
}
