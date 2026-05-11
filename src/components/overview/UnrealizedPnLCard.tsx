import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MetricCard } from "./MetricCard";
import { fmtSigned, pnlTone } from "./format";

interface OpenPos {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty_open: number | null;
  entry_price: number | null;
  last_seen_price: number | null;
  execution_mode: "paper" | "live" | "testnet";
}

export function UnrealizedPnLCard() {
  const { data } = useQuery({
    queryKey: ["overview", "open_positions_pnl"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select("id,symbol,side,qty_open,entry_price,last_seen_price,execution_mode")
        .is("closed_at", null);
      if (error) throw error;
      return (data ?? []) as OpenPos[];
    },
    refetchInterval: 5_000,
  });

  const rows = data ?? [];
  const upnl = (p: OpenPos) => {
    const q = Number(p.qty_open ?? 0);
    const e = Number(p.entry_price ?? 0);
    const l = Number(p.last_seen_price ?? 0);
    if (!q || !e || !l) return 0;
    return (l - e) * q * (p.side === "short" ? -1 : 1);
  };
  const total = rows.reduce((s, p) => s + upnl(p), 0);
  const live = rows.filter((p) => p.execution_mode === "live");
  const paper = rows.filter((p) => p.execution_mode !== "live");
  const liveSum = live.reduce((s, p) => s + upnl(p), 0);
  const paperSum = paper.reduce((s, p) => s + upnl(p), 0);

  return (
    <MetricCard
      label="Unrealized PnL"
      value={
        <span className={pnlTone(total)}>
          {fmtSigned(total)} <span className="text-base text-muted-foreground">USDT</span>
        </span>
      }
      sub={
        <span>
          <span className="text-muted-foreground">{rows.length} open</span>
          {(live.length > 0 || paper.length > 0) && (
            <span className="ml-2">
              {live.length > 0 && (
                <span>
                  live{" "}
                  <span className={pnlTone(liveSum)}>{fmtSigned(liveSum)}</span>
                </span>
              )}
              {live.length > 0 && paper.length > 0 && <span className="mx-1 text-muted-foreground">·</span>}
              {paper.length > 0 && (
                <span>
                  paper{" "}
                  <span className={pnlTone(paperSum)}>{fmtSigned(paperSum)}</span>
                </span>
              )}
            </span>
          )}
        </span>
      }
    />
  );
}
