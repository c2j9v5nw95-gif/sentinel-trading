import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/PageHeader";
import { fmtNum } from "./format";

interface OpenPos {
  symbol: string;
  qty_open: number | null;
  last_seen_price: number | null;
  entry_price: number | null;
  side: "long" | "short";
  execution_mode: string;
}

export function ActiveExposurePanel({ equity }: { equity: number | null }) {
  const { data } = useQuery({
    queryKey: ["overview", "exposure"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("symbol,qty_open,last_seen_price,entry_price,side,execution_mode")
        .is("closed_at", null);
      if (error) throw error;
      return (data ?? []) as OpenPos[];
    },
    refetchInterval: 5_000,
  });

  const rows = data ?? [];
  const notional = (p: OpenPos) => {
    const q = Number(p.qty_open ?? 0);
    const px = Number(p.last_seen_price ?? p.entry_price ?? 0);
    return Math.abs(q * px);
  };
  const total = rows.reduce((s, p) => s + notional(p), 0);
  const bySymbol = new Map<string, number>();
  for (const p of rows) {
    bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + notional(p));
  }
  const grouped = [...bySymbol.entries()].sort((a, b) => b[1] - a[1]);
  const totalPct = equity && equity > 0 ? (total / equity) * 100 : null;

  return (
    <Card title="Active exposure">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open positions.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Total notional</div>
              <div className="text-2xl font-semibold tabular">{fmtNum(total)} USDT</div>
            </div>
            {totalPct != null && (
              <div className="text-right">
                <div className="text-xs text-muted-foreground">of equity</div>
                <div className="text-lg font-medium tabular">{totalPct.toFixed(1)}%</div>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            {grouped.slice(0, 6).map(([sym, n]) => {
              const pct = total > 0 ? (n / total) * 100 : 0;
              return (
                <div key={sym} className="space-y-0.5">
                  <div className="flex items-center justify-between text-xs tabular">
                    <span className="font-medium text-foreground">{sym}</span>
                    <span className="text-muted-foreground">
                      {fmtNum(n)} <span className="ml-1">({pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
