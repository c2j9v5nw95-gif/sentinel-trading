import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatusPill, type PillTone } from "./StatusPill";

interface BridgeRow {
  ok: boolean;
  checked_at: string;
  bybit_reachable: boolean | null;
}

export function LiveStatusStrip() {
  const { data } = useQuery({
    queryKey: ["mobile", "status_strip"],
    queryFn: async () => {
      const [{ data: settings }, { data: bridge }, { count: unprotected }, { count: recovery }] =
        await Promise.all([
          supabase.from("app_settings").select("*").maybeSingle(),
          supabase
            .from("bridge_health_checks")
            .select("ok,checked_at,bybit_reachable")
            .order("checked_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("positions")
            .select("id", { count: "exact", head: true })
            .eq("protection_state", "unprotected")
            .is("closed_at", null),
          supabase
            .from("positions")
            .select("id", { count: "exact", head: true })
            .in("exit_recovery_state", ["pending", "manual_required"])
            .is("closed_at", null),
        ]);
      return {
        settings,
        bridge: bridge as BridgeRow | null,
        unprotected: unprotected ?? 0,
        recovery: recovery ?? 0,
      };
    },
    refetchInterval: 5_000,
  });

  const settings = data?.settings;
  const bridge = data?.bridge;
  const unprotected = data?.unprotected ?? 0;
  const recovery = data?.recovery ?? 0;

  const ageSec = bridge ? Math.round((Date.now() - new Date(bridge.checked_at).getTime()) / 1000) : null;
  const stale = ageSec != null && ageSec > 120;
  const bridgeTone: PillTone = !bridge ? "muted" : !bridge.ok ? "danger" : stale ? "warning" : "success";
  const bridgeLabel = !bridge ? "Bridge unknown" : !bridge.ok ? "Bridge down" : stale ? "Bridge stale" : "Bridge healthy";

  const bybitTone: PillTone = !bridge?.bybit_reachable ? "danger" : "success";
  const bybitLabel = !bridge?.bybit_reachable ? "Bybit unreachable" : "Bybit synced";

  const modeTone: PillTone = settings?.live_enabled
    ? "danger"
    : settings?.paper_mode_enabled
    ? "warning"
    : "success";
  const modeLabel = settings?.live_enabled
    ? "Live trading"
    : settings?.paper_mode_enabled
    ? "Paper mode"
    : "Testnet";

  const pills: { key: string; label: string; tone: PillTone; detail?: string }[] = [
    { key: "mode", label: modeLabel, tone: modeTone },
    { key: "bridge", label: bridgeLabel, tone: bridgeTone, detail: ageSec != null ? `${ageSec}s` : undefined },
    { key: "bybit", label: bybitLabel, tone: bybitTone },
  ];

  if (settings?.emergency_stop) {
    pills.push({ key: "stop", label: "Kill switch", tone: "danger" });
  }
  if (settings?.entries_paused) {
    pills.push({ key: "paused", label: "Entries paused", tone: "warning" });
  }
  if (recovery > 0) {
    pills.push({ key: "rec", label: `Recovery ${recovery}`, tone: "warning" });
  }
  if (unprotected > 0) {
    pills.push({ key: "unp", label: `Unprotected ${unprotected}`, tone: "danger" });
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex gap-2">
        {pills.map((p) => (
          <StatusPill key={p.key} label={p.label} tone={p.tone} detail={p.detail} />
        ))}
      </div>
    </div>
  );
}
