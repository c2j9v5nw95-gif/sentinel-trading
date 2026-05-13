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
  tsl_active: boolean;
}

type Origin = "tv" | "monitor" | "bybit" | "recovery" | "manual" | "unknown";
type Tone = "success" | "warning" | "danger" | "muted";

interface Classification {
  origin: Origin;
  label: string;
  tone: Tone;
  raw: string;
}

// TradingView strategy code → label + tone (matches strategy_codes table & Pine alerts).
const TV_CODE_MAP: Record<string, { label: string; tone: Tone }> = {
  XL1: { label: "XL1 · TP1", tone: "success" },
  XL2: { label: "XL2 · SL/Failsafe", tone: "warning" },
  XL3: { label: "XL3 · Opposite", tone: "success" },
  XL4: { label: "XL4 · TP2 (REST)", tone: "success" },
  XL5: { label: "XL5 · Trend fail", tone: "warning" },
  XS1: { label: "XS1 · TP1", tone: "success" },
  XS2: { label: "XS2 · SL/Failsafe", tone: "warning" },
  XS3: { label: "XS3 · Opposite", tone: "success" },
  XS4: { label: "XS4 · TP2 (REST)", tone: "success" },
  XS5: { label: "XS5 · Trend fail", tone: "warning" },
};

const EXIT_EVENT_TYPES = [
  "sl_triggered",
  "tsl_triggered",
  "exit_tp1",
  "exit_tp2_rest",
  "exit_sl_failsafe",
  "exit_exit_full",
  "exit_recovery_succeeded",
  "manual_close",
  "reconciliation_drift",
];

function classifyExit(
  events: Set<string>,
  tslActive: boolean,
  tvCode: string | null,
  tvReason: string | null,
): Classification {
  // 1. Manual operator close.
  if (events.has("manual_close"))
    return { origin: "manual", label: "Manual close", tone: "muted", raw: "manual_close" };

  // 2. Recovery / forced close by reconcile.
  if (events.has("exit_recovery_succeeded"))
    return {
      origin: "recovery",
      label: "Forced close",
      tone: "danger",
      raw: "exit_recovery_succeeded",
    };

  // 3. Our protection-monitor sent a reduce-only exit (internal SL/TSL trip).
  if (events.has("sl_triggered"))
    return { origin: "monitor", label: "SL", tone: "danger", raw: "sl_triggered" };
  if (events.has("tsl_triggered"))
    return { origin: "monitor", label: "TSL", tone: "danger", raw: "tsl_triggered" };

  // 4. TradingView-triggered exit — we have an exit_* event, label it from strategy_code.
  const hasTvExit =
    events.has("exit_tp1") ||
    events.has("exit_tp2_rest") ||
    events.has("exit_sl_failsafe") ||
    events.has("exit_exit_full");
  if (hasTvExit && tvCode && TV_CODE_MAP[tvCode]) {
    const m = TV_CODE_MAP[tvCode];
    return { origin: "tv", label: m.label, tone: m.tone, raw: `tv:${tvCode}` };
  }
  if (hasTvExit && tvReason) {
    return { origin: "tv", label: tvReason, tone: "success", raw: `tv:${tvReason}` };
  }

  // 5. Bybit native SL/TSL fill — only reconcile-drift, no other exit event.
  if (events.has("reconciliation_drift")) {
    return tslActive
      ? { origin: "bybit", label: "TSL fill", tone: "warning", raw: "reconciliation_drift" }
      : { origin: "bybit", label: "SL fill", tone: "warning", raw: "reconciliation_drift" };
  }

  // 6. Fallback to TV signal reason if it's all we have.
  if (tvCode && TV_CODE_MAP[tvCode]) {
    const m = TV_CODE_MAP[tvCode];
    return { origin: "tv", label: m.label, tone: m.tone, raw: `tv:${tvCode}` };
  }
  if (tvReason) {
    return { origin: "tv", label: tvReason, tone: "success", raw: `tv:${tvReason}` };
  }

  return { origin: "unknown", label: "—", tone: "muted", raw: "unknown" };
}

function toneStyle(tone: Tone): string {
  switch (tone) {
    case "success":
      return "border-success/40 bg-success/10 text-success";
    case "warning":
      return "border-warning/40 bg-warning/10 text-warning";
    case "danger":
      return "border-danger/40 bg-danger/10 text-danger";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function originPrefix(origin: Origin): string {
  switch (origin) {
    case "tv":
      return "TV";
    case "monitor":
      return "MONITOR";
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
          "id,symbol,side,entry_price,last_seen_price,realized_pnl,opened_at,closed_at,execution_mode,last_exit_signal_id,tsl_active",
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
    queryKey: ["overview", "closed_trade_exit_signals", exitIds],
    enabled: exitIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signals")
        .select("id,exit_reason,strategy_code")
        .in("id", exitIds);
      if (error) throw error;
      const m = new Map<string, { exit_reason: string | null; strategy_code: string | null }>();
      for (const s of data ?? []) {
        const row = s as { id: string; exit_reason: string | null; strategy_code: string | null };
        m.set(row.id, { exit_reason: row.exit_reason, strategy_code: row.strategy_code });
      }
      return m;
    },
  });

  // All exit-related events per position (we need the full set, not just the latest one).
  const { data: eventsByPos } = useQuery({
    queryKey: ["overview", "closed_trade_exit_events_v2", positionIds],
    enabled: positionIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("position_events")
        .select("position_id,event_type")
        .in("position_id", positionIds)
        .in("event_type", EXIT_EVENT_TYPES);
      if (error) throw error;
      const m = new Map<string, Set<string>>();
      for (const e of data ?? []) {
        const row = e as { position_id: string; event_type: string };
        if (!m.has(row.position_id)) m.set(row.position_id, new Set());
        m.get(row.position_id)!.add(row.event_type);
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
                const events = eventsByPos?.get(r.id) ?? new Set<string>();
                const sig = r.last_exit_signal_id
                  ? exitSignals?.get(r.last_exit_signal_id) ?? null
                  : null;
                const tvCode = sig?.strategy_code ?? null;
                const tvReason = sig?.exit_reason ?? null;
                const c = classifyExit(events, !!r.tsl_active, tvCode, tvReason);

                const eventList = Array.from(events).join(", ") || "(none)";
                const tooltip =
                  `events=${eventList}` +
                  (tvCode ? ` · code=${tvCode}` : "") +
                  (tvReason ? ` · reason=${tvReason}` : "") +
                  ` · classified=${c.raw}`;

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
                      {c.origin === "unknown" ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase ${toneStyle(c.tone)}`}
                        >
                          <span className="font-bold">{originPrefix(c.origin)}</span>
                          <span className="font-medium">{c.label}</span>
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
