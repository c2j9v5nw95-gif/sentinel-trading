import { Card } from "@/components/PageHeader";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type { HealthSnapshotLite, PositionLite } from "@/lib/symbol-metrics";

type Point = {
  t: number;
  bt_winrate: number | null;
  bt_pf: number | null;
  live_winrate: number | null;
  live_pf: number | null;
};

function buildSeries(
  health: HealthSnapshotLite[],
  closed: PositionLite[],
): Point[] {
  // Combine timeline of (a) backtest snapshots and (b) running live winrate/PF after each closed trade.
  const sortedHealth = [...health].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const sortedClosed = [...closed]
    .filter((p) => p.closed_at)
    .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());

  const points: Point[] = [];

  let wins = 0;
  let total = 0;
  let gp = 0;
  let gl = 0;
  let liveIdx = 0;

  const events: { t: number; type: "bt" | "live"; bt?: HealthSnapshotLite; live?: PositionLite }[] =
    [];
  for (const h of sortedHealth) events.push({ t: new Date(h.created_at).getTime(), type: "bt", bt: h });
  for (const p of sortedClosed) events.push({ t: new Date(p.closed_at!).getTime(), type: "live", live: p });
  events.sort((a, b) => a.t - b.t);

  let lastBtWr: number | null = null;
  let lastBtPf: number | null = null;

  for (const e of events) {
    if (e.type === "bt" && e.bt) {
      lastBtWr = e.bt.winrate != null ? Number(e.bt.winrate) : lastBtWr;
      lastBtPf = e.bt.profit_factor != null ? Number(e.bt.profit_factor) : lastBtPf;
    } else if (e.type === "live" && e.live) {
      total += 1;
      if (e.live.realized_pnl > 0) wins += 1;
      gp += Math.max(0, e.live.realized_pnl);
      gl += Math.max(0, -e.live.realized_pnl);
      liveIdx += 1;
    }
    const live_winrate = total ? (wins / total) * 100 : null;
    const live_pf = gl > 0 ? gp / gl : gp > 0 ? null : null;
    points.push({
      t: e.t,
      bt_winrate: lastBtWr,
      bt_pf: lastBtPf,
      live_winrate,
      live_pf,
    });
  }
  // Avoid unused warning
  void liveIdx;
  return points;
}

function fmtTick(t: number) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function EdgeComparisonChart({
  health,
  closedPositions,
}: {
  health: HealthSnapshotLite[];
  closedPositions: PositionLite[];
}) {
  const series = buildSeries(health, closedPositions);
  const empty = series.length === 0;

  return (
    <Card title="Backtest vs live edge">
      {empty ? (
        <p className="text-xs text-muted-foreground">Ingen data å sammenligne ennå.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-[200px]">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Winrate %
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" domain={[0, 100]} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 11 }}
                  labelFormatter={(l) => new Date(Number(l)).toLocaleString()}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="bt_winrate" name="Backtest" stroke="hsl(var(--accent))" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="live_winrate" name="Live" stroke="hsl(var(--success))" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="h-[200px]">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              Profit factor
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <XAxis dataKey="t" tickFormatter={fmtTick} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 11 }}
                  labelFormatter={(l) => new Date(Number(l)).toLocaleString()}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="bt_pf" name="Backtest" stroke="hsl(var(--accent))" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="live_pf" name="Live" stroke="hsl(var(--success))" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}
