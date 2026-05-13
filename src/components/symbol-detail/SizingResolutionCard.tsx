import { Card } from "@/components/PageHeader";
import { evaluateClient, type EvalRule, type EvalSnap } from "@/lib/sizing-eval";
import { fmtNum } from "@/components/overview/format";

export function SizingResolutionCard({
  symbol,
  symbolRow,
  override,
  rules,
  snapshot,
}: {
  symbol: string;
  symbolRow: any;
  override: any;
  rules: EvalRule[];
  snapshot: EvalSnap | null;
}) {
  const ev = evaluateClient(snapshot, symbolRow, override, rules);
  return (
    <Card title="Sizing resolution">
      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Source</span>
          <span className="font-medium text-foreground">{ev.source}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Effective balance %</span>
          <span className="text-foreground">
            {ev.balance_pct != null ? `${fmtNum(ev.balance_pct, 1)}%` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Effective leverage</span>
          <span className="text-foreground">
            {ev.leverage != null ? `${fmtNum(ev.leverage, 0)}x` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Blocked</span>
          <span className={ev.blocked ? "text-danger" : "text-foreground"}>
            {ev.blocked ? "yes" : "no"}
          </span>
        </div>
        {snapshot && (
          <div className="mt-3 rounded border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            Helse­input · winrate {snapshot.winrate ?? "—"} · PF {snapshot.profit_factor ?? "—"} ·
            netP {snapshot.net_profit ?? "—"}
          </div>
        )}
        {override && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            Override aktiv på {symbol} · force_state={override.force_state ?? "none"}
          </div>
        )}
      </div>
    </Card>
  );
}
