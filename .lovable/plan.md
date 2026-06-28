## Mål

Gjøre admission-screeneren mindre brutal og mer strategi-tilpasset. I dag avvises ~491/500 coins fordi alle krav behandles likt. Vi splitter reglene i **hard kill rules** (alltid reject) og **soft requirements** (kan lempes ved sterk Trend Score), introduserer **Trend Score**, **Strategy Fit Score** og en ny status **Trend Candidate**, og lar operatør velge mellom **Strict Robustness** og **Trend Adjusted** modus.

Fortsatt strikt: ingen endringer på dispatcher, executor, sizing, risk engine, bridge execution eller order routing. Screeneren forblir read-only mot tradingen.

---

## Datamodell (migrasjon)

### `coin_admission_results` — nye kolonner
- `trend_score numeric` (0–100, null hvis ikke beregnet)
- `trend_components jsonb` (delscorer: ema_alignment_5m, ema_alignment_15m, ema_alignment_1h, adx_5m, atr_normality, choppiness, pullback_quality)
- `strategy_fit_score numeric` (0.6 * robustness + 0.4 * trend)
- `hard_kill_rules text[]` (kun harde brudd)
- `soft_failures text[]` (myke brudd som ble lempet eller bidro til downgrade)
- `admission_reason text` (kort menneskelig forklaring)
- `admission_mode text` ('strict' | 'trend_adjusted') — hvilken modus runet brukte
- Behold eksisterende `kill_rules_triggered` (deprecated, fylles fortsatt for bakoverkompatibilitet = union av hard+soft)
- `status` utvides til å støtte 'trend_candidate' (sjekk-constraint eller bare text-validering)

### `coin_admission_runs` — ny kolonne
- `admission_mode text not null default 'strict'`
- `include_trend_quality boolean not null default false`

### `coin_admission_profiles` — utvid `thresholds` JSON
Legg til felter (lagres i eksisterende `thresholds jsonb`, ingen schema-endring):
- `trend_adjusted_enabled` (default false på Conservative, true på Aggressive)
- `min_trend_score_for_soften` (default 75)
- `approved_min_score` / `watchlist_min_score` (allerede der)
- `trend_candidate_min_robustness` (default 55)
- `trend_candidate_min_trend` (default 75)
- `strategy_fit_weight_robustness` (0.6)
- `strategy_fit_weight_trend` (0.4)

Migrasjonen vil også re-seede de to presetsene med nye terskler.

---

## Backend

### `src/lib/admission/scoring.ts`
Refaktorer `computeAdmissionScore`:

1. **Klassifiser reglene** i to lister inne i funksjonen:
   - `HARD`: `min_listing_age_days` (under 7d → hard, mellom 7-min → soft), `min_turnover_24h_usd` (ved <10% av terskel → hard), `max_spread_bps` (>2x → hard, ellers soft), `max_slippage_bps` (>2x → hard), ekstrem wick (>2x `max_1h_drop_pct_30d` → hard), `status != Trading`, manglende kritiske data (ingen ticker / ingen daily bars).
   - `SOFT`: `max_rank`, `min_turnover_7d_median_usd`, `min_open_interest_value_usd`, normal `max_spread_bps`, normal `max_1h_drop_pct_30d`, `max_funding_abs` innenfor 2x, `min_listing_age_days` (mildt).
2. Returner ny shape:
   ```ts
   {
     score, // robustness score 0..100, uendret beregning
     trend_score?, // 0..100 hvis trend_quality kjørt
     strategy_fit_score?,
     components,
     trend_components?,
     hard_kill_rules: string[],
     soft_failures: string[],
     status: 'approved' | 'watchlist' | 'trend_candidate' | 'rejected',
     admission_reason: string,
   }
   ```
3. **Status-logikk** styrt av `mode`:
   - `strict`: kill = hard ∪ soft → reject; ellers buckets fra robustness score (uendret oppførsel).
   - `trend_adjusted`:
     - Hard kill → `rejected`, reason = "Failed hard kill rule: {first rule}"
     - Robustness ≥ 80 → `approved`, "Strong robustness"
     - Robustness ≥ 70 og Trend ≥ 80 → `approved`, "Acceptable robustness, strong trend quality"
     - Robustness ≥ 65 → `watchlist`, "Borderline robustness"
     - Robustness ≥ 55 og Trend ≥ 75 → `trend_candidate`, "Lower robustness, but strong trend profile and no hard kill rules"
     - Ellers → `rejected`, "Insufficient robustness and trend quality"

### `src/lib/admission/trend-quality.ts` (ny)
Ren funksjon `computeTrendQuality(bars5m, bars15m, bars1h)`:
- EMA(20/50/200) alignment per TF → 0/50/100 per TF
- ADX(14) på 5m, score = ramp(adx, 15, 35)
- ATR-normalitet: ATR% ≈ ATR/close, score = invers-ramp på ekstreme verdier
- Choppiness-indeks (14) på 5m, lavere = bedre trend
- Pullback-kvalitet: andel barer som ligger mellom EMA20 og EMA50 vs. spikes utenfor
- Vekt: 5m EMA 25%, 15m EMA 15%, 1h EMA 15%, ADX 20%, ATR 10%, choppiness 10%, pullback 5%
- Returnerer `{ score, components }` eller `null` ved manglende data.

Bruker eksisterende `indicators.ts` der mulig (EMA/ATR/ADX finnes allerede). Nye helpers (Choppiness, pullback-quality) legges til `indicators.ts`.

### `src/lib/admission/admission.server.ts`
- Ny `fetch5mKline(symbol, limit=576)` (~48h) og `fetch15mKline(symbol, limit=288)` (~3d).
- I `buildMetrics`: behold som nå. Trend-data sendes ut separat fra orkestratoren slik at scoring forblir ren.

### `src/lib/admission/admission.functions.ts` (`startAdmissionRun`)
- Utvid `StartInput` med `mode: 'strict' | 'trend_adjusted'` (default 'strict') og `includeTrendQuality: boolean` (default true når mode = trend_adjusted, ellers false).
- Lagre `admission_mode` og `include_trend_quality` på run-raden.
- For hver symbol: hvis `includeTrendQuality`, hent 5m+15m+1h klines (1h gjenbrukes fra eksisterende hourly-call), beregn `computeTrendQuality`.
- Send `mode`, `trendScore`, `trendComponents` inn i utvidet `computeAdmissionScore`.
- Lagre alle nye kolonner i `coin_admission_results`.
- Strategy Fit Score = `0.6 * robustness + 0.4 * trendScore` (når trend mangler: lik robustness).
- Bridge-allowlist: ingen endring — `/v5/market/kline` dekker alle TF.

### Ytelse
Trend quality legger til 2 ekstra kline-kall per symbol (5m, 15m). Med 150-symbol cap og concurrency 12 → ~30s ekstra. Akseptabelt. Mulighet for `skipTrendQuality` toggle.

---

## UI (`src/routes/_app.admission.tsx`)

### Kontrollpanel
- **Mode toggle**: pill-knapper `Strict Robustness` / `Trend Adjusted`
- **Checkbox**: `Inkluder Trend Quality-analyse` (auto-på i Trend Adjusted)
- Eksisterende profil/maxSymbols/skipWick beholdes

### Filterbar (utvid)
- Status-knapper: `all | approved | watchlist | trend_candidate | rejected`
- Ny toggle: `Vis kun Trend Candidates`
- Ny toggle: `Skjul hard rejections` (filtrerer rader hvor `hard_kill_rules` ikke er tom)
- To slidere/inputs: `Min Trend Score` (0–100), `Min Strategy Fit Score` (0–100)

### Resultattabell — nye kolonner
Sorterbar på alle:
- Symbol | Status (badge med ny lilla farge for `trend_candidate`) | **Strategy Fit** | Robustness | **Trend** | Rank | 24h TO | 7d med | OI | Spread | Age | Funding | Max 1h wick | **Hard Kills** (rød) | **Soft Failures** (gul) | **Reason** (kort tekst)

### Expanded row
- Robustness components (som i dag)
- **Trend components** (ny pre-blokk)
- Liste over hard kill rules og soft failures separat
- Admission reason i full lengde

### Summary cards (oppe)
- Approved / Watchlist / **Trend Candidate** / Rejected counts
- Average Strategy Fit Score
- Mode brukt på aktiv run

---

## Out of scope (denne iterasjonen)
- Auto-promote til `symbols`
- Cron-scheduling
- Per-coin manuelle override-flagg
- Endring av Pine-strategien selv
- Cross-exchange likviditetssjekk

---

## Teknisk sjekkliste
1. Migrasjon: nye kolonner + reseed presets (med `trend_candidate_min_*` og `strategy_fit_*` felter).
2. `indicators.ts`: legg til Choppiness Index + pullback-helper hvis ikke finnes.
3. `trend-quality.ts`: ny modul + unit-vennlig signatur.
4. `scoring.ts`: hard/soft splitt + mode-bevisst status + reason-tekst.
5. `admission.server.ts`: 5m/15m kline-hentere.
6. `admission.functions.ts`: mode + trend integrasjon + nye DB-skrivinger.
7. `_app.admission.tsx`: mode toggle, nye filtre, nye kolonner, ny badge-farge, expanded view.
8. Verifisering: kjør Trend Adjusted med 150 symboler — forventet at antall Approved/Watchlist/Trend Candidate øker meningsfullt mens hard-kill rejections holder seg.
