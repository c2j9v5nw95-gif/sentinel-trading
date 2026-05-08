import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

function Pill({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "danger" | "warning" | "muted";
}) {
  const toneClass = {
    success: "bg-success/15 text-success border-success/30",
    danger: "bg-danger/15 text-danger border-danger/40",
    warning: "bg-warning/15 text-warning border-warning/40",
    muted: "bg-muted text-muted-foreground border-border",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${toneClass}`}
    >
      {label}
    </span>
  );
}

export function StatusBar() {
  const { data } = useQuery({
    queryKey: ["status-bar"],
    queryFn: async () => {
      const [{ data: settings }, { count: unprotected }, { data: lastWebhook }, { data: lastEmail }, { data: locks }] =
        await Promise.all([
          supabase.from("app_settings").select("*").maybeSingle(),
          supabase
            .from("positions")
            .select("id", { count: "exact", head: true })
            .eq("protection_state", "unprotected")
            .is("closed_at", null),
          supabase.from("raw_alerts").select("received_at").eq("transport", "webhook")
            .order("received_at", { ascending: false }).limit(1).maybeSingle(),
          supabase.from("raw_alerts").select("received_at").eq("transport", "email")
            .order("received_at", { ascending: false }).limit(1).maybeSingle(),
          supabase.from("current_execution_locks").select("symbol,is_stale"),
        ]);
      return {
        settings,
        unprotected: unprotected ?? 0,
        lastWebhook: lastWebhook?.received_at as string | undefined,
        lastEmail: lastEmail?.received_at as string | undefined,
        locks: locks ?? [],
      };
    },
    refetchInterval: 5_000,
  });

  const settings = data?.settings;
  const unprotected = data?.unprotected ?? 0;

  const fmtAge = (ts?: string) => {
    if (!ts) return "never";
    const sec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/40 px-4 py-2 text-xs tabular">
      {settings?.paper_mode_enabled ? (
        <Pill label="PAPER MODE" tone="warning" />
      ) : (
        <Pill label="LIVE TRADING" tone="success" />
      )}
      {settings?.emergency_stop ? (
        <Pill label="KILL SWITCH ACTIVE" tone="danger" />
      ) : null}
      {settings?.entries_paused && <Pill label="Entries paused" tone="warning" />}
      <Pill
        label={`Unprotected: ${unprotected}`}
        tone={unprotected > 0 ? "danger" : "muted"}
      />
      <span className="text-muted-foreground">webhook {fmtAge(data?.lastWebhook)}</span>
      <span className="text-muted-foreground">email {fmtAge(data?.lastEmail)}</span>
    </div>
  );
}
