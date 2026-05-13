import { Card, EmptyState } from "@/components/PageHeader";
import { fmtNum, fmtSigned, fmtDuration } from "@/components/overview/format";
import type { PositionLite, PositionEventLite } from "@/lib/symbol-metrics";

export function ClosedTradesTable({
  positions,
  events,
}: {
  positions: PositionLite[];
  events: PositionEventLite[];
}) {
  const closed = positions
    .filter((p) => p.closed_at)
    .sort((a, b) => new Date(b.closed_at!).getTime() - new Date(a.closed_at!).getTime())
    .slice(0, 50);

  const exitReasonByPos = new Map<string, string>();
  for (const e of events) {
    if (
      ["sl_hit", "tp1_hit", "tp2_hit", "manual_close", "tsl_hit"].includes(e.event_type) &&
      !exitReasonByPos.has(e.position_id)
    ) {
      exitReasonByPos.set(e.position_id, e.event_type);
    }
  }

  return (
    <Card title={`Closed trades (${closed.length})`}>
      {closed.length === 0 ? (
        <EmptyState title="Ingen lukkede trades" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular">
            <thead className="text-left uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Closed</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>PnL</th>
                <th>PnL %</th>
                <th>Duration</th>
                <th>Exit reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {closed.map((p) => {
                const notional =
                  p.entry_price && (p.qty_initial ?? p.qty_open)
                    ? p.entry_price * (p.qty_initial ?? p.qty_open!)
                    : 0;
                const pct = notional > 0 ? (p.realized_pnl / notional) * 100 : null;
                const tone = p.realized_pnl >= 0 ? "text-success" : "text-danger";
                return (
                  <tr key={p.id}>
                    <td className="py-2 text-muted-foreground">
                      {new Date(p.closed_at!).toLocaleString()}
                    </td>
                    <td className={p.side === "long" ? "text-success" : "text-danger"}>{p.side}</td>
                    <td>{fmtNum(p.qty_initial ?? p.qty_open ?? 0, 4)}</td>
                    <td>{fmtNum(p.entry_price ?? 0, 6)}</td>
                    <td className={tone}>{fmtSigned(p.realized_pnl, 2)}</td>
                    <td className={tone}>{pct != null ? `${fmtSigned(pct, 2)}%` : "—"}</td>
                    <td>{fmtDuration(p.opened_at, p.closed_at)}</td>
                    <td className="text-muted-foreground">
                      {exitReasonByPos.get(p.id) ?? "—"}
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
