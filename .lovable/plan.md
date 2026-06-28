## Mål

En **Coin Admission Screener** under `/admission` (eget menyvalg, ikke å forveksle med eksisterende Screener). Den vurderer Bybit USDT linear perpetuals for *robusthet* — ikke for trading-edge — og produserer en plukkliste (Approved / Watchlist / Rejected) som operatør manuelt promoterer inn i `symbols`-tabellen.

Strikt regel: siden er **read-only mot tradingen**. Den endrer ikke `symbols`, sizing, execution, dispatcher, risk engine eller noe i kjøretiden. Den lever side om side med eksisterende analytics-snapshot-systemet.

## Datakilder

1. **Bybit** (via eksisterende `publicGet` i `src/lib/analytics/bybit-public-kline.ts`, routet gjennom bridge):
   - `/v5/market/instruments-info` — universet, status, launchTime (alder), tick/lot
   - `/v5/market/tickers` — 24h turnover, lastPrice, openInterest, openInterestValue, fundingRate, bid/ask (spread)
   - `/v5/market/kline` — 30d daglige + 7d 1h candles for wick/volatility-analyse
   - `/v5/market/orderbook` (må legges til whitelist i `bridge/src/server.js` og `ANALYTICS_PUBLIC_ENDPOINTS`) — for slippage-simulering på topp 25 levels
2. **CoinGecko free API** (`/coins/markets`, ingen nøkkel) — market cap rank. Symbol-mapping: vi bygger en lookup-tabell `coingecko_id ↔ bybit_symbol` (BTCUSDT→bitcoin osv.) som lagres i ny tabell. Ukjente symboler får `rank = null` og scores uten rank-komponenten.

**Samsvar Bybit ↔ CoinGecko**: vi henter alltid Bybit-tall som primær (det er der vi handler). CoinGecko brukes *bare* til market cap/rank. Pris/volum/likviditet i scoring er 100 % fra Bybit perp-kontrakten.

## Datamodell (nye tabeller)

```sql
-- Mapping Bybit perp symbol → CoinGecko ID
coin_admission_coingecko_map (
  bybit_symbol text primary key,    -- 'BTCUSDT'
  coingecko_id text not null,        -- 'bitcoin'
  notes text, updated_at timestamptz
)

-- Konfig (presets + aktiv profil)
coin_admission_profiles (
  id uuid pk, name text unique,      -- 'conservative' | 'aggressive'
  thresholds jsonb,                  -- alle min/max-verdier
  weights jsonb,                     -- score-vekter
  is_active boolean
)

-- Hver kjøring
coin_admission_runs (
  id uuid pk, started_at, finished_at,
  profile_id, triggered_by uuid,
  status text,                       -- running|completed|failed
  symbols_total int, approved_n int, watchlist_n int, rejected_n int,
  error text
)

-- Per-symbol resultat per kjøring
coin_admission_results (
  id uuid pk, run_id uuid fk,
  symbol text, status text,          -- approved|watchlist|rejected
  score numeric,                     -- 0..100
  rank int,
  turnover_24h numeric, turnover_7d_median numeric, turnover_30d_median numeric,
  open_interest_value numeric,
  spread_bps numeric,
  slippage_bps_est numeric,
  listing_age_days int,
  funding_rate numeric,
  max_1h_drop_pct numeric,
  wick_risk_score numeric,
  extreme_wick_count int,
  components jsonb,                  -- alle delscorer
  kill_rules_triggered text[],
  unique(run_id, symbol)
)
```

RLS: kun `operator` kan lese/skrive. Service role for cron-fri kjøring senere.

## Scoring (begge presets)

Robustness Score 0–100, vektet:
- Market cap rank 25 %, Bybit turnover (24h+7d median) 20 %, OI 15 %, orderbook depth/slippage 15 %, listing age 10 %, wick/volatility 10 %, funding-normalitet 5 %

**Kill rules** (override → Rejected uansett score):
- listing_age < min_days
- rank > max_rank (om rank finnes)
- 7d median turnover < min
- spread > max
- ekstrem 1h move > 25 % siste 30d (konservativ) / 35 % (aggressiv)
- funding |rate| > terskel

**Presets** (eksakt slik du foreslo):
- **Konservativ**: rank ≤100, 24h ≥100M, 7d med ≥50M, OI ≥50M, age ≥60d, spread ≤3bps, slipp ≤5bps
- **Aggressiv**: rank ≤200, 24h ≥50M, 7d med ≥25M, OI ≥20M, age ≥30d, spread ≤5bps, slipp ≤10bps

Buckets: ≥80 Approved, 65–79 Watchlist, <65 Rejected.

## Backend (server functions, ingen edge functions)

`src/lib/admission/admission.functions.ts`:
- `listAdmissionRuns()` — siste 20 kjøringer
- `getAdmissionRunDetail({ runId })` — alle resultater for en kjøring
- `getAdmissionProfiles()` / `updateAdmissionProfile()` (bare for senere; first cut bruker fastsatte presets)
- `startAdmissionRun({ profile })` — oppretter run-rad, returnerer runId, og kjører i bakgrunnen
- `getAdmissionMappingNeedsReview()` — symboler vi ikke har coingecko_id for

`src/lib/admission/admission.server.ts` (server-only helpers):
- `fetchUniverse()` — instruments-info, paginert med cursor, filtrerer `status=Trading`, `LinearPerpetual`, `USDT`-quote
- `fetchTickers()` — én bulk-call
- `fetchCandles(symbol)` — 30d daily + 7d hourly
- `fetchOrderbook(symbol)` — top 25, simuler slippage for "vår typiske ordrestørrelse" (konfig i profil, default 5000 USDT notional)
- `fetchCoinGeckoMarketData()` — én call, top 250, cache 6h i `coin_admission_coingecko_map`-relatert cache-tabell eller in-memory
- `computeScore(symbol, metrics, profile)` — ren funksjon, lett å teste
- `runAdmissionScreener(runId, profile)` — orkestrering med batching (10 parallelle symbol-fetches), error-isolering per symbol, progress-updates på `coin_admission_runs`

Run forventet å ta 2–5 min for ~500 symboler. UI viser progress via polling (`getAdmissionRunDetail` hver 3s mens `status=running`).

**Sikkerhet/isolasjon**: nye filer ligger under `src/lib/admission/` — ingen import av execution/dispatcher/sizing/risk-engine. Bridge-whitelist utvides med `/v5/market/orderbook` i `bridge/src/server.js` + `bybit-public-kline.ts`.

## UI

Ny rute: `src/routes/_app.admission.tsx`, ny sidebar-lenke "Admission" i `AppLayout`.

Layout:
- **Header**: tittel, "Run screener"-knapp med profile-velger (Konservativ/Aggressiv), siste run-tidsstempel
- **Summary cards**: Approved / Watchlist / Rejected count, universe size, run duration
- **Filterbar**: status (all/approved/watchlist/rejected), søk symbol, sortering på score/rank/turnover/age
- **Resultat-tabell**: kolonner som i ditt eksempel — Symbol, Status (badge), Score, Rank, 24h TO, 7d med TO, OI, Spread, Wick Risk, Age, Kommentar (kill rules + score-breakdown i tooltip/expandable row)
- **Empty state**: "Ingen kjøringer ennå — trykk Run screener"
- **Run history**: liten dropdown for å laste tidligere kjøringer (sammenligning kommer senere)
- CSV-eksport av visning

Ingen "promote to symbols"-knapp i first cut. Operatør kopierer symbol manuelt inn i eksisterende Symbols-side.

## Migrasjoner

1. `coin_admission_coingecko_map`, `coin_admission_profiles`, `coin_admission_runs`, `coin_admission_results` med GRANTs og RLS (operator-only)
2. Seed `coin_admission_profiles` med Konservativ + Aggressiv presets
3. Seed `coin_admission_coingecko_map` med top 50 vanlige (BTC, ETH, SOL, …) — resten fylles opp etter første run

## Out of scope (denne iterasjonen)

- Auto-promote til `symbols`-tabellen
- Cron-scheduling (kun on-demand fra UI)
- Diff/sammenligning mellom runs
- Konfigurerbare vekter i UI (bruker hardkodete presets nå)
- Cross-exchange listing-sjekk (Binance/OKX/Coinbase)
