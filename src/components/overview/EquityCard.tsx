import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MetricCard } from "./MetricCard";
import { Sparkline } from "./Sparkline";
import { fmtNum, fmtAge } from "./format";
import { RANGE_LABEL, rangeSinceISO, type RangeKey } from "./filters";

interface Snapshot {
  captured_at: string;
  total_equity: number | null;
  source: string;
}

export function EquityCard({ live, range }: { live: boolean; range: RangeKey }) {
  const source = live ? "live" : "paper";
  const { data, isLoading } = useQuery({
    queryKey: ["overview", "equity_snapshots", source, range],
    queryFn: async () => {
      const since = rangeSinceISO(range);
      const { data, error } = await supabase
        .from("balance_snapshots")
        .select("captured_at,total_equity,source")
        .eq("source", source)
        .gte("captured_at", since)
        .order("captured_at", { ascending: true })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as Snapshot[];
    },
    refetchInterval: 30_000,
  });

  const points = (data ?? [])
    .map((r) => Number(r.total_equity))
    .filter((v) => Number.isFinite(v));
  const last = points.length ? points[points.length - 1] : null;
  const first = points.length ? points[0] : null;
  const delta = last != null && first != null ? last - first : null;
  const deltaPct = delta != null && first ? (delta / first) * 100 : null;
  const lastAt = data && data.length ? data[data.length - 1].captured_at : null;

  return (
    <MetricCard
      label={`Account equity · ${source}`}
      value={isLoading ? "…" : last != null ? `${fmtNum(last)} USDT` : "—"}
      sub={
        delta != null ? (
          <span>
            <span className={delta >= 0 ? "text-success" : "text-danger"}>
              {delta >= 0 ? "+" : "−"}
              {fmtNum(Math.abs(delta))}
            </span>
            {deltaPct != null && (
              <span className={`ml-1 ${delta >= 0 ? "text-success" : "text-danger"}`}>
                ({deltaPct >= 0 ? "+" : ""}
                {deltaPct.toFixed(2)}%)
              </span>
            )}
            <span className="ml-2 text-muted-foreground">
              {RANGE_LABEL[range]} · {fmtAge(lastAt)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">No snapshots in {RANGE_LABEL[range]}</span>
        )
      }
      right={<Sparkline values={points} width={110} height={32} />}
    />
  );
}
