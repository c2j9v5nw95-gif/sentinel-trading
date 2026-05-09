import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface BridgeHealthRow {
  id: string;
  checked_at: string;
  ok: boolean;
  latency_ms: number | null;
  http_status: number | null;
  bridge_version: string | null;
  public_ip: string | null;
  region: string | null;
  bybit_reachable: boolean | null;
  error: string | null;
}

interface PingResponse {
  ok: boolean;
  configured: boolean;
  result: {
    ok: boolean;
    latency_ms: number;
    public_ip: string | null;
    region: string | null;
    bridge_version: string | null;
    bybit_reachable: boolean | null;
    error: string | null;
  };
}

export function BridgeStatusPanel() {
  const qc = useQueryClient();

  const { data: rows } = useQuery({
    queryKey: ["bridge_health_checks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bridge_health_checks")
        .select("*")
        .order("checked_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as BridgeHealthRow[];
    },
    refetchInterval: 30_000,
  });

  const ping = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<PingResponse>("op-bridge-health", { method: "POST" });
      if (error) throw error;
      return data!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bridge_health_checks"] }),
  });

  const last = rows?.[0];
  const fmtAge = (iso: string) => {
    const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Execution bridge</h3>
          <p className="text-xs text-muted-foreground">
            Private VPS that owns the Bybit-whitelisted IP and performs all signed live calls.
          </p>
        </div>
        <button
          onClick={() => ping.mutate()}
          disabled={ping.isPending}
          className="rounded border border-border bg-card px-2 py-1 text-xs hover:bg-accent"
        >
          {ping.isPending ? "Checking…" : "Run health check"}
        </button>
      </div>

      {ping.error && (
        <p className="mb-2 text-xs text-danger">Health check failed: {(ping.error as Error).message}</p>
      )}

      {!last && (
        <p className="text-xs text-muted-foreground">
          No health checks yet. Click <em>Run health check</em>. If the bridge isn't deployed yet, configure
          <code className="mx-1">EXECUTION_BRIDGE_URL</code> and
          <code className="mx-1">EXECUTION_BRIDGE_SECRET</code> in secrets and stand up the VPS — see
          <code className="mx-1">bridge/README.md</code>.
        </p>
      )}

      {last && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Stat label="Status" value={last.ok ? "Healthy" : "Down"} tone={last.ok ? "ok" : "danger"} />
            <Stat label="Latency" value={last.latency_ms != null ? `${last.latency_ms} ms` : "—"} />
            <Stat label="Bybit reachable" value={last.bybit_reachable == null ? "—" : last.bybit_reachable ? "Yes" : "No"} tone={last.bybit_reachable === false ? "danger" : undefined} />
            <Stat label="Last check" value={fmtAge(last.checked_at)} />
            <Stat label="Public IP" value={last.public_ip ?? "—"} mono />
            <Stat label="Region" value={last.region ?? "—"} />
            <Stat label="Version" value={last.bridge_version ?? "—"} mono />
            <Stat label="HTTP" value={last.http_status?.toString() ?? "—"} />
          </div>
          {last.error && (
            <p className="text-xs text-danger">Last error: {last.error}</p>
          )}
          <div className="mt-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Recent checks</div>
            <div className="flex gap-1">
              {rows!.slice().reverse().map((r) => (
                <div
                  key={r.id}
                  title={`${r.ok ? "ok" : "fail"} • ${r.latency_ms ?? "—"}ms • ${new Date(r.checked_at).toLocaleString()}${r.error ? ` • ${r.error}` : ""}`}
                  className={`h-4 w-2 rounded-sm ${r.ok ? "bg-success" : "bg-destructive"}`}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, mono }: { label: string; value: string; tone?: "ok" | "danger"; mono?: boolean }) {
  const toneCls = tone === "ok" ? "text-success" : tone === "danger" ? "text-danger" : "text-foreground";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xs ${toneCls} ${mono ? "font-mono" : "font-medium"}`}>{value}</div>
    </div>
  );
}
