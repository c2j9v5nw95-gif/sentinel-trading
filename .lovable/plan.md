
# Backtest Calibration v1 — final (insert-only observations, configurable decay, OCR review)

Mål: feedback-loop Admission Screener → TradingView backtest → rask manuell rapportering (manuell ELLER screenshot+OCR med review) → kalibrert prioritering. Ingen endringer i execution-stacken.

## 1. Avklaringer (bekreftet)

- **Strategy version**: fritekst v1 + autocomplete fra tidligere brukte verdier.
- **Calibration trigger**: `include_calibration` default ON, kan skrus av.
- **Default strategy version i dialog**: siste brukt av innlogget bruker (`user_id = auth.uid()` order by `created_at desc`), fallback siste brukt globalt. Aldri MAX leksikalsk.

## 2. Datamodell

### Ny tabell `coin_backtest_results` (append-only observasjoner)

Kjerne:
- `id uuid pk`, `user_id uuid`, `created_at`, `updated_at`
- `symbol text`, `test_date date`, `strategy_version text`
- `admission_result_id uuid` (nullable), `admission_run_id uuid` (nullable)
- `screener_snapshot jsonb` (frosset profil-features: HTQ/htq_components, persistence, flips, smoothness_efficiency, mtf_alignment, wick_penalty, robustness, liquidity_tier, turnover_24h/7d, OI, spread, listing_age, current_momentum)
- `timeframe text default '5m'`, `candles_tested int default 9000`, `lookback_equivalent_days numeric`

Backtest-tall (confirmed):
- `net_profit_pct`, `net_profit_usd`, `max_drawdown_pct`, `max_drawdown_usd`, `profit_factor`, `win_rate_pct`, `num_trades`, `avg_pnl_pct`, `avg_bars_in_trade`, `expected_payoff_usd`, `sharpe_ratio`, `largest_profit_usd`, `largest_loss_usd`, `profitable_trades_count`, `losing_trades_count`

Klassifisering:
- `label text check in ('rejected_backtest','marginal','profitable','profitable_plus')`
- `auto_suggested_label text`, `notes text`

Screenshot/OCR:
- `screenshot_storage_path text` (permanent), **ingen permanent signed URL** — signert URL genereres on-demand
- `extraction_source text check in ('manual','screenshot_ocr')`
- `extraction_status text check in ('manual','pending_review','confirmed','failed')`
- `extraction_confidence numeric`, `extracted_raw_text text`, `extracted_metrics jsonb`, `field_confidences jsonb`

**Append-only**: `createBacktestResult` ALLTID INSERT. Samme symbol/strategy_version på ulike datoer = flere observasjoner (begge inngår i læring). `updateBacktestResult` brukes kun ved eksplisitt redigering av eksisterende rad.

**Soft-dedupe** (hindrer kun ekte dobbeltklikk): unique-constraint på `(user_id, symbol, strategy_version, test_date, COALESCE(admission_result_id, '00000000-…'))`. Tester samme symbol på ulike `test_date` eller uten admission_result_id blokkeres ikke.

Indekser: `(symbol, test_date desc)`, `(user_id, created_at desc)`, `(strategy_version)`, `(label)`.

GRANTs: `authenticated` insert/select/update/delete egne rader; `service_role` all. Ingen `anon`. RLS owner-only.

### Utvidelse `coin_admission_results`
`calibration_score numeric`, `calibration_confidence text`, `calibration_label text`, `calibration_neighbors jsonb`, `calibrated_strategy_fit numeric`, `calibration_strategy_version text`, `calibration_status text ('ok'|'unavailable')`, `calibration_reason text`, `calibration_computed_at timestamptz`.

### Utvidelse `app_settings` (calibration config)
- `calibration_half_life_days int default 180`
- `calibration_k int default 5`
- `calibration_min_neighbors_medium int default 3`
- `calibration_min_neighbors_high int default 6`
- `calibration_default_strategy_version text` (nullable, fallback)

### Storage
Bucket `backtest-screenshots` (private). Path `{user_id}/{result_id}/{timestamp}.{ext}`. RLS: owner-only read/insert/delete. Signed URL genereres on-demand i `getBacktestScreenshotUrl(result_id)`-serverfunksjon (kort TTL, f.eks. 1t).

## 3. Backend

`src/lib/calibration/`:
- `scoring.ts` — heuristisk kNN over stabile profil-features:
  - **Vektet** (calibration v1): Robustness, HTQ + komponenter (persistence, mtf_alignment, smoothness_efficiency, flip_frequency, wick_penalty), liquidity_tier, turnover_24h/7d, OI, spread, listing_age.
  - **Lav/ingen vekt**: current_momentum (lagres og vises, ikke driver).
  - Vektet euklidsk distanse, time-decay med **konfigurerbar half-life** (default 180d), label-prior. Returnerer score 0–100, confidence-tier (Low/Medium/High via terskler fra `app_settings`), top-k neighbors.
- `calibration.functions.ts`:
  - `listBacktestResults({ symbol?, strategy_version?, label?, limit, offset })`
  - `createBacktestResult(payload)` — **alltid INSERT**; krever `extraction_status in ('manual','confirmed')`; soft-dedupe via unique-constraint returnerer typed error klienten viser pent.
  - `updateBacktestResult(id, patch)` — kun eksplisitt redigering.
  - `deleteBacktestResult(id)`
  - `listStrategyVersions()` — distinct + last-used-by-user metadata
  - `runCalibrationForRun(run_id, strategy_version)` — best-effort per symbol; ved feil settes `calibration_status='unavailable'`, `calibration_reason='calibration_error'` og admission-run fullføres uansett.
  - `extractScreenshot({ storage_path })` — kaller OCR-modell; returnerer parsed metrics + confidences + raw_text. **Skriver aldri** til `coin_backtest_results`.
  - `getBacktestScreenshotUrl(id)` — on-demand signed URL.

Alle bak `requireSupabaseAuth`. Null import fra execution-stacken.

### OCR
- Lovable AI Gateway via AI SDK. Modellnavn **konfigurerbart** i `app_settings.calibration_ocr_model` (default `google/gemini-3-flash-preview`, kan byttes til annen vision-modell). Provider-helper henter den ved kall.
- Strukturert output (Zod) per felt `{ value, confidence, source_text }`.
- Prompten skiller USD vs %, beholder fortegn, returnerer null ved tvil; raw_text returneres alltid.
- Auto-suggested label fra terskler — kun forslag.

### Calibration ved admission-run
Toggle `include_calibration` (default true). Etter admission-resultater skrives, kalles `runCalibrationForRun` per symbol. Per-symbol best-effort: en feil markerer raden `calibration unavailable` og blokkerer aldri admission.

## 4. UI

### `/admission`
- Toggle **Include calibration** (default on).
- Nye kolonner (toggleable): `Calibration`, `Confidence`, `Calibrated Fit`. Tooltips forklarer kNN, half-life, k.
- Expanded row: **Calibration**-seksjon med top-k neighbors og knapp **Add Backtest Result** (forhåndsutfylt fra rad).

### `BacktestResultDialog`
Tabs: **Manual Entry** | **Quick Add from Screenshot**.

Felles header (prefilled fra rad når tilgjengelig): Symbol, Test date (i dag), Strategy version (autocomplete, default siste brukt av user), Timeframe (5m), Candles tested (9000), Lookback equivalent days (auto), Admission result/run id (read-only badge).

**Manual Entry**: skjema for alle tall + label-dropdown med auto-forslag.

**Quick Add from Screenshot**:
1. Dropzone (PNG/JPG ≤8MB) → upload til `backtest-screenshots`.
2. Kall `extractScreenshot` (Uploading → Extracting → Reviewing).
3. Prefill + banner *"Auto-extracted — please review before saving."*
4. Lav-confidence felter får gul/rød ramme; hover viser source_text.
5. Auto-suggested label vises, kan overstyres.
6. **Save (Confirm)** → setter `extraction_status='confirmed'`, lagrer både confirmed values og `extracted_metrics`.
7. **OCR feiler + manuell utfylling**: bruker fyller inn tall i samme dialog og trykker Save → raden lagres med:
   - `extraction_source='screenshot_ocr'`, `extraction_status='confirmed'`
   - `extracted_metrics` viser at OCR feilet/lav confidence
   - `screenshot_storage_path` beholdes som dokumentasjon
   - Confirmed values brukes i calibration (raden inngår).
8. Thumbnail i historikk → klikk genererer on-demand signed URL.

### `/calibration` (ny, lazy)
- Backtest history (filtre: symbol, label, strategy_version, dato). Kolonner: symbol, test_date, strategy_version, label, key metrics, source-badge, screenshot-thumb.
- Strategy version performance summary.
- Model diagnostics (k, half-life, antall observasjoner, sist kjørt) + redigerbare felter for `half_life_days`, `k`, OCR-modell.

## 5. Datakvalitet & sikkerhet
- Calibration Score bruker KUN confirmed values (`extraction_status in ('manual','confirmed')`).
- OCR rådata beholdes for revisjon.
- Screenshots beholdes uavhengig av screener-runs; ingen permanent signed URL i DB.
- RLS strikt på tabell og bucket.
- Ingen endringer i dispatcher, executor, bridge, risk, sizing, reconcile, order routing.

## 6. Out of scope v1
Embeddings/ML-modell, TradingView API, multi-image batch OCR, automatisk re-kalibrering på cron (kjøres on-demand i admission-run).

## 7. Faseplan
1. Migrering: `coin_backtest_results` (append-only, soft-dedupe constraint), `coin_admission_results`-utvidelse, `app_settings`-felter, bucket + RLS/GRANTs.
2. `calibration/scoring.ts` + server functions (uten OCR).
3. `BacktestResultDialog` Manual Entry + integrasjon i `/admission` expanded row.
4. Calibration ved `runAdmissionScan` (`include_calibration`, best-effort, nye kolonner).
5. OCR `extractScreenshot` + Quick Add tab + review-UI + on-demand signed URL.
6. `/calibration`-side (historikk, diagnostikk, config).

Planen godkjent for build med disse justeringene.
