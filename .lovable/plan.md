
## Ny side: `/analysis` — Backtest ↔ Market Insights

Utnytte `coin_backtest_results.screener_snapshot` (features lagret sammen med hver backtest) for å svare på tre spørsmål:
1. **Drivere** — hvilke markedsegenskaper skiller `profitable+` fra `rejected`?
2. **Kandidat-ranking** — hvilke coins bør prioriteres for live trading nå?
3. **Segmenter** — i hvilke markedsregimer virker strategien best/dårligst?

Alt er read-only analytics. Rører ikke execution, sizing, dispatcher eller signal-pipeline.

---

### Feature-univers (fra `screener_snapshot`)

Toppnivå:
`historical_trend_quality`, `current_momentum_score`, `strategy_fit_score`, `robustness`, `turnover_24h`, `turnover_7d_median`, `open_interest_value`, `spread_bps`, `listing_age_days`, `htq_mode`, `htq_lookback_days`.

Fra `htq_components`:
`smoothness`, `wick_penalty`, `flips_per_day`, `mtf_alignment` / `mtf_alignment_pct`, `trend_runs_1h`, `flip_frequency`, `persistence_1h`, `trend_time_pct`, `tradeability_5m`, `median_efficiency`, `wick_pct_during_trends`, `median_trend_duration_hours`.

Målvariabler: `label` (confirmed, fallback til `auto_suggested_label`), `net_profit_pct`, `profit_factor`, `win_rate_pct`, `backtest_quality_score`.

Ekskluderes fra "vinnende symbol"-analysen: rader med `label='no_trades'`, `num_trades=0`, eller `needs_review=true & label_source='auto'`. (Samme regler som kNN-eksklusjonen i Label Diagnostics — konsistens.)

---

### Sideoppsett — tre faner

```text
┌───────────────────────────────────────────────────────┐
│  /analysis                                            │
│  Filtre: strategy_version · timeframe · min_trades    │
├───────────────────────────────────────────────────────┤
│  [ Drivers ]  [ Ranking ]  [ Segments ]              │
└───────────────────────────────────────────────────────┘
```

**Fane 1 — Drivers (mønstre)**
- Feature-tabell: for hver feature vises median / p25 / p75 per label-bøtte (`profitable_plus`, `profitable`, `marginal`, `rejected_backtest`) + separation-score (Cohen's d mellom profitable+ og rejected). Sortert etter separation.
- Distribusjons-histogrammer (top 6 features etter separation) med label-farger.
- Scatter: valgfri feature X vs. `net_profit_pct`, farget etter label. Klikkbar → symbol-detalj.
- Korrelasjonsmatrise (Pearson) mellom features og `net_profit_pct` / `profit_factor` / `win_rate_pct`.

**Fane 2 — Ranking (kandidatliste)**
- Composite score per (symbol, strategy_version, timeframe), på nyeste `test_date`:
  ```
  score = w1·norm(backtest_quality_score)
        + w2·norm(profit_factor)
        + w3·norm(net_profit_pct / max_drawdown_pct)   // risk-adjusted
        + w4·label_bonus                                // +2 for profitable_plus, +1 for profitable, ...
  ```
  Vekter eksponert i UI (slidere), defaults hardkodet.
- Tabell: rank · symbol · label · net% · DD% · PF · win% · trades · HTQ · momentum · fit · score. Sortering på alle kolonner. CSV-eksport.
- "Peer benchmark"-toggle: vis også 5-nn (screener-features) og deres label-fordeling for kontekst.

**Fane 3 — Segments (regimer)**
- Bucketize hver feature (kvartiler) og vis label-mix per bøtte, f.eks.:
  - `historical_trend_quality`: Q1 / Q2 / Q3 / Q4 → % profitable+
  - `turnover_24h`, `spread_bps`, `listing_age_days`, `mtf_alignment_pct`, `flips_per_day`
- Enkelt 2D-heatmap: velg to features (X, Y) → celle-farge = win-rate for label ∈ {profitable, profitable_plus}. Hjelper med å se "sweet spots".
- Automatisk oppsummering: "Strategien fungerer best når HTQ > X og spread_bps < Y" (regelbasert, ikke ML).

---

### Data & server

- **Én server-fn**: `getAnalysisDataset({ strategy_version, timeframe, min_trades })` i ny fil `src/lib/analysis/analysis.functions.ts`.
  - Bruker `requireSupabaseAuth`.
  - Henter siste `test_date` per (symbol, strategy_version, timeframe) via window-function.
  - Flater ut `screener_snapshot` + `htq_components` til top-level felt for enkel klientbruk.
  - Returnerer plain DTO: `{ rows: AnalysisRow[], meta: { strategies, timeframes, total, excluded } }`.
- All statistikk (median/p25/p75, korrelasjon, kvartil-bøtter, kNN, composite score) beregnes **klient-side** i ren TS. Ingen nye DB-tabeller, ingen migrasjon.
- ~600 rader × ~25 felt = trivielt for browseren.

### Nye filer

- `src/routes/_app.analysis.tsx` — layout + filter-bar + tabs
- `src/routes/_app.analysis.drivers.tsx`
- `src/routes/_app.analysis.ranking.tsx`
- `src/routes/_app.analysis.segments.tsx`
- `src/lib/analysis/analysis.functions.ts` — `getAnalysisDataset`
- `src/lib/analysis/stats.ts` — median/percentiler, Cohen's d, Pearson, kvartil-buckets, kNN, composite score
- `src/components/analysis/FeatureSeparationTable.tsx`
- `src/components/analysis/DistributionHistogram.tsx`
- `src/components/analysis/CorrelationMatrix.tsx`
- `src/components/analysis/RankingTable.tsx`
- `src/components/analysis/SegmentHeatmap.tsx`
- `src/components/analysis/SegmentBucketBars.tsx`

Legger til navigasjonspunkt "Analysis" i eksisterende `AppLayout`.

### Ute av scope (fase 1)

- Ingen fersk screener-refetch fra Bybit — bruker snapshot lagret ved backtest-tid (per ditt svar).
- Ingen ML-modeller (regresjon/tree). Rene statistiske deskriptorer. Kan legges til senere hvis du vil.
- Ingen auto-oppdatering av `recommendations` — bare visning. Vi kan koble til /recommendations i fase 2 hvis mønstrene ser robuste ut.
- Ingen skriving til DB.

### Verifisering

- Sanity: sum per label i Analysis-datasettet ≈ Label Diagnostics-panelet (samme eksklusjonsregler).
- Rank-tabellen matcher manuell sortering på PF for én kjent coin.
- Kvartil-bøtter dekker 100% av rader (ingen fall-through).
