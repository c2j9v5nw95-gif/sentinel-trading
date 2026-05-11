import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MetricCard } from "./MetricCard";
import { fmtAge } from "./format";

interface Row {
  ok: boolean;
  checked_at: string;
  latency_ms: number | null;
  public_ip: string | null;
  bybit_reachable: boolean | null;
  error: string | null;
}

export function BridgeHealthCard() {
  const { data } = useQuery({
    queryKey: ["overview", "bridge_health_latest"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bridge_health_checks")
        .select("ok,checked_at,latency_ms,public_ip,bybit_reachable,error")
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
    refetchInterval: 5_000,
  });

  const ageSec = data ? Math.round((Date.now() - new Date(data.checked_at).getTime()) / 1000) : null;
  const stale = ageSec != null && ageSec > 120;
  const tone: "success" | "danger" | "warning" =
    !data ? "warning" : !data.ok ? "danger" : stale ? "warning" : "success";
  const label = !data ? "UNKNOWN" : !data.ok ? "DOWN" : stale ? "STALE" : "HEALTHY";

  return (
    <MetricCard
      label="Execution bridge"
      tone={tone}
      value={
        <span className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : "bg-warning"
            }`}
          />
          {label}
        </span>
      }
      sub={
        data ? (
          <span>
            {data.latency_ms != null && <span>{data.latency_ms}ms · </span>}
            {data.public_ip && <span className="font-mono">{data.public_ip}</span>}
            <span className="ml-1 text-muted-foreground">· {fmtAge(data.checked_at)}</span>
            {data.error && <div className="mt-1 text-danger">{data.error}</div>}
          </span>
        ) : (
          <span className="text-muted-foreground">No checks recorded</span>
        )
      }
    />
  );
}
