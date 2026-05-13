import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { evaluateClient, type EvalRule, type EvalSnap } from "@/lib/sizing-eval";
import {
  computeSymbolMetrics,
  type HealthSnapshotLite,
  type PositionLite,
  type SignalLite,
  type PositionEventLite,
} from "@/lib/symbol-metrics";
import { SymbolHeader } from "@/components/symbol-detail/SymbolHeader";
import { KpiGrid } from "@/components/symbol-detail/KpiGrid";
import {
  TradingViewChart,
  type ChartMarker,
} from "@/components/symbol-detail/TradingViewChart";
import { EdgeComparisonChart } from "@/components/symbol-detail/EdgeComparisonChart";
import { HealthHistoryChart } from "@/components/symbol-detail/HealthHistoryChart";
import {
  ActivePositionPanel,
  type ActivePosition,
} from "@/components/symbol-detail/ActivePositionPanel";
import { ClosedTradesTable } from "@/components/symbol-detail/ClosedTradesTable";
import { SignalHistoryTable } from "@/components/symbol-detail/SignalHistoryTable";
import { SizingResolutionCard } from "@/components/symbol-detail/SizingResolutionCard";
import { ExecutionReliabilityPanel } from "@/components/symbol-detail/ExecutionReliabilityPanel";

export const Route = createFileRoute("/_app/symbols_/$symbol")({
  component: SymbolDetailPage,
});

function SymbolDetailPage() {
  const { symbol } = Route.useParams();
  const refetchInterval = 15000;

  const symbolQ = useQuery({
    queryKey: ["symbol", symbol],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("*").eq("symbol", symbol).maybeSingle();
      return data;
    },
  });

  const overrideQ = useQuery({
    queryKey: ["symbol-override", symbol],
    queryFn: async () => {
      const { data } = await supabase
        .from("symbol_strategy_overrides")
        .select("*")
        .eq("symbol", symbol)
        .maybeSingle();
      return data;
    },
  });

  const rulesQ = useQuery({
    queryKey: ["sizing-rules"],
    queryFn: async () => {
      const { data } = await supabase
        .from("sizing_rules")
        .select("*")
        .eq("enabled", true)
        .order("priority", { ascending: true });
      return (data ?? []) as EvalRule[];
    },
  });

  const healthQ = useQuery({
    queryKey: ["symbol-health", symbol],
    refetchInterval,
    queryFn: async () => {
      const { data } = await supabase
        .from("health_snapshots")
        .select("symbol,strategy,tag,winrate,profit_factor,net_profit,bar_time,created_at,payload")
        .eq("symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as HealthSnapshotLite[];
    },
  });

  const positionsQ = useQuery({
    queryKey: ["symbol-positions", symbol],
    refetchInterval,
    queryFn: async () => {
      const { data } = await supabase
        .from("positions")
        .select(
          "id,symbol,side,entry_price,qty_initial,qty_open,realized_pnl,opened_at,closed_at,protection_state,sl_price,tsl_active,tsl_trigger_price,last_seen_price,unprotected_since,leverage",
        )
        .eq("symbol", symbol)
        .order("opened_at", { ascending: false })
        .limit(100);
      return (data ?? []) as ActivePosition[];
    },
  });

  const eventsQ = useQuery({
    queryKey: ["symbol-position-events", symbol, positionsQ.data?.length],
    refetchInterval,
    enabled: !!positionsQ.data && positionsQ.data.length > 0,
    queryFn: async () => {
      const ids = (positionsQ.data ?? []).map((p) => p.id);
      if (!ids.length) return [];
      const { data } = await supabase
        .from("position_events")
        .select("*")
        .in("position_id", ids)
        .order("created_at", { ascending: false })
        .limit(500);
      return (data ?? []) as PositionEventLite[];
    },
  });

  const ordersQ = useQuery({
    queryKey: ["symbol-orders", symbol],
    refetchInterval,
    queryFn: async () => {
      const { data } = await supabase
        .from("orders")
        .select("id,position_id,symbol,side,price,qty,purpose,status,submitted_at")
        .eq("symbol", symbol)
        .order("submitted_at", { ascending: false })
        .limit(200);
      return data ?? [];
    },
  });

  const signalsQ = useQuery({
    queryKey: ["symbol-signals", symbol],
    refetchInterval,
    queryFn: async () => {
      const { data } = await supabase
        .from("signals")
        .select("id,symbol,type,action,status,decision_reason,created_at")
        .eq("symbol", symbol)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data ?? []) as SignalLite[];
    },
  });

  const positions = positionsQ.data ?? [];
  const closedPositions: PositionLite[] = positions.filter((p) => p.closed_at);
  const activePosition = positions.find((p) => !p.closed_at) ?? null;
  const events = eventsQ.data ?? [];
  const orders = ordersQ.data ?? [];
  const health = healthQ.data ?? [];
  const signals = signalsQ.data ?? [];

  const metrics = useMemo(
    () =>
      computeSymbolMetrics({
        symbol,
        health,
        closedPositions,
        signals,
        positionEvents: events,
      }),
    [symbol, health, closedPositions, signals, events],
  );

  // Sizing snapshot (heartbeat → siste snapshot)
  const snapshot: EvalSnap | null = useMemo(() => {
    if (!health.length) return null;
    const heartbeat = health.find((h) => h.strategy === "HEALTH_ALL") ?? health[0];
    return {
      symbol: heartbeat.symbol,
      strategy: heartbeat.strategy,
      tag: heartbeat.tag ?? "",
      winrate: heartbeat.winrate != null ? Number(heartbeat.winrate) : null,
      profit_factor: heartbeat.profit_factor != null ? Number(heartbeat.profit_factor) : null,
      net_profit: heartbeat.net_profit != null ? Number(heartbeat.net_profit) : null,
    };
  }, [health]);

  const eff = useMemo(() => {
    if (!symbolQ.data || !rulesQ.data) return null;
    return evaluateClient(snapshot, symbolQ.data, overrideQ.data ?? null, rulesQ.data);
  }, [snapshot, symbolQ.data, overrideQ.data, rulesQ.data]);

  const markers = useMemo<ChartMarker[]>(() => {
    const out: ChartMarker[] = [];
    // Entries + exits from positions
    for (const p of positions) {
      if (p.opened_at && p.entry_price) {
        out.push({
          time: Math.floor(new Date(p.opened_at).getTime() / 1000),
          price: Number(p.entry_price),
          kind: p.side === "long" ? "entry_long" : "entry_short",
          text: `${p.side === "long" ? "Long" : "Short"} ${Number(p.entry_price).toPrecision(6)}`,
        });
      }
      if (p.closed_at) {
        // Try to find an exit order for price
        const exitOrder = orders
          .filter(
            (o) =>
              o.position_id === p.id &&
              (o.purpose === "exit_full" ||
                o.purpose === "tp1" ||
                o.purpose === "tp2_rest" ||
                o.purpose === "sl" ||
                o.purpose === "tsl" ||
                o.purpose === "manual_close"),
          )
          .sort(
            (a, b) =>
              new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
          )[0];
        out.push({
          time: Math.floor(new Date(p.closed_at).getTime() / 1000),
          price: exitOrder?.price ? Number(exitOrder.price) : Number(p.entry_price ?? 0),
          kind: "exit",
          text: `Exit ${p.realized_pnl >= 0 ? "+" : ""}${p.realized_pnl.toFixed(2)}`,
        });
      }
    }
    // Position events
    for (const e of events) {
      const t = Math.floor(new Date(e.created_at).getTime() / 1000);
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      const price =
        typeof detail.exit_price === "number"
          ? detail.exit_price
          : typeof detail.price === "number"
          ? detail.price
          : undefined;
      if (e.event_type === "tp1_hit" || e.event_type === "tp2_hit") {
        out.push({ time: t, price, kind: "tp", text: e.event_type.toUpperCase() });
      } else if (e.event_type === "sl_hit" || e.event_type === "tsl_hit") {
        out.push({ time: t, price, kind: "sl", text: "SL" });
      } else if (e.event_type === "manual_close") {
        out.push({ time: t, price, kind: "manual", text: "Manual" });
      } else if (e.event_type.startsWith("recovery_")) {
        out.push({ time: t, price, kind: "recovery", text: e.event_type });
      }
    }
    // Rejected signals
    for (const s of signals) {
      if (s.status === "rejected" || s.status === "error") {
        out.push({
          time: Math.floor(new Date(s.created_at).getTime() / 1000),
          kind: "rejection",
          text: s.decision_reason ?? s.status,
        });
      }
    }
    return out;
  }, [positions, orders, events, signals]);

  const unrealizedPnl = activePosition && activePosition.entry_price && activePosition.last_seen_price && activePosition.qty_open
    ? (activePosition.side === "long"
        ? activePosition.last_seen_price - activePosition.entry_price
        : activePosition.entry_price - activePosition.last_seen_price) * activePosition.qty_open
    : 0;

  if (symbolQ.isLoading) {
    return <p className="text-sm text-muted-foreground">Laster {symbol}…</p>;
  }
  if (!symbolQ.data) {
    return <p className="text-sm text-muted-foreground">Symbol {symbol} ble ikke funnet.</p>;
  }

  return (
    <div className="space-y-6">
      <SymbolHeader
        symbol={symbol}
        enabled={symbolQ.data.enabled}
        executionMode={symbolQ.data.execution_mode_override}
        preferredTransport={symbolQ.data.preferred_transport}
        leverage={Number(symbolQ.data.leverage)}
        marginMode={symbolQ.data.margin_mode}
        lastHealthAt={metrics.bt_last_at}
      />

      <KpiGrid
        metrics={metrics}
        effBalancePct={eff?.balance_pct ?? null}
        effLeverage={eff?.leverage ?? null}
        cfgBalancePct={Number(symbolQ.data.account_balance_percent)}
        cfgLeverage={Number(symbolQ.data.leverage)}
        unrealizedPnl={unrealizedPnl}
      />

      <TradingViewChart symbol={symbol} markers={markers} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <EdgeComparisonChart health={health} closedPositions={closedPositions} />
        </div>
        <ActivePositionPanel position={activePosition} />
      </div>

      <HealthHistoryChart health={health} />

      <ClosedTradesTable positions={closedPositions} events={events} />

      <SignalHistoryTable signals={signals} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SizingResolutionCard
          symbol={symbol}
          symbolRow={symbolQ.data}
          override={overrideQ.data ?? null}
          rules={rulesQ.data ?? []}
          snapshot={snapshot}
        />
        <ExecutionReliabilityPanel metrics={metrics} />
      </div>
    </div>
  );
}
