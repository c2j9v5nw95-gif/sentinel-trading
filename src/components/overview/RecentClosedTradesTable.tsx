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

type Origin = "tv" | "bybit" | "recovery" | "manual" | "unknown";

interface ExitClassification {
  origin: Origin;
  label: string;
  raw: string;
}

// Maps a position_events.event_type to an exit classification.
// Returns null if the event is not a terminal exit event.
function classifyEvent(eventType: string): ExitClassification | null {
  if (eventType === "sl_triggered") return { origin: "bybit", label: "SL hit", raw: eventType };
  if (eventType === "tsl_triggered") return { origin: "bybit", label: "TSL hit", raw: eventType };
  if (eventType === "exit_tp1") return { origin: "bybit", label: "TP1 hit", raw: eventType };
  if (eventType === "exit_tp2_rest") return { origin: "bybit", label: "TP2 hit", raw: eventType };
  if (eventType === "exit_sl_failsafe") return { origin: "bybit", label: "SL failsafe", raw: eventType };
  if (eventType === "exit_recovery_succeeded")
    return { origin: "recovery", label: "Forced close", raw: eventType };
  if (eventType === "manual_close") return { origin: "manual", label: "Manual close", raw: eventType };
  // exit_exit_full / other exit_* events come from a TV signal — handled via signals.exit_reason.
  return null;
}

function originStyle(origin: Origin): string {
  switch (origin) {
    case "tv":
      return "border-success/40 bg-success/10 text-success";
    case "bybit":
      return "border-warning/40 bg-warning/10 text-warning";
    case "recovery":
      return "border-danger/40 bg-danger/10 text-danger";
    case "manual":
      return "border-border bg-muted text-muted-foreground";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function originPrefix(origin: Origin): string {
  switch (origin) {
    case "tv":
      return "TV";
    case "bybit":
      return "BYBIT";
    case "recovery":
      return "RECOVERY";
    case "manual":
      return "MANUAL";
    default:
      return "—";
  }
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
  const positionIds = rows.map((r) => r.id);

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
      for (const s of data ?? [])
        m.set(s.id as string, (s as { exit_reason: string | null }).exit_reason);
      return m;
    },
  });

  // Latest matching exit-event per position (sl_triggered, tsl_triggered, exit_tp*, exit_recovery_succeeded, manual_close).
  const { data: eventByPos } = useQuery({
    queryKey: ["overview", "closed_trade_exit_events", positionIds],
    enabled: positionIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("position_events")
        .select("position_id,event_type,detail,created_at")
        .in("position_id", positionIds)
        .in("event_type", [
          "sl_triggered",
          "tsl_triggered",
          "exit_tp1",
          "exit_tp2_rest",
          "exit_sl_failsafe",
          "exit_recovery_succeeded",
          "manual_close",
        ])
        .order("created_at", { ascending: false });
      if (error) throw error;
      const m = new Map<string, { event_type: string; detail: unknown }>();
      for (const e of data ?? []) {
        const pid = (e as { position_id: string }).position_id;
        if (!m.has(pid))
          m.set(pid, {
            event_type: (e as { event_type: string }).event_type,
            detail: (e as { detail: unknown }).detail,
          });
      }
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
                <th className="py-2 pr-2 font-medium">Closed by</th>
                <th className="py-2 pr-2 font-medium">Hold</th>
                <th className="py-2 pr-2 font-medium">Closed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ev = eventByPos?.get(r.id) ?? null;
                const evClass = ev ? classifyEvent(ev.event_type) : null;
                const tvReason = r.last_exit_signal_id
                  ? exitSignals?.get(r.last_exit_signal_id) ?? null
                  : null;

                // Priority: Bybit/recovery/manual events win (they describe the actual close).
                // Otherwise fall back to TV signal exit_reason.
                let origin: Origin = "unknown";
                let label = "—";
                let raw = "unknown";
                if (evClass) {
                  origin = evClass.origin;
                  label = evClass.label;
                  raw = evClass.raw;
                } else if (tvReason) {
                  origin = "tv";
                  label = tvReason;
                  raw = `signal:${tvReason}`;
                }

                const tooltip = `event=${raw}${tvReason ? ` · tv=${tvReason}` : ""}`;

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
                    <td className="py-2 pr-2" title={tooltip}>
                      {origin === "unknown" ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase ${originStyle(origin)}`}
                        >
                          <span className="font-bold">{originPrefix(origin)}</span>
                          <span className="font-medium">{label}</span>
                        </span>
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
