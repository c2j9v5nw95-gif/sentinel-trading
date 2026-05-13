## Mål

Legge til en ekstra linje for **live cumulative realized PnL** i `Net profit history`-kortet, slik at backtest net profit og faktiske trades vises side om side på samme tidsakse.

## Endringer

### `src/components/symbol-detail/HealthHistoryChart.tsx`

1. Utvid prop-signaturen:
   ```ts
   { health: HealthSnapshotLite[]; closedPositions: PositionLite[] }
   ```
2. Bygg en flettet tidsserie (`t` sortert ascending) hvor hvert punkt har:
   - `bt_net_profit` — siste sett-verdi fra `health_snapshots` (forward-fill mellom snapshots)
   - `live_net_profit` — løpende sum av `realized_pnl` for closed positions opp til `t` (forward-fill)
3. Bytt `AreaChart` → `ComposedChart` (eller behold `AreaChart` med to `Area`/`Line`):
   - Backtest: eksisterende grønt areal + linje (`var(--success)`)
   - Live: ny linje i `var(--primary)` (lys blå) — `dot={false}`, `strokeWidth={1.5}`, `type="monotone"`. Ingen fill for å holde det rolig.
4. Legg til `<Legend />` med liten font så de to seriene er tydelig merket.
5. Tooltip viser begge verdiene formatert med fortegn (`+12.34` / `−5.10`).
6. Tom-tilstand: vis kortet hvis enten BT- eller live-data finnes (≥ 2 punkter totalt).

### `src/routes/_app.symbols_.$symbol.tsx`

Send `closedPositions` ned til `<HealthHistoryChart>` (samme array som allerede sendes til `EdgeComparisonChart` og `ClosedTradesTable`).

## Designvalg

- BT = grønn (eksisterende konsistens med "profitt-areal")
- Live = lys blå (`--primary`) — samme som BT-linjen i `EdgeComparisonChart`, så fargesemantikken forblir: **grønn = backtest, blå = live** ... 

Vent — det matcher ikke `EdgeComparisonChart` der jeg satte BT=blå/`--primary` og Live=grønn/`--success`. For å holde fargesemantikken konsekvent på tvers av siden:

- **Backtest = `--primary` (lys blå)**
- **Live = `--success` (grønn)**

Da må `HealthHistoryChart` også oppdateres så BT-arealet/linjen blir blå, og den nye live-linjen blir grønn. Dette gjør hele Symbol Detail-siden konsistent.

## Utenfor scope

- Ingen DB-endringer, ingen nye queries (data finnes allerede på siden)
- Ingen endringer i `symbol-metrics.ts`
- Ingen endringer i KPI-grid, TradingView-chart, eller andre paneler
- Ingen execution/risk/dispatcher-endringer
- Ingen ekvitytidserie utenfor closed positions (åpne PnL er ikke en del av "history")

## Verifisering

På `/symbols/ZECUSDT`:
- to linjer: blå (BT net profit fra health_snapshots) og grønn (live cumulative realized PnL fra closed positions)
- Legend viser begge
- Tooltip viser begge verdier ved hover
