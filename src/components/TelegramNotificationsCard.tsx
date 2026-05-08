import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/PageHeader";

const ALL_CATEGORIES = [
  "live_entry",
  "live_exit",
  "tp_hit",
  "sl_hit",
  "tsl_update",
  "live_risk_halt",
  "invariant_violation",
  "unprotected_position",
  "bybit_diagnostic_failure",
  "dead_letter",
  "emergency_stop",
] as const;

type Severity = "info" | "warning" | "critical";

type Settings = {
  id: string;
  telegram_enabled: boolean;
  enabled_categories: string[];
  min_severity: Severity;
  rate_limit_seconds: number;
  dedupe_window_seconds: number;
};

const DEFAULT_SETTINGS = {
  telegram_enabled: false,
  enabled_categories: ALL_CATEGORIES as unknown as string[],
  min_severity: "warning" as Severity,
  rate_limit_seconds: 60,
  dedupe_window_seconds: 300,
};

export function TelegramNotificationsCard() {
  const qc = useQueryClient();
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const settingsQ = useQuery({
    queryKey: ["notification_settings"],
    queryFn: async (): Promise<Settings> => {
      // Diagnostics: verify session + operator role first so we surface auth/role
      // failures with a clear message instead of a generic table error.
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userRes?.user) {
        console.error("[TelegramNotificationsCard] no auth session", userErr);
        throw new Error("Not signed in. Please sign in as an operator.");
      }
      const { data: roleRow, error: roleErr } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userRes.user.id)
        .eq("role", "operator")
        .maybeSingle();
      if (roleErr) {
        console.error("[TelegramNotificationsCard] role lookup failed", roleErr);
        throw new Error(`Role lookup failed: ${roleErr.message}`);
      }
      if (!roleRow) {
        console.error("[TelegramNotificationsCard] user lacks operator role", userRes.user.id);
        throw new Error("Your account does not have the operator role required to view Telegram settings.");
      }

      // Try to load
      const { data, error } = await supabase
        .from("notification_settings" as never)
        .select("*")
        .eq("singleton", true)
        .maybeSingle();
      if (error) {
        console.error("[TelegramNotificationsCard] load error", error);
        throw error;
      }
      if (data) return data as unknown as Settings;

      // Auto-create default row on first load
      console.warn("[TelegramNotificationsCard] no settings row, auto-creating default");
      const { data: created, error: insErr } = await (supabase
        .from("notification_settings" as never) as never as {
          insert: (p: Record<string, unknown>) => {
            select: () => { single: () => Promise<{ data: unknown; error: unknown }> };
          };
        })
        .insert({ singleton: true, ...DEFAULT_SETTINGS })
        .select()
        .single();
      if (insErr) {
        console.error("[TelegramNotificationsCard] auto-create failed", insErr);
        throw insErr as Error;
      }
      return created as Settings;
    },
    retry: 1,
  });

  const eventsQ = useQuery({
    queryKey: ["notification_events_recent"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notification_events" as never)
        .select("id,created_at,category,severity,status,error_message")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) {
        console.error("[TelegramNotificationsCard] events error", error);
        throw error;
      }
      return (data ?? []) as Array<{
        id: string; created_at: string; category: string;
        severity: Severity; status: string; error_message: string | null;
      }>;
    },
    refetchInterval: 5000,
    enabled: !!settingsQ.data,
  });

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const settings = settingsQ.data;
      if (!settings) return;
      const { error } = await (supabase
        .from("notification_settings" as never) as never as {
          update: (p: Record<string, unknown>) => { eq: (k: string, v: string) => Promise<{ error: unknown }> };
        })
        .update(patch)
        .eq("id", settings.id);
      if (error) throw error as Error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification_settings"] }),
  });

  async function runTest() {
    setTestStatus("Sending…");
    const { data, error } = await supabase.functions.invoke("op-test-telegram-notification");
    if (error) {
      console.error("[TelegramNotificationsCard] test invoke error", error);
      setTestStatus(`Error: ${error.message}`);
    } else {
      setTestStatus(`Result: ${JSON.stringify(data)}`);
    }
    qc.invalidateQueries({ queryKey: ["notification_events_recent"] });
  }

  if (settingsQ.isLoading) {
    return (
      <Card title="Telegram Notifications">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }

  if (settingsQ.isError || !settingsQ.data) {
    const msg = (settingsQ.error as Error | undefined)?.message ?? "Unknown error";
    return (
      <Card title="Telegram Notifications">
        <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs space-y-2">
          <div className="font-medium text-danger">Failed to load notification settings</div>
          <div className="text-muted-foreground break-all">{msg}</div>
          <div className="text-muted-foreground">
            Likely causes: missing RLS operator role, missing migration, or DB unreachable.
            Check the browser console for diagnostics.
          </div>
          <button
            type="button"
            onClick={() => settingsQ.refetch()}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent"
          >
            Retry
          </button>
        </div>
      </Card>
    );
  }

  const settings = settingsQ.data;
  const cats = new Set(settings.enabled_categories ?? []);

  return (
    <Card title="Telegram Notifications">
      <p className="text-xs text-muted-foreground mb-3">
        Telegram is for <b>operator alerts only</b> — it never executes trades.
        Trade execution stays on the Bybit pipeline.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.telegram_enabled}
            onChange={(e) => update.mutate({ telegram_enabled: e.target.checked })}
          />
          Enable Telegram
        </label>
        <button
          type="button"
          onClick={runTest}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent"
        >
          Test Telegram message
        </button>
        {testStatus && <span className="text-xs text-muted-foreground">{testStatus}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Minimum severity</span>
          <select
            value={settings.min_severity}
            onChange={(e) => update.mutate({ min_severity: e.target.value })}
            className="rounded border border-border bg-background px-2 py-1"
          >
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Rate limit (seconds)</span>
          <input
            type="number" min={0}
            value={settings.rate_limit_seconds}
            onChange={(e) => update.mutate({ rate_limit_seconds: Number(e.target.value) })}
            className="rounded border border-border bg-background px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Dedupe window (seconds)</span>
          <input
            type="number" min={0}
            value={settings.dedupe_window_seconds}
            onChange={(e) => update.mutate({ dedupe_window_seconds: Number(e.target.value) })}
            className="rounded border border-border bg-background px-2 py-1"
          />
        </label>
      </div>

      <div className="mb-4">
        <div className="text-xs text-muted-foreground mb-2">Enabled categories</div>
        <div className="grid grid-cols-2 gap-1 text-xs">
          {ALL_CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={cats.has(c)}
                onChange={(e) => {
                  const next = new Set(cats);
                  if (e.target.checked) next.add(c); else next.delete(c);
                  update.mutate({ enabled_categories: Array.from(next) });
                }}
              />
              <code>{c}</code>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-2">Last 10 notification events</div>
        {eventsQ.isError && (
          <div className="text-xs text-danger mb-2">
            Failed to load events: {(eventsQ.error as Error).message}
          </div>
        )}
        <div className="rounded border border-border divide-y divide-border text-xs">
          {(eventsQ.data ?? []).length === 0 && (
            <div className="p-2 text-muted-foreground">No events yet.</div>
          )}
          {(eventsQ.data ?? []).map((ev) => (
            <div key={ev.id} className="p-2 flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{new Date(ev.created_at).toLocaleString()}</span>
              <span><b>{ev.category}</b> · {ev.severity}</span>
              <span className={
                ev.status === "sent" ? "text-green-500"
                : ev.status === "failed" ? "text-red-500"
                : "text-muted-foreground"
              }>{ev.status}{ev.error_message ? ` (${ev.error_message})` : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
