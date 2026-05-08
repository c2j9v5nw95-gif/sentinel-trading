import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { data } = useQuery({
    queryKey: ["app_settings"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("*").maybeSingle();
      return data;
    },
    refetchInterval: 5_000,
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
