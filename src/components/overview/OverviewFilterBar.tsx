import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { rangeSinceISO, RANGE_LABEL, type RangeKey } from "./filters";

const RANGES: RangeKey[] = ["1h", "24h", "7d"];

export function OverviewFilterBar({
  range,
  symbol,
  onRangeChange,
  onSymbolChange,
}: {
  range: RangeKey;
  symbol: string | null;
  onRangeChange: (r: RangeKey) => void;
  onSymbolChange: (s: string | null) => void;
}) {
  const { data: symbols } = useQuery({
    queryKey: ["overview", "traded_symbols", range],
    queryFn: async () => {
      const since = rangeSinceISO(range);
      const { data, error } = await supabase
        .from("positions")
        .select("symbol,opened_at,closed_at")
        .or(`opened_at.gte.${since},closed_at.gte.${since}`)
        .limit(1000);
      if (error) throw error;
      const set = new Set<string>();
      for (const r of data ?? []) {
        if ((r as { symbol: string | null }).symbol) set.add((r as { symbol: string }).symbol);
      }
      return Array.from(set).sort();
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`px-3 py-1.5 text-xs font-medium transition ${
              r === range
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-muted"
            }`}
          >
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>
      <select
        value={symbol ?? ""}
        onChange={(e) => onSymbolChange(e.target.value || null)}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
      >
        <option value="">All symbols ({symbols?.length ?? 0})</option>
        {(symbols ?? []).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {symbol && (
        <button
          onClick={() => onSymbolChange(null)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          Clear
        </button>
      )}
    </div>
  );
}
