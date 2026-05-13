## Problem

Linjene i `EdgeComparisonChart` (Backtest vs Live edge — winrate og PF) og arealet i `HealthHistoryChart` (Net profit history) tegnes ikke fordi fargene wrappes feil:

- `src/styles.css` definerer tokens som `oklch(...)`
- chart-komponentene bruker `stroke="hsl(var(--accent))"` → CSS blir `hsl(oklch(...))` → ugyldig → Recharts tegner ingenting

I tillegg er `--accent` for mørk til å fungere som linjefarge på den mørke kortbakgrunnen.

## Fix (kun frontend, kun farge-strenger)

### 1. `src/components/symbol-detail/EdgeComparisonChart.tsx`

Bytt alle `stroke="hsl(var(--X))"` til `stroke="var(--X)"`. Bytt BT-serien fra `--accent` til `--primary` så den faktisk kontrasterer mot bakgrunnen.

| Element | Før | Etter |
|---|---|---|
| Grid stroke | `hsl(var(--border))` | `var(--border)` |
| Axis stroke | `hsl(var(--muted-foreground))` | `var(--muted-foreground))` |
| Tooltip bg/border | `hsl(var(--card))` / `hsl(var(--border))` | `var(--card)` / `var(--border)` |
| BT line stroke | `hsl(var(--accent))` | `var(--primary)` |
| Live line stroke | `hsl(var(--success))` | `var(--success)` |

Behold `strokeWidth={1.5}`, `dot={false}`, `type="monotone"`. Gjelder begge LineChart-blokkene (winrate + PF).

### 2. `src/components/symbol-detail/HealthHistoryChart.tsx`

Samme fix:
- gradient `stop` farger: `hsl(var(--success))` → `var(--success)`
- grid/axis/tooltip strenger: fjern `hsl(...)`-wrapper
- `Area` stroke: `hsl(var(--success))` → `var(--success)`

## Utenfor scope

- Ingen endringer i `src/styles.css`, ingen nye tokens
- Ingen endringer i datalag, queries, eller `symbol-metrics.ts`
- Ingen endringer i KPI-grid, TradingView-chart, tabeller eller andre paneler
- Ingen endringer i execution/risk/dispatcher/bridge

## Verifisering

Etter fix: refresh `/symbols/ZECUSDT` og bekreft at:
- to fargede linjer (lys blå = Backtest, grønn = Live) vises i begge edge-charts
- Net profit history viser grønt areal med toppstrøk
