import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle } from "lucide-react";

interface AttentionItem {
  key: string;
  label: string;
  detail: string;
  severity: "danger" | "warning";
}

export function NeedsAttentionList() {
  const { data } = useQuery({
    queryKey: ["mobile", "attention"],
    queryFn: async () => {
      const items: AttentionItem[] = [];

      const [{ data: bridge }, { data: positions }, { data: alerts }] = await Promise.all([
        supabase
          .from("bridge_health_checks")
          .select("ok,checked_at,bybit_reachable,error")
          .order("checked_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("positions")
          .select("id,symbol,protection_state,exit_recovery_state,unprotected_since")
          .is("closed_at", null),
        supabase
          .from("system_alerts")
          .select("id,category,message,severity,created_at")
          .eq("severity", "critical")
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

      if (bridge) {
        const ageSec = Math.round((Date.now() - new Date(bridge.checked_at).getTime()) / 1000);
        if (!bridge.ok) {
          items.push({
            key: "bridge-down",
            label: "Bridge down",
            detail: bridge.error?.slice(0, 100) ?? "Health check failing",
            severity: "danger",
          });
        } else if (ageSec > 120) {
          items.push({
            key: "bridge-stale",
            label: "Bridge stale",
            detail: `last check ${ageSec}s ago`,
            severity: "warning",
          });
        }
        if (bridge.ok && !bridge.bybit_reachable) {
          items.push({
            key: "bybit",
            label: "Bybit unreachable",
            detail: "venue not responding",
            severity: "danger",
          });
        }
      }

      const unprotected = (positions ?? []).filter((p) => p.protection_state === "unprotected");
      for (const p of unprotected) {
        items.push({
          key: `unp-${p.id}`,
          label: `${p.symbol} unprotected`,
          detail: "no SL active",
          severity: "danger",
        });
      }

      const recovery = (positions ?? []).filter(
        (p) => p.exit_recovery_state === "manual_required" || p.exit_recovery_state === "pending",
      );
      for (const p of recovery) {
        items.push({
          key: `rec-${p.id}`,
          label: `${p.symbol} recovery`,
          detail: p.exit_recovery_state ?? "",
          severity: p.exit_recovery_state === "manual_required" ? "danger" : "warning",
        });
      }

      for (const a of alerts ?? []) {
        items.push({
          key: `al-${a.id}`,
          label: a.category,
          detail: a.message,
          severity: "danger",
        });
      }

      return items;
    },
    refetchInterval: 5_000,
  });

  const items = data ?? [];
  if (items.length === 0) return null;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warning">
          Needs attention
        </h2>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <div
            key={it.key}
            className={`rounded-xl border p-3 ${
              it.severity === "danger"
                ? "border-danger/40 bg-danger/10"
                : "border-warning/40 bg-warning/10"
            }`}
          >
            <div
              className={`text-sm font-semibold ${
                it.severity === "danger" ? "text-danger" : "text-warning"
              }`}
            >
              {it.label}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{it.detail}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
