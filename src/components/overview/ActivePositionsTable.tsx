import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";
import { fmtNum, fmtSigned, pnlTone, fmtDuration } from "./format";

interface Row {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty_open: number | null;
  entry_price: number | null;
  last_seen_price: number | null;
  protection_state: string;
  tsl_active: boolean;
  opened_at: string;
  execution_mode: string;
  exit_recovery_state: string | null;
  leverage: number | null;
}

export function ActivePositionsTable() {
  const { data, isLoading } = useQuery({
    queryKey: ["overview", "active_positions_table"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id,symbol,side,qty_open,entry_price,last_seen_price,protection_state,tsl_active,opened_at,execution_mode,exit_recovery_state,leverage",
        )
        .is("closed_at", null)
        .order("opened_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: 5_000,
  });

  const rows = data ?? [];

  return (
    <Card title={`Active positions (${rows.length})`}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No open positions" hint="The desk is flat." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Symbol</th>
                <th className="py-2 pr-3 font-medium">Side</th>
                <th className="py-2 pr-3 font-medium">Mode</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Entry</th>
                <th className="py-2 pr-3 text-right font-medium">Last</th>
                <th className="py-2 pr-3 text-right font-medium">uPnL</th>
                <th className="py-2 pr-3 text-right font-medium">uPnL%</th>
                <th className="py-2 pr-3 font-medium">Protection</th>
                <th className="py-2 pr-3 font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const q = Number(r.qty_open ?? 0);
                const e = Number(r.entry_price ?? 0);
                const l = Number(r.last_seen_price ?? 0);
                const pnl = q && e && l ? (l - e) * q * (r.side === "short" ? -1 : 1) : 0;
                const lev = Number(r.leverage ?? 1) || 1;
                const pct = e ? ((l - e) / e) * 100 * (r.side === "short" ? -1 : 1) * lev : 0;
                const recovery = r.exit_recovery_state;
                return (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-accent/30">
                    <td className="py-2 pr-3">
                      <Link to="/positions" className="font-semibold text-foreground hover:underline">
                        {r.symbol}
                      </Link>
                      {recovery && (
                        <span
                          className={`ml-2 rounded px-1 py-0.5 text-[9px] font-bold uppercase ${
                            recovery === "manual_required"
                              ? "bg-danger/20 text-danger"
                              : "bg-warning/20 text-warning"
                          }`}
                        >
                          {recovery}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`uppercase ${
                          r.side === "long" ? "text-success" : "text-danger"
                        }`}
                      >
                        {r.side}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <ModeChip mode={r.execution_mode} />
                    </td>
                    <td className="py-2 pr-3 text-right">{fmtNum(q, 4)}</td>
                    <td className="py-2 pr-3 text-right">{fmtNum(e, 4)}</td>
                    <td className="py-2 pr-3 text-right">{fmtNum(l, 4)}</td>
                    <td className={`py-2 pr-3 text-right ${pnlTone(pnl)}`}>{fmtSigned(pnl)}</td>
                    <td className={`py-2 pr-3 text-right ${pnlTone(pct)}`}>
                      {fmtSigned(pct)}%
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                          r.protection_state === "unprotected"
                            ? "border-danger/40 bg-danger/15 text-danger"
                            : "border-success/30 bg-success/15 text-success"
                        }`}
                      >
                        {r.protection_state}
                      </span>
                      {r.tsl_active && (
                        <span className="ml-1 rounded border border-info/30 bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase text-primary">
                          TSL
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {fmtDuration(r.opened_at)}
                    </td>
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
