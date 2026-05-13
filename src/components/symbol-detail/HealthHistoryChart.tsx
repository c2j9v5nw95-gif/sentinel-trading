import { Card } from "@/components/PageHeader";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { HealthSnapshotLite } from "@/lib/symbol-metrics";

export function HealthHistoryChart({ health }: { health: HealthSnapshotLite[] }) {
  const data = [...health]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((h) => ({
      t: new Date(h.created_at).getTime(),
      net_profit: h.net_profit != null ? Number(h.net_profit) : null,
    }));

  return (
    <Card title="Net profit history (backtest)">
      {data.length < 2 ? (
        <p className="text-xs text-muted-foreground">For lite historikk.</p>
      ) : (
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="np" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--success)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
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
              />
              <Area type="monotone" dataKey="net_profit" stroke="var(--success)" fill="url(#np)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
