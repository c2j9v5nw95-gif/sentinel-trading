import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";
import { fmtNum, fmtSigned, pnlTone, fmtAge, fmtDuration } from "./format";
import { rangeSinceISO, RANGE_LABEL, type RangeKey } from "./filters";

interface Row {
  id: string;
  symbol: string;
  side: "long" | "short";
  entry_price: number | null;
  last_seen_price: number | null;
  realized_pnl: number;
  opened_at: string;
  closed_at: string;
  execution_mode: string;
  last_exit_signal_id: string | null;
}

export function RecentClosedTradesTable({
  range,
  symbol,
}: {
  range: RangeKey;
  symbol: string | null;
}) {
  const { data } = useQuery({
    queryKey: ["overview", "closed_trades", range, symbol],
    queryFn: async () => {
      const since = rangeSinceISO(range);
      let q = supabase
        .from("positions")
        .select(
          "id,symbol,side,entry_price,last_seen_price,realized_pnl,opened_at,closed_at,execution_mode,last_exit_signal_id",
        )
        .not("closed_at", "is", null)
        .gte("closed_at", since)
        .order("closed_at", { ascending: false })
        .limit(50);
      if (symbol) q = q.eq("symbol", symbol);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: 15_000,
  });

  const rows = data ?? [];
  const exitIds = rows.map((r) => r.last_exit_signal_id).filter((x): x is string => !!x);
  const { data: exitSignals } = useQuery({
    queryKey: ["overview", "closed_trade_exit_reasons", exitIds],
    enabled: exitIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signals")
        .select("id,exit_reason")
        .in("id", exitIds);
      if (error) throw error;
      const m = new Map<string, string | null>();
      for (const s of data ?? []) m.set(s.id as string, (s as { exit_reason: string | null }).exit_reason);
      return m;
    },
  });

  const title = `Recent closed trades · ${RANGE_LABEL[range]}${symbol ? ` · ${symbol}` : ""}`;

  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <EmptyState title="No closed trades in range" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-2 font-medium">Symbol</th>
                <th className="py-2 pr-2 font-medium">Side</th>
                <th className="py-2 pr-2 font-medium">Mode</th>
                <th className="py-2 pr-2 text-right font-medium">Entry</th>
                <th className="py-2 pr-2 text-right font-medium">Exit</th>
                <th className="py-2 pr-2 text-right font-medium">rPnL</th>
                <th className="py-2 pr-2 font-medium">Reason</th>
                <th className="py-2 pr-2 font-medium">Hold</th>
                <th className="py-2 pr-2 font-medium">Closed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const reason = r.last_exit_signal_id ? exitSignals?.get(r.last_exit_signal_id) : null;
                return (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="py-2 pr-2 font-semibold">{r.symbol}</td>
                    <td className="py-2 pr-2">
                      <span
                        className={`uppercase ${
                          r.side === "long" ? "text-success" : "text-danger"
                        }`}
                      >
                        {r.side}
                      </span>
                    </td>
                    <td className="py-2 pr-2">
                      <ModeChip mode={r.execution_mode} />
                    </td>
                    <td className="py-2 pr-2 text-right">{fmtNum(Number(r.entry_price), 4)}</td>
                    <td className="py-2 pr-2 text-right">{fmtNum(Number(r.last_seen_price), 4)}</td>
                    <td className={`py-2 pr-2 text-right ${pnlTone(Number(r.realized_pnl))}`}>
                      {fmtSigned(Number(r.realized_pnl))}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">
                      {reason ? (
                        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                          {reason}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">
                      {fmtDuration(r.opened_at, r.closed_at)}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">{fmtAge(r.closed_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
