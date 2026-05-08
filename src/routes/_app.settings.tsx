import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();

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

  const togglePaper = useMutation({
    mutationFn: async (next: boolean) => {
      if (!data?.id) return;
      await supabase.from("app_settings")
        .update({ paper_mode_enabled: next })
        .eq("id", data.id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_settings"] }),
  });

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
                    <ModeChip mode={data.paper_mode_enabled ? "paper" : "live"} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Paper-mode signals run the full pipeline (Health Gate, Risk
                    Engine, sizing, protection logic) without sending real Bybit
                    orders. Per-symbol overrides take precedence.
                  </p>
                </div>
                <button
                  onClick={() => togglePaper.mutate(!data.paper_mode_enabled)}
                  disabled={togglePaper.isPending}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
                >
                  {data.paper_mode_enabled ? "Switch to LIVE" : "Switch to PAPER"}
                </button>
              </div>
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
            </div>
          ) : null}
        </Card>

        <Card title="Webhook secret">
          {data ? (
            <dl className="grid grid-cols-2 gap-3 text-sm tabular">
              <dt className="text-muted-foreground">Version</dt>
              <dd>v{data.webhook_secret_version}</dd>
              <dt className="text-muted-foreground">Hint (last 4)</dt>
              <dd>{data.webhook_secret_hint ?? "—"}</dd>
              <dt className="text-muted-foreground">Rotated at</dt>
              <dd>
                {data.webhook_secret_rotated_at
                  ? new Date(data.webhook_secret_rotated_at).toLocaleString()
                  : "never"}
              </dd>
            </dl>
          ) : null}
          <button
            disabled
            title="Wired in Phase 3"
            className="mt-4 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
          >
            Rotate webhook secret
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            The actual secret value lives in Edge Function secrets. The database stores
            only metadata.
          </p>
        </Card>
      </div>
    </>
  );
}
