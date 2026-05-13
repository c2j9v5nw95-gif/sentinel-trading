## Vision

Symbol Detail blir det langsiktige etterretningsdossieret per coin og fundamentet for et fremtidig Screener-system. Tre datadomener samles på én side:

1. **TradingView backtest-helse** (`health_snapshots`)
2. **Live app-execution** (`positions`, `orders`, `signals`, `position_events`, `risk_decisions`)
3. **Bybit marked** (TradingView-widget for live chart; lokal `positions`/`balance_snapshots` for eksponering)

**Strikt read-only analytics-fase.** Ingen endringer i execution, dispatcher, bridge, reconcile, risk engine, signal processing, sizing eller order routing. Ingen DB-migrasjoner. Ingen server-functions. Ingen replay eller andre execution-adjacent handlinger på denne siden — replay forblir kun på `/signals`.

## Rute & navigasjon

- Ny rute: `src/routes/_app.symbols.$symbol.tsx` → `/symbols/:symbol`
- Symbol-cellen i `_app.symbols.tsx` blir `<Link to="/symbols/$symbol" params={{ symbol }}>`
- Detaljsiden får "← Symbols"-tilbake-lenke i `PageHeader`

## Sideoppbygging

```text
┌──────────────────────────────────────────────────────────────────┐
│ [← Symbols]  RAVEUSDT  ·  enabled-chip  ·  exec-mode             │
│ Sub: leverage · margin-mode · transport · last health snapshot   │
├──────────────────────────────────────────────────────────────────┤
│ KPI-rad (8 kort, 2 x 4):                                         │
│  Eff equity% | Eff lev | Live winrate | Backtest winrate         │
│  Live PF     | BT PF   | Realized PnL | Unrealized PnL           │
│  (DualValue: cfg under eff der relevant)                         │
├──────────────────────────────────────────────────────────────────┤
│ ┌─ Live TradingView-chart (full bredde) ───────────────────────┐ │
│ │  Toolbar: 1m | 5m | 15m | 1h | 4h | 1d                       │ │
│ │  Marker-toggles: Entries · Exits · TP · SL · Rejections ·    │ │
│ │                  Recovery · Manual                            │ │
│ │  TradingView Advanced Chart widget (BYBIT:{symbol}.P)         │ │
│ │  Overlay shapes via widget API                                │ │
│ └───────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│ ┌─ Backtest vs Live edge ─────────────┐ ┌─ Active position ───┐ │
│ │  Dual-line: BT winrate vs live wr   │ │  side, qty, entry,  │ │
│ │  Dual-line: BT PF vs live PF        │ │  unreal PnL, sl/tsl │ │
│ │  Net profit / drawdown history      │ │  protection-state   │ │
│ └─────────────────────────────────────┘ └──────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│ Closed trades (siste 50)                                         │
├──────────────────────────────────────────────────────────────────┤
│ Signal-historikk (siste 50) — read-only                          │
│   tid · type · action · status · decision_reason · entry/exit    │
│   reason · "Replay eligible"-chip (ingen knapp her)              │
├──────────────────────────────────────────────────────────────────┤
│ Sizing-resolution: matchende regel + override + final eff verdi  │
├──────────────────────────────────────────────────────────────────┤
│ Execution-reliability: rejections, recovery-events, dead-letters │
└──────────────────────────────────────────────────────────────────┘
```

## Datalag — bygd for fremtidig Screener

Pure metrics-aggregat i `src/lib/symbol-metrics.ts` — gjenbrukes av Screener senere uten endringer.

```ts
export interface SymbolMetrics {
  symbol: string;
  // Backtest (siste health_snapshot)
  bt_winrate: number | null;
  bt_profit_factor: number | null;
  bt_net_profit: number | null;
  bt_last_at: string | null;
  // Live execution (closed positions)
  live_trades: number;
  live_winrate: number | null;
  live_profit_factor: number | null;
  live_realized_pnl: number;
  live_avg_pnl_pct: number | null;
  live_max_drawdown_pct: number | null;
  live_avg_time_in_trade_sec: number | null;
  // Edge-delta
  edge_winrate_delta: number | null;
  edge_pf_delta: number | null;
  // Reliability
  signals_total: number;
  signals_rejected: number;
  signals_error: number;
  rejection_rate: number;
  recovery_events: number;
  // Composite scores (0-100, vekter justeres senere)
  profitability_score: number | null;
  signal_quality_score: number | null;
  reliability_score: number | null;
}

export function computeSymbolMetrics(input: {
  symbol: string;
  health: HealthSnapshot[];
  closedPositions: Position[];
  signals: Signal[];
  positionEvents: PositionEvent[];
}): SymbolMetrics;
```

## Markør-pipeline (chart-overlay)

| Kilde | Tabell | Filter | Markør |
|---|---|---|---|
| Entry | `positions` | `opened_at`, `entry_price`, `side` | grønn ▲ long / rød ▼ short |
| Exit | `positions` | `closed_at` + siste exit-order pris | hvit ◆ |
| TP-hit | `position_events` | `tp1_hit`/`tp2_hit` | gul ★ |
| SL-hit | `position_events` | `sl_hit` | rød ✕ |
| Manual | `position_events` | `manual_close` | lilla ◯ |
| Rejected signal | `signals` | `status IN ('rejected','error')` | grå ! |
| Recovery | `position_events` | `recovery_*` | oransje ↻ |

Pris fra `orders.price` / `orders.response_payload`; fallback `position.entry_price` / `last_seen_price`. Tid i UTC-ms til widget'en.

## Komponentstruktur

**Nye:**
- `src/routes/_app.symbols.$symbol.tsx`
- `src/lib/symbol-metrics.ts`
- `src/components/symbol-detail/SymbolHeader.tsx`
- `src/components/symbol-detail/KpiGrid.tsx`
- `src/components/symbol-detail/TradingViewChart.tsx` — laster `s3.tradingview.com/tv.js`, init i useEffect, shapes via `widget.activeChart().createShape()`, fallback hvis script-load feiler
- `src/components/symbol-detail/EdgeComparisonChart.tsx`
- `src/components/symbol-detail/HealthHistoryChart.tsx`
- `src/components/symbol-detail/ActivePositionPanel.tsx`
- `src/components/symbol-detail/ClosedTradesTable.tsx`
- `src/components/symbol-detail/SignalHistoryTable.tsx` — **read-only**, ingen replay-knapp
- `src/components/symbol-detail/SizingResolutionCard.tsx` — bruker eksisterende `evaluateClient` fra `sizing-eval`
- `src/components/symbol-detail/ExecutionReliabilityPanel.tsx`

**Endret:**
- `src/routes/_app.symbols.tsx` — symbol-cellen → `<Link>` (kun cellen)

**Auto-generert:** `src/routeTree.gen.ts`

## Queries (alle via browser supabase + useQuery, refresh 15s)

`symbols`, `symbol_strategy_overrides`, `sizing_rules`, `health_snapshots` (limit 200), `positions` (limit 100), `position_events` (limit 500), `orders` (limit 200), `signals` (limit 100), `risk_decisions` for siste rejections. RLS-policies dekker alt for operator-rolle.

## Designspråk

Mørk mission-control. Semantiske tokens fra `src/styles.css` (ingen hardcoded farger). `tabular-nums`. Eksisterende `MetricCard`. Markør-fargepalett bundet til `--success`/`--danger`/`--warning`/`--accent`/`--muted-foreground`.

## Eksplisitt utenfor scope

- Ingen replay/dispatch/execution-handlinger på Symbol Detail (replay forblir på `/signals`)
- Ingen Screener-side ennå — men `computeSymbolMetrics` er klar for det
- Ingen DB-migrasjoner, server-functions, edge functions, secrets
- Ingen endringer i execution/risk/dispatcher/bridge/reconcile/sizing-logikk
