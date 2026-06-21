import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MetricCard } from "./MetricCard";
import { Sparkline } from "./Sparkline";
import { fmtNum, fmtAge } from "./format";
import { RANGE_LABEL, rangeSinceISO, type RangeKey } from "./filters";

export function EquityCard({ live, range }: { live: boolean; range: RangeKey }) {
  const source = live ? "live" : "paper";
  const { data, isLoading } = useQuery({
    queryKey: ["overview", "equity_snapshots_v2", source, range],
    refetchInterval: 30_000,
    queryFn: async () => {
      const since = rangeSinceISO(range);

      const [firstRes, lastRes, bucketRes] = await Promise.all([
        supabase
          .from("balance_snapshots")
          .select("captured_at,total_equity")
          .eq("source", source)
          .gte("captured_at", since)
          .order("captured_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("balance_snapshots")
          .select("captured_at,total_equity")
          .eq("source", source)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.rpc("equity_snapshots_bucketed", {
          _source: source,
          _since: since,
          _buckets: 200,
        }),
      ]);

      if (firstRes.error) throw firstRes.error;
      if (lastRes.error) throw lastRes.error;
      if (bucketRes.error) throw bucketRes.error;

      const points = ((bucketRes.data ?? []) as Array<{ captured_at: string; total_equity: number | string | null }>)
        .map((r) => Number(r.total_equity))
        .filter((v) => Number.isFinite(v));

      return {
        first: firstRes.data?.total_equity != null ? Number(firstRes.data.total_equity) : null,
        last: lastRes.data?.total_equity != null ? Number(lastRes.data.total_equity) : null,
        lastAt: lastRes.data?.captured_at ?? null,
        points,
      };
    },
  });

  const last = data?.last ?? null;
  const first = data?.first ?? null;
  const points = data?.points ?? [];
  const delta = last != null && first != null ? last - first : null;
  const deltaPct = delta != null && first ? (delta / first) * 100 : null;
  const lastAt = data?.lastAt ?? null;

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
