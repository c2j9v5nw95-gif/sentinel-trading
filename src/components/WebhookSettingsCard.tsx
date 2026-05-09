import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/PageHeader";

const PROJECT_REF = "djqhpgbsgelzhrfyxfhl";
const WEBHOOK_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/ingest-webhook`;

const TOKEN_ALERTS: { label: string; body: string }[] = [
  { label: "Long entry (EL1)",
    body: "type=trade;action=ENTER-LONG;ticker={{ticker}};strategy=EL1;tag=STRAT2;barTime={{barTime}}" },
  { label: "Short entry (ES1)",
    body: "type=trade;action=ENTER-SHORT;ticker={{ticker}};strategy=ES1;tag=STRAT2;barTime={{barTime}}" },
  { label: "Long TP1 (XL1)",
    body: "type=trade;action=EXIT-LONG;ticker={{ticker}};strategy=XL1;tag=STRAT2;barTime={{barTime}}" },
  { label: "Long TP2 / REST (XL4)",
    body: "type=trade;action=EXIT-LONG;ticker={{ticker}};strategy=XL4;portion=REST;tag=STRAT2;barTime={{barTime}}" },
  { label: "Long SL/failsafe (XL2)",
    body: "type=trade;action=EXIT-LONG;ticker={{ticker}};strategy=XL2;tag=STRAT2;barTime={{barTime}}" },
  { label: "Short TP1 (XS1)",
    body: "type=trade;action=EXIT-SHORT;ticker={{ticker}};strategy=XS1;tag=STRAT2;barTime={{barTime}}" },
  { label: "Short TP2 / REST (XS4)",
    body: "type=trade;action=EXIT-SHORT;ticker={{ticker}};strategy=XS4;portion=REST;tag=STRAT2;barTime={{barTime}}" },
  { label: "Health heartbeat",
    body: "type=stats;action=HEALTH;ticker={{ticker}};strategy=HEALTH_ALL;trigger=HEARTBEAT;netProfit={{strategy.netprofit}};equity={{strategy.equity}};profitFactor={{strategy.profitfactor}};winrate={{strategy.winrate}};closedTrades={{strategy.closedtrades}};openTrades={{strategy.opentrades}};maxDD={{strategy.max_drawdown}};maxDDpct={{strategy.max_drawdown_percent}};positionSize={{strategy.position_size}};barTime={{barTime}}" },
];

const LEGACY_PAYLOAD_EXAMPLE =
  "secret=YOUR_SECRET;type=trade;action=ENTER-LONG;ticker={{ticker}};strategy=EL1;tag=STRAT2;barTime={{barTime}}";

interface RawAlert {
  id: string;
  created_at: string;
  remote_ip: string | null;
  auth_status: string;
  auth_method: string | null;
  body_text: string | null;
  signal_id: string | null;
}

interface SignalRow {
  id: string;
  status: string;
  symbol: string | null;
  action: string | null;
  strategy_code: string | null;
  decision_reason: string | null;
  dedupe_key: string;
  decision_trail: unknown;
  created_at: string;
}

export function WebhookSettingsCard() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["app_settings_webhook"],
    queryFn: async () => {
      const { data } = await supabase
        .from("app_settings")
        .select("webhook_secret_version, webhook_secret_hint, webhook_secret_rotated_at")
        .maybeSingle();
      return data;
    },
    refetchInterval: 30_000,
  });

  const { data: recent } = useQuery({
    queryKey: ["recent_raw_alerts"],
    queryFn: async () => {
      const { data } = await supabase
        .from("raw_alerts")
        .select("id, created_at, remote_ip, auth_status, auth_method, body_text, signal_id")
        .eq("transport", "webhook")
        .order("created_at", { ascending: false })
        .limit(10);
      return (data ?? []) as RawAlert[];
    },
    refetchInterval: 5_000,
  });

  const signalIds = (recent ?? []).map((r) => r.signal_id).filter(Boolean) as string[];
  const { data: signals } = useQuery({
    queryKey: ["recent_webhook_signals", signalIds.join(",")],
    queryFn: async () => {
      if (signalIds.length === 0) return [] as SignalRow[];
      const { data } = await supabase
        .from("signals")
        .select("id, status, symbol, action, strategy_code, decision_reason, dedupe_key, decision_trail, created_at")
        .in("id", signalIds);
      return (data ?? []) as SignalRow[];
    },
    enabled: signalIds.length > 0,
    refetchInterval: 5_000,
  });

  const sigById = new Map((signals ?? []).map((s) => [s.id, s] as const));

  const rotate = useMutation({
    mutationFn: async () => {
      setRotating(true);
      const { data, error } = await supabase.functions.invoke("op-rotate-webhook-secret", {
        body: {}, method: "POST",
      });
      if (error) throw error;
      return data as { secret: string; version: number; hint: string };
    },
    onSuccess: (data) => {
      setNewSecret(data.secret);
      qc.invalidateQueries({ queryKey: ["app_settings_webhook"] });
    },
    onSettled: () => setRotating(false),
  });

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  };

  const tokenForUrl = newSecret ?? `••••${settings?.webhook_secret_hint ?? "????"}`;
  const recommendedUrl = `${WEBHOOK_URL}?token=${tokenForUrl}`;
  const tokenIsReal = !!newSecret;

  return (
    <Card title="TradingView webhook">
      <div className="space-y-4 text-sm">
        <div className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              Recommended TradingView URL (URL-token auth — no <code>secret=</code> in alert body)
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded border border-border bg-muted px-2 py-1 text-xs">
                {recommendedUrl}
              </code>
              <button
                onClick={() => copy(recommendedUrl, "rec")}
                disabled={!tokenIsReal}
                title={tokenIsReal ? "" : "Rotate secret to reveal a copyable URL"}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
              >
                {copied === "rec" ? "Copied" : "Copy"}
              </button>
            </div>
            {!tokenIsReal && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Token is masked — secrets are never stored as plaintext. Click <b>Rotate secret</b> below to generate and reveal a new token once.
              </div>
            )}
          </div>

          <div>
            <div className="text-xs text-muted-foreground mb-1">Webhook URL (no token — for payload-secret mode or manual testing)</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded border border-border bg-muted px-2 py-1 text-xs">
                {WEBHOOK_URL}
              </code>
              <button
                onClick={() => copy(WEBHOOK_URL, "url")}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
              >
                {copied === "url" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">Secret status</div>
              <div className="text-xs text-muted-foreground tabular">
                v{settings?.webhook_secret_version ?? "—"} · hint{" "}
                <code>…{settings?.webhook_secret_hint ?? "????"}</code> · rotated{" "}
                {settings?.webhook_secret_rotated_at
                  ? new Date(settings.webhook_secret_rotated_at).toLocaleString()
                  : "never"}
              </div>
            </div>
            <button
              onClick={() => rotate.mutate()}
              disabled={rotating}
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50"
            >
              {rotating ? "Rotating…" : "Rotate secret"}
            </button>
          </div>
          {newSecret && (
            <div className="mt-3 rounded border border-warning/40 bg-warning/10 p-2 text-xs">
              <div className="font-medium text-warning">New secret — shown ONCE</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background px-2 py-1">{newSecret}</code>
                <button
                  onClick={() => copy(newSecret, "secret")}
                  className="rounded-md border border-border bg-background px-2 py-1 hover:bg-accent"
                >
                  {copied === "secret" ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-muted-foreground">
                Paste this into the <code>TRADINGVIEW_WEBHOOK_SECRET</code> backend secret. Then
                use the recommended URL above (with <code>?token=…</code>) in TradingView — your
                Pine Script alert messages do not need to contain <code>secret=</code>.
              </p>
            </div>
          )}
        </div>

        <div>
          <div className="font-medium mb-2">Pine Script alert templates (URL-token mode)</div>
          <p className="text-xs text-muted-foreground mb-2">
            Use these as-is in TradingView's alert "Message" field. Authentication happens via the
            <code className="mx-1">?token=…</code> in the webhook URL — no <code>secret=</code> needed in the body.
            Format is semicolon-separated <code>key=value</code> — do NOT use JSON.
          </p>
          <div className="space-y-2">
            {TOKEN_ALERTS.map((ex) => (
              <div key={ex.label} className="rounded border border-border bg-muted/40 p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-medium">{ex.label}</span>
                  <button
                    onClick={() => copy(ex.body, ex.label)}
                    className="rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent"
                  >
                    {copied === ex.label ? "Copied" : "Copy"}
                  </button>
                </div>
                <code className="block break-all text-xs leading-snug">{ex.body}</code>
              </div>
            ))}
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Payload-secret mode (legacy — use only if you cannot set the URL)
            </summary>
            <div className="mt-2 rounded border border-border bg-muted/40 p-2">
              <p className="text-[11px] text-muted-foreground mb-1">
                Use the no-token URL above and prepend <code>secret=YOUR_SECRET;</code> to every alert body.
              </p>
              <code className="block break-all text-xs leading-snug">{LEGACY_PAYLOAD_EXAMPLE}</code>
            </div>
          </details>
        </div>

        <div>
          <div className="font-medium mb-2">Recent webhook events</div>
          {(recent ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No webhook events yet.</p>
          ) : (
            <div className="space-y-2">
              {recent!.map((r) => {
                const sig = r.signal_id ? sigById.get(r.signal_id) : undefined;
                const trail = Array.isArray(sig?.decision_trail) ? sig!.decision_trail : [];
                const lastStep = trail.length > 0 ? trail[trail.length - 1] as { step?: string; outcome?: string } : null;
                const authBadge =
                  r.auth_status === "ok" ? "border-success/40 bg-success/10 text-success"
                  : r.auth_status === "bad_secret" ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-warning/40 bg-warning/10 text-warning";
                const methodBadge =
                  r.auth_method === "url_token" ? "border-primary/40 bg-primary/10 text-primary"
                  : r.auth_method === "payload_secret" ? "border-border bg-muted text-muted-foreground"
                  : "border-border bg-muted text-muted-foreground";
                return (
                  <div key={r.id} className="rounded border border-border bg-card p-2 text-xs tabular">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">
                        {new Date(r.created_at).toLocaleTimeString()}
                      </span>
                      <span className={`rounded border px-1.5 py-0.5 ${authBadge}`}>
                        {r.auth_status}
                      </span>
                      {r.auth_method && r.auth_method !== "none" && (
                        <span className={`rounded border px-1.5 py-0.5 ${methodBadge}`}>
                          {r.auth_method}
                        </span>
                      )}
                      {sig && (
                        <>
                          <span className="rounded border border-border bg-muted px-1.5 py-0.5">
                            {sig.symbol ?? "?"} · {sig.action ?? "?"} · {sig.strategy_code ?? "?"}
                          </span>
                          <span className="rounded border border-border bg-muted px-1.5 py-0.5">
                            {sig.status}
                          </span>
                        </>
                      )}
                      {r.remote_ip && (
                        <span className="text-muted-foreground">from {r.remote_ip}</span>
                      )}
                    </div>
                    {sig && (
                      <div className="mt-1 grid grid-cols-1 gap-0.5 text-[11px] text-muted-foreground">
                        <div>dedupe: <code>{sig.dedupe_key}</code></div>
                        {sig.decision_reason && <div>decision: {sig.decision_reason}</div>}
                        {lastStep && (
                          <div>last step: {lastStep.step} → {lastStep.outcome}</div>
                        )}
                      </div>
                    )}
                    {!sig && r.body_text && (
                      <code className="mt-1 block max-h-16 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                        {r.body_text.slice(0, 240)}
                      </code>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
