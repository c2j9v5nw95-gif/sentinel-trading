import { Card } from "@/components/PageHeader";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
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
  bt_net_profit: number | null;
  live_net_profit: number | null;
};

function buildSeries(health: HealthSnapshotLite[], closed: PositionLite[]): Point[] {
  const sortedHealth = [...health]
    .filter((h) => h.net_profit != null)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const sortedClosed = [...closed]
    .filter((p) => p.closed_at)
    .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());

  type Ev = { t: number; kind: "bt" | "live"; bt?: HealthSnapshotLite; live?: PositionLite };
  const events: Ev[] = [];
  for (const h of sortedHealth)
    events.push({ t: new Date(h.created_at).getTime(), kind: "bt", bt: h });
  for (const p of sortedClosed)
    events.push({ t: new Date(p.closed_at!).getTime(), kind: "live", live: p });
  events.sort((a, b) => a.t - b.t);

  let lastBt: number | null = null;
  let liveCum = 0;
  let liveSeen = false;

  const points: Point[] = [];
  for (const e of events) {
    if (e.kind === "bt" && e.bt?.net_profit != null) {
      lastBt = Number(e.bt.net_profit);
    } else if (e.kind === "live" && e.live) {
      liveCum += Number(e.live.realized_pnl) || 0;
      liveSeen = true;
    }
    points.push({
      t: e.t,
      bt_net_profit: lastBt,
      live_net_profit: liveSeen ? liveCum : null,
    });
  }
  return points;
}

function fmtSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}`;
}

export function HealthHistoryChart({
  health,
  closedPositions,
}: {
  health: HealthSnapshotLite[];
  closedPositions: PositionLite[];
}) {
  const data = buildSeries(health, closedPositions);

  return (
    <Card title="Net profit history (backtest vs live)">
      {data.length < 2 ? (
        <p className="text-xs text-muted-foreground">For lite historikk.</p>
      ) : (
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data}>
              <defs>
                <linearGradient id="np-bt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="t"
                tickFormatter={(t) => {
                  const d = new Date(t);
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                }}
                tick={{ fontSize: 10 }}
                stroke="var(--muted-foreground)"
              />
              <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  fontSize: 11,
                }}
                labelFormatter={(l) => new Date(Number(l)).toLocaleString()}
                formatter={(value: number | string, name) => [fmtSigned(Number(value)), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                dataKey="bt_net_profit"
                name="Backtest"
                stroke="var(--primary)"
                strokeWidth={1.5}
                fill="url(#np-bt)"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="live_net_profit"
                name="Live realized"
                stroke="var(--success)"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
