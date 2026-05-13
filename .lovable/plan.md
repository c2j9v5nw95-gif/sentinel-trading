## Hva som bygges

To frontend-tillegg på `/overview` — ren presentasjon, ingen endringer i dispatcher, executor, health-gate eller schema.

### 1. Nytt panel: "Symbol health" (blokkert vs åpen)

Et kort under `BridgeHealthCard`-raden som lister alle aktiverte symboler (`symbols.enabled = true`) gruppert i to kolonner:

```text
┌─ Symbol health ────────────────────────────────────────────┐
│  OPEN FOR TRADES (12)        BLOCKED BY HEALTH (2)         │
│  ─────────────────           ────────────────────          │
│  BTCUSDT   PF 1.84  +124     ZECUSDT   PF 0.36  −11   ⛔   │
│  ETHUSDT   PF 1.42  +88      BSBUSDT   PF 0.34  −56   ⛔   │
│  SOLUSDT   PF 1.21  +14                                     │
│  XRPUSDT   PF —     —   ⓘ no health data                   │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

Per symbol viser vi: ticker, siste PF, siste net_profit, og en status-pill (`OPEN` / `BLOCKED` / `NO DATA`). Hover/tooltip viser hvilken terskel som ble brutt (f.eks. `PF 0.36 < 1.0`) og snapshot-alder.

**Datakilder (alle read-only, eksisterer fra før):**
- `symbols` — liste over aktiverte symboler.
- `health_snapshots` — siste rad per `(symbol, strategy='HEALTH_ALL', tag='')`. Henter via `select(...).eq('strategy','HEALTH_ALL').eq('tag','').order('created_at', desc).limit(1)` per symbol, eller en samlespørring + group i frontend.
- `strategies` — én rad `(name='HEALTH_ALL', tag='')` for terskler (`health_min_profit_factor`, `health_min_net_profit`, `health_min_winrate`).

**Klassifisering (samme regler som `health-gate.ts`):**
- Ingen snapshot → `NO DATA` (advisory, ikke blokkert).
- Snapshot finnes og en eller flere terskler brytes → `BLOCKED`, vis hvilken.
- Ellers → `OPEN`.

Refetch hver 30s. Symbolfilteret i `OverviewFilterBar` filtrerer panelet hvis satt.

### 2. Tydelig exit-kilde i "Recent closed trades"

Dagens `Reason`-kolonne viser bare `signals.exit_reason` for TradingView-baserte exits og `—` for SL/TSL/recovery. Vi utvider den til å vise opphav + grunn med farget pill:

```text
Reason
──────────────────────────────────
[TV] EXIT-SHORT          ← TradingView signal
[BYBIT] SL hit           ← Stop loss fra protection-monitor
[BYBIT] TSL hit          ← Trailing stop fra protection-monitor
[BYBIT] TP1 hit          ← Take profit
[RECOVERY] forced close  ← bybit-reconcile reduce-only
```

**Klassifiseringskilder per closed position (read-only):**
1. `signals.exit_reason` via `last_exit_signal_id` → `[TV] <reason>` hvis ikke null.
2. `position_events` for `position_id` filtrert på `event_type IN ('sl_hit','tsl_hit','tp_hit','tsl_moved','exit_recovery_succeeded')` — siste event før `closed_at` bestemmer `[BYBIT]`/`[RECOVERY]`-kategori.
3. Hvis ingen av delene matcher: behold `—` med `unknown` tooltip.

Vi henter `position_events` for de viste rows i én batch (`.in('position_id', ids).in('event_type', [...])`), grupperer i klient, og kombinerer med signal-mappen som allerede finnes. Pill-fargene bruker eksisterende design tokens (`bg-muted`/`bg-warning/15`/`bg-danger/15`).

Tooltip på pillen viser rå `event_type` + `detail.reason` for forensikk.

## Tekniske detaljer

**Nye filer**
- `src/components/overview/SymbolHealthPanel.tsx` — komponent + queries for panel 1.

**Endrede filer**
- `src/routes/_app.overview.tsx` — render `<SymbolHealthPanel />` etter metric-grid (full bredde, før exposure-raden).
- `src/components/overview/RecentClosedTradesTable.tsx` — utvid exit-reason query til å inkludere `position_events` og rendre kombinert pill.

**Ingen endringer i:** dispatcher, executor, health-gate, protection-monitor, risk-engine, schema, RLS, edge functions.

**Verifisering:** Etter deploy skal panelet vise ZECUSDT og BSBUSDT som `BLOCKED` (PF < 1.0) og resten som `OPEN`/`NO DATA`. Closed trades-tabellen skal vise `[TV]` for trades stengt av TradingView-signal og `[BYBIT] SL hit` / `[BYBIT] TSL hit` for de som ble stengt av protection-monitor.
