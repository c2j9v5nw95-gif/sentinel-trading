
## Phase 2A — Manual analytics writers (approved scope)

Bygger snapshot-skriverne som **kun kan kjøres manuelt** via HTTP. Ingen DB-trigger, ingen pg_cron, ingen endring i execution/dispatcher/risk/sizing/bridge-signering. 2B (auto trigger på `signals`) og 2C (cron) kommer som separate planer etter validering.

## Leveranse

Nye filer (ingen DB-migrations, ingen endring i eksisterende kode):

| Fil | Ansvar |
|---|---|
| `src/lib/analytics/bybit-public-kline.ts` | Whitelistet bridge-passthrough fetcher → `Bar[]` |
| `src/lib/analytics/indicators.ts` | `ema`, `rsi(14)`, `atr(14)`, `adx(14)`, `candleRangePct`, `relVolume(20)` |
| `src/lib/analytics/regime.ts` | Klassifisering → `regime_class` |
| `src/lib/analytics/timeframe.ts` | TF-parsing + Bybit `interval`-mapping (`5m→5`, `1h→60`, `4h→240`, `1d→D`) |
| `src/lib/analytics/run-logger.ts` | Wrapper rundt `analytics_snapshot_runs` |
| `src/lib/analytics/snapshot-signal-context.server.ts` | Kjernen for signal-context writeren |
| `src/lib/analytics/snapshot-regime.server.ts` | Kjernen for regime writeren |
| `src/routes/api/public/hooks/snapshot-signal-context.ts` | HTTP-route (POST) |
| `src/routes/api/public/hooks/snapshot-regime-tick.ts` | HTTP-route (POST) |

## Bridge-tilgang — strikt public-only

Per ekstra-betingelse: analytics-laget får **kun** lov til disse to public endpoints via bridge:

```ts
// src/lib/analytics/bybit-public-kline.ts
const ANALYTICS_PUBLIC_ENDPOINTS = [
  '/v5/market/kline',
  '/v5/market/tickers',
] as const;
```

Funksjonen avviser hardt enhver annen endpoint og enhver method ≠ GET — også internt, før vi i det hele tatt kaller bridge. Dette gjelder analytics-laget; bridge sin egen `ALLOWED_ENDPOINTS` (i `bridge/src/server.js`) endres **ikke** i 2A. Vi ekspanderer aldri bridge-allowlisten til noen private/order/position-endepunkter som del av analytics-arbeid.

Ingen import fra: `live-client`, `paper-client`, `testnet-client`, `dispatcher`, `executor`, `risk-engine`, `sizing`, `bybit-rest`, `bybit-requests`, `bridge-rest` (signering), `locks`, `trail`, `reconcile`, `recovery`. Bridge-secret brukes bare til å autentisere mot bridge-VPS.

## Endpoint 1 — `POST /api/public/hooks/snapshot-signal-context`

**Body (Zod):** `{ signal_id: string }`
**Auth:** `apikey`-header må matche `SUPABASE_ANON_KEY`.

**Flyt:**
1. Hent `signals`-rad. 404 hvis ikke finnes.
2. Drop meta-signaler → `{ ok:true, skipped:'meta_signal', rows_written:0, api_calls:0, errors:[], dry_run:false }`.
3. Resolv `trade_timeframe`: `signals.payload.timeframe` → `payload.interval` → `null` (skriver én rad med `payload.reason='no_timeframe'`).
4. Resolv `environment`: siste `orders.execution_mode` for signalet → fallback `app_settings` → `'paper'`.
5. Hent context-TFs fra `analytics_tf_context_map WHERE trade_timeframe=$1 AND enabled=true ORDER BY priority`.
6. `Promise.allSettled` på maks 4 kline-kall (1 trade-TF × 200 bars + opptil 3 context-TFs × 100 bars).
7. Bygg payloads:
   - `tf_role='trade'`: atr, atr_pct, candle_range_pct, ema20/50/200, ema_slope_pct, dist_from_ema50_pct, rsi14, adx14, volume, rel_volume_20.
   - `tf_role='context'`: ema_slope_pct, adx14, atr_pct, rel_volume_20, dist_from_ema50_pct.
8. `INSERT ... ON CONFLICT (signal_id, timeframe) DO NOTHING`. Per-TF feil → rad med `payload.error`.
9. Respons (alltid 200, aldri 5xx for del-feil):
   ```json
   {
     "ok": true,
     "signal_id": "...",
     "trade_timeframe": "5m",
     "environment": "paper",
     "rows_written": 4,
     "api_calls": 4,
     "errors": [],
     "dry_run": false
   }
   ```

## Endpoint 2 — `POST /api/public/hooks/snapshot-regime-tick`

**Body (Zod):**
```ts
{
  schedule: 'trade' | 'context' | 'manual',
  symbols?: string[],     // override
  timeframes?: string[],  // override (kreves for 'manual')
  dry_run?: boolean       // beregn men ikke skriv
}
```
**Auth:** samme `apikey`-sjekk.

**TF-sett per schedule:** `trade` → `['5m','15m','30m']`; `context` → `['1h','4h','1d']`; `manual` → må sende `timeframes`.

**Flyt:**
1. Åpne `analytics_snapshot_runs`-rad (`writer='regime'`).
2. Univers: override hvis gitt, ellers `symbols WHERE enabled = true`. Hard cap 30 symboler — over → 400 med `{error:'universe_too_large'}`.
3. Concurrency-pool: maks 5 parallelle fetches, 50 ms throttle mellom batcher.
4. Per `(symbol, tf)`: hent 100 bars via bridge-passthrough, beregn lett payload + `regime_class`, INSERT i `regime_snapshots` (skip insert hvis `dry_run`).
5. Akkumuler `symbols_processed`, `rows_written`, `api_calls`, `errors[]`.
6. Lukk run-rad: `finished_at=now()`, `ok = errors.length === 0`.
7. Respons:
   ```json
   {
     "ok": true,
     "run_id": "...",
     "schedule": "trade",
     "dry_run": false,
     "symbols_processed": 12,
     "rows_written": 36,
     "api_calls": 36,
     "errors": []
   }
   ```

## Standardisert respons-kontrakt (begge endpoints)

Alle analytics-endpoint-svar inneholder eksplisitt:
- `rows_written` (number)
- `api_calls` (number)
- `errors[]` (array; `[]` ved suksess; per-item `{ symbol?, timeframe?, http_status?, error_kind, via:'bridge' }`)
- `dry_run` (boolean)

Også når `ok=false` — feltene er aldri utelatt.

## `regime_class`-regler

| Klasse | Betingelse |
|---|---|
| `volatile_expansion` | `atr_pct` > p80 av siste 100 bars **og** `candle_range_pct` > median × 1.5 |
| `volatile_compression` | `atr_pct` < p20 av siste 100 bars |
| `trending_up` | `adx14 ≥ 25` **og** `ema20 > ema50 > ema200` **og** `ema_slope_pct > 0` |
| `trending_down` | `adx14 ≥ 25` **og** `ema20 < ema50 < ema200` **og** `ema_slope_pct < 0` |
| `ranging` | ellers |

## API-budsjett

- Signal-context: maks 4 kall per invocation.
- Regime trade-tick (30 symboler): 90 kall. Context-tick: 90 kall. Bybit public limit ~120 req/s → trygt.

## Manuell test (etter deploy)

```bash
curl -X POST https://<app>/api/public/hooks/snapshot-signal-context \
  -H "Content-Type: application/json" -H "apikey: <anon>" \
  -d '{"signal_id":"<uuid>"}'

curl -X POST https://<app>/api/public/hooks/snapshot-regime-tick \
  -H "Content-Type: application/json" -H "apikey: <anon>" \
  -d '{"schedule":"manual","symbols":["BTCUSDT","ETHUSDT"],"timeframes":["1h"],"dry_run":true}'
```

Validering før vi går til 2B/2C:
- Bridge-passthrough returnerer kline uten WAF-block.
- Indikator-verdier matcher TradingView (spot-sjekk 2–3 symboler).
- `regime_class` ser fornuftig ut.
- `analytics_snapshot_runs` lukker korrekt.
- Ingen påvirkning på `signals`/`orders`/`positions`.

## Hva som IKKE endres

- `bridge/src/server.js` ALLOWED_ENDPOINTS — uendret.
- `signals`-tabell, triggere, RLS — uendret.
- Dispatcher, executor, bridge-signering, risk, sizing, locks, trail, reconcile, recovery, paper/testnet/live-clients — uendret.
- Eksisterende edge functions, UI, øvrige routes — uendret.
- Ingen pg_cron, ingen pg_net, ingen DB-trigger.

## Senere faser (separate planer)

- **2B:** AFTER INSERT-trigger på `signals` → `pg_net.http_post` til signal-context endpointet.
- **2C:** `cron.schedule()` for trade-tick + context-tick + retention-cron for `regime_snapshots`.
