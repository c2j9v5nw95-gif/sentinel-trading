import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MetricCard } from "./MetricCard";
import { fmtSigned, pnlTone } from "./format";
import { osloDayStartISO } from "@/lib/time/oslo-day";

export function RealizedPnLTodayCard() {
  const { data } = useQuery({
    queryKey: ["overview", "realized_pnl_today_oslo"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("realized_pnl,closed_at")
        .gte("closed_at", osloDayStartISO())
        .not("closed_at", "is", null);
      if (error) throw error;
      return (data ?? []) as { realized_pnl: number | null; closed_at: string }[];
    },
    refetchInterval: 10_000,
  });

  const rows = data ?? [];
  const sum = rows.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);

  return (
    <MetricCard
      label="Realized PnL · today (Oslo)"
      value={
        <span className={pnlTone(sum)}>
          {fmtSigned(sum)} <span className="text-base text-muted-foreground">USDT</span>
        </span>
      }
      sub={
        <span className="text-muted-foreground">
          {rows.length} trade{rows.length === 1 ? "" : "s"} closed since 00:00 Oslo
        </span>
      }
    />
  );
}
