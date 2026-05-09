import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { Card } from "@/components/PageHeader";

type Mode = "testnet" | "live";

interface TransportDiagnostics {
  base_url?: string;
  endpoint?: string;
  http_status?: number;
  content_type?: string;
  cf_ray?: string;
  server?: string;
  request_id?: string;
  body_snippet?: string;
}

interface CheckResult {
  ok: boolean;
  detail?: unknown;
  error?: { code: string; message: string; detail?: TransportDiagnostics };
  ms?: number;
}

interface DiagnosticResponse {
  ok: boolean;
  mode: Mode;
  symbol?: string;
  checks: Record<string, CheckResult>;
  permissions?: unknown;
  account_type?: string | null;
  last_response?: unknown;
  base_url?: string;
  is_alternate_base?: boolean;
  base_source?: "env" | "default";
  default_base?: string;
  error?: { code: string; message: string } | null;
}

const SAFE_ORDER_PHRASE = "RUN SAFE ORDER TEST";

const CHECK_LABELS: Record<string, string> = {
  _meta: "Active endpoint",
  credentials_present: "API keys present",
  live_gate: "Live mode allowed",
  api_auth: "API authentication",
  account_info: "Account info",
  wallet_balance: "Wallet / balance read",
  read_positions: "Open positions read (by settleCoin)",
  read_positions_by_symbol: "Open positions read (by symbol — executor path)",
  read_orders: "Open orders read",
  instrument_info: "Symbol instrument info",
  leverage_limits: "Leverage limits",
  permissions: "API key permissions",
  order_endpoint_reachability: "Order endpoint reachable (executor path)",
  safe_order_test: "Safe order test (place + cancel)",
};

export function BybitDiagnosticsPanel() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("testnet");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [safeOrder, setSafeOrder] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState("");

  const { data: history } = useQuery({
    queryKey: ["bybit_diagnostics", mode],
    queryFn: async () => {
      const { data } = await supabase
        .from("bybit_diagnostics")
        .select("*")
        .eq("mode", mode)
        .order("created_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
    refetchInterval: 10_000,
  });

  const latest = history?.[0];
  const latestChecks = (latest?.checks ?? {}) as unknown as Record<string, CheckResult>;

  const run = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { mode, symbol };
      if (safeOrder) body.safe_order = { enabled: true, confirm: confirmPhrase };
      const { data, error } = await supabase.functions.invoke("op-test-bybit-connection", {
        body, method: "POST",
      });
      if (error) throw error;
      return data as DiagnosticResponse;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bybit_diagnostics"] }),
  });

  const result = (run.data as DiagnosticResponse | undefined) ?? null;
  const view = result ?? (latest ? {
    ok: latest.ok,
    mode: latest.mode as Mode,
    checks: latestChecks,
    account_type: latest.account_type,
    last_response: latest.last_response,
    error: latest.error_code
      ? { code: latest.error_code, message: latest.error_message ?? "" }
      : null,
  } as DiagnosticResponse : null);

  // Derive active base URL — prefer top-level (fresh run); fall back to _meta in checks.
  const metaDetail = (view?.checks?._meta?.detail ?? null) as
    | { base_url?: string; is_alternate?: boolean; base_source?: string; default_base?: string }
    | null;
  const activeBaseUrl = view?.base_url ?? metaDetail?.base_url ?? null;
  const isAlternateBase = view?.is_alternate_base ?? metaDetail?.is_alternate ?? false;
  const defaultBase = view?.default_base ?? metaDetail?.default_base ?? "https://api.bybit.com";

  // Find latest passing live diagnostic whose recorded base_url matches the
  // currently-active base URL — this is exactly what the live execution gate
  // checks. If present and within 60m, live execution is unblocked.
  const FRESHNESS_MS = 60 * 60 * 1000;
  const validatingRecord = mode === "live" && activeBaseUrl
    ? (history ?? []).find((h) => {
        if (!h.ok) return false;
        const ageMs = Date.now() - new Date(h.created_at as string).getTime();
        if (ageMs > FRESHNESS_MS) return false;
        const meta = (h.checks as Record<string, { detail?: { base_url?: string }; base_url?: string }> | null)?._meta;
        const recorded = meta?.detail?.base_url ?? meta?.base_url;
        return recorded === activeBaseUrl;
      })
    : null;
  const validatedAgeMs = validatingRecord
    ? Date.now() - new Date(validatingRecord.created_at as string).getTime()
    : null;

  const safeOrderReady = !safeOrder || confirmPhrase === SAFE_ORDER_PHRASE;

  return (
    <Card title="Bybit diagnostics">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground">Mode</label>
          <div className="flex gap-1">
            {(["testnet", "live"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  mode === m
                    ? m === "live"
                      ? "border-danger bg-danger/15 text-danger"
                      : "border-primary bg-primary/10"
                    : "border-border bg-background hover:bg-accent"
                }`}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
          <label className="ml-3 text-xs text-muted-foreground">Symbol</label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="w-32 rounded border border-border bg-background px-2 py-1 text-xs font-mono"
          />
          <button
            onClick={() => run.mutate()}
            disabled={run.isPending || (safeOrder && !safeOrderReady)}
            className="ml-auto rounded-md border border-primary bg-primary/10 px-3 py-1 text-xs font-semibold hover:bg-primary/20 disabled:opacity-40"
          >
            {run.isPending ? "Running…" : "Run diagnostic"}
          </button>
        </div>

        <div className="rounded-md border border-border/60 bg-muted/40 p-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={safeOrder}
              onChange={(e) => setSafeOrder(e.target.checked)}
            />
            <span>Include <strong>safe order test</strong> (places minimum-qty far-from-market limit and cancels it)</span>
          </label>
          {safeOrder && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted-foreground">
                Type <code className="text-danger">{SAFE_ORDER_PHRASE}</code> to confirm.
              </p>
              <input
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder={SAFE_ORDER_PHRASE}
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono"
              />
            </div>
          )}
        </div>

        {view ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-xs tabular">
              <span className={`rounded-md border px-2 py-0.5 font-bold ${
                view.ok ? "border-success/40 bg-success/15 text-success"
                        : "border-danger/40 bg-danger/15 text-danger"
              }`}>{view.ok ? "PASS" : "FAIL"}</span>
              <span className="text-muted-foreground">mode: {view.mode}</span>
              {view.account_type && <span className="text-muted-foreground">account: {view.account_type}</span>}
              {latest?.created_at && (
                <span className="text-muted-foreground">
                  last check: {new Date(latest.created_at).toLocaleString()}
                </span>
              )}
            </div>

            {activeBaseUrl && (
              <div className={`rounded-md border p-2 text-xs ${
                isAlternateBase
                  ? "border-warning/40 bg-warning/10"
                  : "border-border/60 bg-muted/40"
              }`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Active base URL:</span>
                  <code className="font-mono">{activeBaseUrl}</code>
                  {isAlternateBase ? (
                    <span className="rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 font-semibold text-warning">
                      ALTERNATE
                    </span>
                  ) : (
                    <span className="rounded border border-success/40 bg-success/15 px-1.5 py-0.5 font-semibold text-success">
                      OFFICIAL
                    </span>
                  )}
                </div>
                {isAlternateBase && view?.mode === "live" && (
                  <p className="mt-1 text-muted-foreground">
                    Operator override via <code>BYBIT_API_BASE_URL</code> (default is <code>{defaultBase}</code>).
                    Live execution against this endpoint is BLOCKED until a fresh diagnostic passes here.
                    Re-run the diagnostic above after any change to confirm the new endpoint signs correctly.
                  </p>
                )}
                {mode === "live" && validatingRecord && validatedAgeMs != null && (
                  <p className="mt-1 text-success">
                    ✓ Active base URL validated for live execution
                    <span className="ml-1 text-muted-foreground">
                      (record {String(validatingRecord.id).slice(0, 8)} · passed {Math.round(validatedAgeMs / 60000)}m ago · valid for 60m)
                    </span>
                  </p>
                )}
                {mode === "live" && isAlternateBase && !validatingRecord && (
                  <p className="mt-1 text-danger">
                    ✗ No passing diagnostic for this base URL within the last 60m — live execution will be rejected with{" "}
                    <code>live_gate:alternate_base_requires_passing_diagnostic</code>.
                  </p>
                )}
              </div>
            )}

            {view.error && (
              <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs space-y-1">
                <div className="font-mono text-danger">{view.error.code}</div>
                <div className="text-muted-foreground">{view.error.message}</div>
                {view.error.code?.startsWith("bybit_transport_") && (
                  <TransportBlockExplainer detail={(view.error as { detail?: TransportDiagnostics }).detail} />
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {Object.entries(view.checks).map(([k, v]) => (
                <CheckRow key={k} k={k} v={v} />
              ))}
            </div>

            {view.last_response ? (
              <details className="rounded-md border border-border bg-background/60">
                <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground">
                  Last raw API response
                </summary>
                <pre className="max-h-64 overflow-auto p-2 text-[11px] leading-tight">
                  {JSON.stringify(view.last_response, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No diagnostic has been run yet for {mode}.
          </p>
        )}

        {history && history.length > 1 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              History ({history.length})
            </summary>
            <ul className="mt-1 space-y-0.5 text-xs">
              {history.map((h) => (
                <li key={h.id} className="flex justify-between gap-3 tabular">
                  <span className={h.ok ? "text-success" : "text-danger"}>
                    {h.ok ? "✓" : "✗"} {new Date(h.created_at).toLocaleString()}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {h.error_code ?? "ok"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

function CheckRow({ k, v }: { k: string; v: CheckResult }) {
  const label = CHECK_LABELS[k] ?? k;
  const isTransport = v.error?.code?.startsWith("bybit_transport_");
  return (
    <div className={`flex items-start gap-2 rounded border px-2 py-1 ${
      v.ok ? "border-success/30 bg-success/5" : "border-danger/30 bg-danger/5"
    }`}>
      <span className={v.ok ? "text-success" : "text-danger"}>{v.ok ? "✓" : "✗"}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}{v.ms != null && <span className="ml-1 text-[10px] text-muted-foreground">{v.ms}ms</span>}</div>
        {v.error && (
          <div className="text-[11px]">
            <span className="font-mono text-danger">{v.error.code}</span>
            <span className="text-muted-foreground"> — {v.error.message}</span>
          </div>
        )}
        {isTransport && v.error?.detail && (
          <TransportBlockExplainer detail={v.error.detail} />
        )}
      </div>
    </div>
  );
}

function TransportBlockExplainer({ detail }: { detail?: TransportDiagnostics }) {
  if (!detail) return null;
  return (
    <div className="mt-2 rounded border border-danger/30 bg-background/60 p-2 text-[11px] space-y-1">
      <p className="text-muted-foreground">
        <strong className="text-danger">Cloudflare/WAF blocked the request before it reached Bybit.</strong>
        {" "}This is <em>not</em> an API-key issue. Likely cause: the Lovable Cloud egress IP or region is on Bybit/Cloudflare's blocklist, or a WAF rule was triggered.
      </p>
      <p className="text-muted-foreground">
        Workaround: set <code>BYBIT_API_BASE_URL</code> to <code>https://api.bytick.com</code> (Bybit's official mirror) or route through a proxy. Then re-run this check.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 font-mono">
        {detail.base_url && (<><dt className="text-muted-foreground">base_url</dt><dd className="break-all">{detail.base_url}</dd></>)}
        {detail.endpoint && (<><dt className="text-muted-foreground">endpoint</dt><dd className="break-all">{detail.endpoint}</dd></>)}
        {detail.http_status != null && (<><dt className="text-muted-foreground">status</dt><dd>{detail.http_status}</dd></>)}
        {detail.cf_ray && (<><dt className="text-muted-foreground">cf-ray</dt><dd className="break-all">{detail.cf_ray}</dd></>)}
        {detail.server && (<><dt className="text-muted-foreground">server</dt><dd>{detail.server}</dd></>)}
        {detail.content_type && (<><dt className="text-muted-foreground">content-type</dt><dd>{detail.content_type}</dd></>)}
        {detail.request_id && (<><dt className="text-muted-foreground">request_id</dt><dd className="break-all">{detail.request_id}</dd></>)}
      </dl>
      {detail.body_snippet && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Body snippet</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1">{detail.body_snippet}</pre>
        </details>
      )}
    </div>
  );
}
