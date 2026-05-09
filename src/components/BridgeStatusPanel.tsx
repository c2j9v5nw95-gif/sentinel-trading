import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const FLIP_CONFIRM_PHRASE_ON = "ENABLE BRIDGE";
const FLIP_CONFIRM_PHRASE_OFF = "DISABLE BRIDGE";

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

interface SmokeRow {
  id: string;
  checked_at: string;
  ok: boolean;
  total_ms: number | null;
  bybit_ms: number | null;
  http_status: number | null;
  ret_code: number | null;
  ret_msg: string | null;
  account_equity: number | null;
  account_available: number | null;
  error: string | null;
  raw: any;
}

export function BridgeStatusPanel() {
  const qc = useQueryClient();
  const [flipPhrase, setFlipPhrase] = useState("");

  const { data: settings } = useQuery({
    queryKey: ["app_settings", "bridge_flag"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings")
        .select("id, use_execution_bridge, live_enabled").maybeSingle();
      return data;
    },
    refetchInterval: 10_000,
  });

  const flipBridge = useMutation({
    mutationFn: async (next: boolean) => {
      if (!settings?.id) throw new Error("settings_missing");
      const { error } = await supabase.from("app_settings")
        .update({ use_execution_bridge: next })
        .eq("id", settings.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setFlipPhrase("");
      qc.invalidateQueries({ queryKey: ["app_settings"] });
      qc.invalidateQueries({ queryKey: ["app_settings", "bridge_flag"] });
    },
  });
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

  const { data: smokeRows } = useQuery({
    queryKey: ["bridge_smoke_tests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bridge_smoke_tests")
        .select("*")
        .order("checked_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as SmokeRow[];
    },
    refetchInterval: 60_000,
  });

  const ping = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<PingResponse>("op-bridge-health", { method: "POST" });
      if (error) throw error;
      return data!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bridge_health_checks"] }),
  });

  const smoke = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<SmokeRow & { check_id: string }>(
        "op-bridge-smoke", { method: "POST" },
      );
      if (error) throw error;
      return data!;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bridge_smoke_tests"] }),
  });

  const last = rows?.[0];
  const lastSmoke = smokeRows?.[0];
  const healthOk = last?.ok === true;

  const fmtAge = (iso: string) => {
    const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  };

  return (
    <div className="space-y-4">
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

      {/* Smoke test box */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Smoke test (wallet-balance)</h3>
            <p className="text-xs text-muted-foreground">
              Signed Bybit V5 call routed through the bridge. Read-only — fetches account equity to
              prove the full request/response path works.
            </p>
          </div>
          <button
            onClick={() => smoke.mutate()}
            disabled={smoke.isPending || !healthOk}
            title={!healthOk ? "Run health check first" : ""}
            className="rounded border border-border bg-card px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {smoke.isPending ? "Running…" : "Run smoke test"}
          </button>
        </div>

        {smoke.error && (
          <p className="mb-2 text-xs text-danger">Smoke test failed: {(smoke.error as Error).message}</p>
        )}

        {!lastSmoke && !smoke.isPending && (
          <p className="text-xs text-muted-foreground">
            No smoke tests yet. Click <em>Run smoke test</em> after the bridge health check is green.
          </p>
        )}

        {lastSmoke && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Stat label="Status" value={lastSmoke.ok ? "Pass" : "Fail"} tone={lastSmoke.ok ? "ok" : "danger"} />
              <Stat label="Total latency" value={lastSmoke.total_ms != null ? `${lastSmoke.total_ms} ms` : "—"} />
              <Stat label="Bybit latency" value={lastSmoke.bybit_ms != null ? `${lastSmoke.bybit_ms} ms` : "—"} />
              <Stat label="HTTP" value={lastSmoke.http_status?.toString() ?? "—"} tone={lastSmoke.http_status === 200 ? "ok" : lastSmoke.http_status ? "danger" : undefined} />
              <Stat label="Bybit retCode" value={lastSmoke.ret_code?.toString() ?? "—"} tone={lastSmoke.ret_code === 0 ? "ok" : lastSmoke.ret_code != null ? "danger" : undefined} />
              <Stat label="retMsg" value={lastSmoke.ret_msg ?? "—"} />
              <Stat label="Equity (USDT)" value={lastSmoke.account_equity != null ? lastSmoke.account_equity.toFixed(2) : "—"} mono />
              <Stat label="Available" value={lastSmoke.account_available != null ? lastSmoke.account_available.toFixed(2) : "—"} mono />
            </div>
            <div className="text-[11px] text-muted-foreground">
              Last run {fmtAge(lastSmoke.checked_at)}
              {lastSmoke.raw?.trace?.cf_ray && (
                <> · cf-ray <span className="font-mono">{lastSmoke.raw.trace.cf_ray}</span></>
              )}
              {lastSmoke.raw?.trace?.bapi_request_id && (
                <> · bapi <span className="font-mono">{lastSmoke.raw.trace.bapi_request_id}</span></>
              )}
            </div>
            {lastSmoke.error && (
              <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-danger">
                <div className="font-semibold">Error</div>
                <div className="mt-1 font-mono">{lastSmoke.error}</div>
                {lastSmoke.raw?.trace?.body_snippet && (
                  <div className="mt-1 font-mono opacity-80">{lastSmoke.raw.trace.body_snippet}</div>
                )}
              </div>
            )}
            {smokeRows && smokeRows.length > 1 && (
              <div className="mt-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Recent smoke tests</div>
                <div className="flex gap-1">
                  {smokeRows.slice().reverse().map((r) => (
                    <div
                      key={r.id}
                      title={`${r.ok ? "pass" : "fail"} • ${r.total_ms ?? "—"}ms • retCode ${r.ret_code ?? "—"} • ${new Date(r.checked_at).toLocaleString()}${r.error ? ` • ${r.error}` : ""}`}
                      className={`h-4 w-2 rounded-sm ${r.ok ? "bg-success" : "bg-destructive"}`}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
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
