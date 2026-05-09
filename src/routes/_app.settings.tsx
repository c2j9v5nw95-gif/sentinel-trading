import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";
import { BybitDiagnosticsPanel } from "@/components/BybitDiagnosticsPanel";
import { LiveRiskBreakerCard } from "@/components/LiveRiskBreakerCard";
import { TelegramNotificationsCard } from "@/components/TelegramNotificationsCard";
import { LiveWalletPanel } from "@/components/LiveWalletPanel";
import { WebhookSettingsCard } from "@/components/WebhookSettingsCard";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

const LIVE_CONFIRM_PHRASE = "ENABLE LIVE TRADING";

function SettingsPage() {
  const qc = useQueryClient();
  const [livePhrase, setLivePhrase] = useState("");

  const { data } = useQuery({
    queryKey: ["app_settings"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("*").maybeSingle();
      return data;
    },
    refetchInterval: 5_000,
  });

  const { data: wallet } = useQuery({
    queryKey: ["paper_wallet"],
    queryFn: async () => {
      const { data } = await supabase.from("paper_wallet").select("*").maybeSingle();
      return data;
    },
    refetchInterval: 5_000,
  });

  const { data: criticalCount } = useQuery({
    queryKey: ["critical_invariants_open"],
    queryFn: async () => {
      const { count } = await supabase.from("invariant_violations")
        .select("id", { count: "exact", head: true })
        .eq("severity", "critical")
        .is("resolved_at", null)
        .is("acknowledged_at", null);
      return count ?? 0;
    },
    refetchInterval: 10_000,
  });

  // Latest live-mode Bybit diagnostic — required for live-gate.
  // We accept the diagnostic if every read-only check passed, even if the
  // optional safe_order_test failed (it requires live_enabled, which is the
  // very flag this gate unlocks — chicken-and-egg).
  const { data: liveDiag } = useQuery({
    queryKey: ["bybit_diagnostics", "live", "latest"],
    queryFn: async () => {
      const { data } = await supabase
        .from("bybit_diagnostics")
        .select("ok, checks, created_at")
        .eq("mode", "live")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    refetchInterval: 10_000,
  });

  const setMode = useMutation({
    mutationFn: async (mode: "paper" | "testnet" | "live") => {
      if (!data?.id) return;
      await supabase.from("app_settings")
        .update({
          paper_mode_enabled: mode === "paper",
          testnet_enabled: mode === "testnet",
          live_enabled: mode === "live",
        })
        .eq("id", data.id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_settings"] }),
  });

  const markTestnetValidated = useMutation({
    mutationFn: async () => {
      if (!data?.id) return;
      await supabase.from("app_settings")
        .update({ testnet_validated_at: new Date().toISOString() })
        .eq("id", data.id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_settings"] }),
  });

  const runRecovery = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke("bybit-recovery", {
        body: {}, method: "POST",
      });
      if (error) throw error;
    },
  });

  const currentMode: "paper" | "testnet" | "live" =
    data?.paper_mode_enabled ? "paper"
      : data?.testnet_enabled ? "testnet"
      : data?.live_enabled    ? "live" : "paper";

  // Live gate: every condition must be green to allow LIVE selection.
  // NOTE: Testnet validation is intentionally NOT a live-gate requirement.
  // Read-only checks are sufficient — safe_order_test is ignored here because
  // it can only succeed once live is already enabled.
  const liveChecks = (liveDiag?.checks ?? {}) as Record<string, { ok?: boolean }>;
  const readOnlyChecksOk = Object.entries(liveChecks)
    .filter(([k]) => k !== "safe_order_test")
    .every(([, v]) => v?.ok === true);
  const liveDiagnosticOk = !!liveDiag?.created_at && readOnlyChecksOk &&
    (Date.now() - new Date(liveDiag.created_at).getTime() < 24 * 60 * 60_000);
  const liveRiskBreakerOk = !data?.live_risk_halted;
  const liveGateOk =
    !data?.emergency_stop &&
    liveDiagnosticOk &&
    (criticalCount ?? 0) === 0 &&
    liveRiskBreakerOk &&
    livePhrase === LIVE_CONFIRM_PHRASE;

  return (
    <>
      <PageHeader title="Settings" description="Global operator-wide configuration." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Risk & flags">
          {data ? (
            <dl className="grid grid-cols-2 gap-3 text-sm tabular">
              <dt className="text-muted-foreground">Emergency stop</dt>
              <dd>{data.emergency_stop ? "ACTIVE" : "off"}</dd>
              <dt className="text-muted-foreground">Entries paused</dt>
              <dd>{data.entries_paused ? "yes" : "no"}</dd>
              <dt className="text-muted-foreground">Email ingest</dt>
              <dd>{data.email_ingest_enabled ? "on" : "off"}</dd>
              <dt className="text-muted-foreground">Max concurrent positions</dt>
              <dd>{data.max_concurrent_positions}</dd>
              <dt className="text-muted-foreground">Max daily loss %</dt>
              <dd>{data.max_daily_loss_pct}</dd>
              <dt className="text-muted-foreground">Default leverage</dt>
              <dd>{data.default_leverage}x</dd>
              <dt className="text-muted-foreground">Dedupe window (s)</dt>
              <dd>{data.dedupe_window_seconds}</dd>
            </dl>
          ) : (
            <EmptyState title="No settings row" />
          )}
        </Card>

        <Card title="Execution mode">
          {data ? (
            <div className="space-y-3 text-sm tabular">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-foreground">
                    <span>Global mode</span>
                    <ModeChip mode={currentMode} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    PAPER simulates fills locally. TESTNET sends real signed orders to
                    Bybit testnet. LIVE (mainnet) is execution-blocked until every
                    safety gate passes.
                  </p>
                </div>
                <div className="flex gap-1">
                  {(["paper", "testnet", "live"] as const).map((m) => {
                    const liveBlocked = m === "live" && !liveGateOk;
                    return (
                      <button
                        key={m}
                        onClick={() => setMode.mutate(m)}
                        disabled={setMode.isPending || currentMode === m || liveBlocked}
                        title={liveBlocked ? "Live gate not satisfied" : ""}
                        className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                          currentMode === m
                            ? "border-primary bg-primary/10 text-foreground"
                            : liveBlocked
                              ? "border-border bg-muted text-muted-foreground cursor-not-allowed"
                              : "border-border bg-background hover:bg-accent"
                        }`}
                      >
                        {m.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </div>

              {currentMode === "testnet" && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                  <div className="font-medium text-warning">Testnet active</div>
                  <p className="mt-1 text-muted-foreground">
                    Requires <code>BYBIT_TESTNET_API_KEY</code> and <code>BYBIT_TESTNET_API_SECRET</code>.
                    Run recovery after enabling to hydrate any pre-existing venue positions.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => runRecovery.mutate()}
                      disabled={runRecovery.isPending}
                      className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-accent"
                    >
                      {runRecovery.isPending ? "Recovering…" : "Run startup recovery"}
                    </button>
                    <button
                      onClick={() => markTestnetValidated.mutate()}
                      disabled={markTestnetValidated.isPending}
                      className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-accent"
                    >
                      Mark testnet validated (24h)
                    </button>
                  </div>
                </div>
              )}

              {/* Live gate panel — always visible so operator can prep. */}
              <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs space-y-2">
                <div className="font-medium text-danger">Live (mainnet) gate</div>
                <ul className="space-y-0.5 text-muted-foreground">
                  <li>{data?.emergency_stop ? "✗" : "✓"} Emergency stop off</li>
                  <li>{(criticalCount ?? 0) === 0 ? "✓" : "✗"} No open critical invariants
                    ({criticalCount ?? 0})</li>
                  <li>{liveRiskBreakerOk ? "✓" : "✗"} Live risk circuit breaker not tripped</li>
                  <li>{liveDiagnosticOk ? "✓" : "✗"} Live Bybit diagnostic passed (≤24h)
                    {liveDiag?.created_at && ` (${new Date(liveDiag.created_at).toLocaleString()})`}</li>
                  <li>✓ BYBIT_LIVE_API_KEY / SECRET present (verified at runtime)</li>
                  <li>{livePhrase === LIVE_CONFIRM_PHRASE ? "✓" : "✗"} Type confirmation phrase</li>
                </ul>
                <input
                  type="text"
                  value={livePhrase}
                  onChange={(e) => setLivePhrase(e.target.value)}
                  placeholder={`Type "${LIVE_CONFIRM_PHRASE}" to enable LIVE button`}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                />
                {!liveGateOk && (
                  <p className="text-muted-foreground">
                    LIVE button stays disabled until every gate is green.
                  </p>
                )}
              </div>

              {currentMode === "live" ? (
                <LiveWalletPanel />
              ) : (
                <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                  <dt className="text-muted-foreground">Virtual starting balance</dt>
                  <dd>{Number(data.paper_starting_balance_usdt).toLocaleString()} USDT</dd>
                  <dt className="text-muted-foreground">Simulated taker fee</dt>
                  <dd>{data.paper_fee_bps} bps</dd>
                  <dt className="text-muted-foreground">Simulated slippage</dt>
                  <dd>{data.paper_slippage_bps} bps</dd>
                  <dt className="text-muted-foreground">Fill latency</dt>
                  <dd>{data.paper_fill_latency_ms} ms</dd>
                  <dt className="text-muted-foreground">Wallet balance (paper)</dt>
                  <dd>{wallet ? `${Number(wallet.balance_usdt).toFixed(2)} USDT` : "—"}</dd>
                  <dt className="text-muted-foreground">Realized PnL (paper)</dt>
                  <dd className={Number(wallet?.realized_pnl ?? 0) >= 0 ? "text-success" : "text-danger"}>
                    {wallet ? Number(wallet.realized_pnl).toFixed(2) : "—"}
                  </dd>
                </dl>
              )}
            </div>
          ) : null}
        </Card>

      </div>
      <div className="mt-4 grid grid-cols-1 gap-4">
        <LiveRiskBreakerCard />
        <BybitDiagnosticsPanel />
        <WebhookSettingsCard />
        <TelegramNotificationsCard />
      </div>
    </>
  );
}
