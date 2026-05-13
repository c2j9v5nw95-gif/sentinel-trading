## Mål
Backtest winrate (86,7%) og Backtest PF (2,69) skal ikke vises røde bare fordi live underpresterer. Positive backtest-tall skal være grønne, samtidig som live-vs-bt-forskjellen fortsatt er tydelig synlig.

## Endringer (kun `src/components/symbol-detail/KpiGrid.tsx`)

### 1. Backtest winrate
- **Tone på hovedverdi**: basert på selve winraten, ikke deltaen.
  - `bt_winrate >= 50` → `success` (grønn)
  - `bt_winrate < 50` → `danger` (rød)
  - `null` → `default`
- **Sub-tekst**: behold `live Δ −36,7pp`, men fargelegg kun den lille delta-teksten (grønn hvis ≥0, rød hvis <0) via en liten inline span med `text-success` / `text-danger`. Hovedverdien forblir grønn.

### 2. Backtest PF
- **Tone på hovedverdi**: basert på selve PF-verdien.
  - `bt_profit_factor >= 1` → `success`
  - `bt_profit_factor < 1` → `danger`
  - `null` → `default`
- **Sub-tekst**: samme behandling — `live Δ −1,00` farges inline (rød her), hovedverdi forblir grønn.

### 3. Live winrate (for konsistens)
- Legg på samme tone-regel: `>= 50` grønn, `< 50` rød. (I dag er den uten tone.)

### 4. Live PF (for konsistens)
- `>= 1` grønn, `< 1` rød.

## Hvordan delta-forskjellen synliggjøres
Sub-linjen får et lite fargemerke, f.eks.:
```
live Δ <span class="text-danger">−36,7pp</span>
```
Slik at brukeren umiddelbart ser at live ligger under backtest, uten at hele backtest-tallet feilaktig signaliserer "dårlig".

## Utenfor scope
- Ingen endringer i `symbol-metrics.ts` (deltaberegningen er korrekt).
- Ingen endringer i `EdgeComparisonChart`, `HealthHistoryChart`, TradingView, execution, dispatcher, risk, sizing eller routing.
- Ingen DB- eller backend-endringer.

## Filer berørt
- `src/components/symbol-detail/KpiGrid.tsx` (eneste fil)
