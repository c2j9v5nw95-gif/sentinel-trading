
## Problem

Live ENTER-signaler blir avvist med `exec_rejected:instrument_rules_unavailable:qty_step_missing` for symboler der bridge ikke har cachet instrument-reglene (sett på `BSBUSDT`, også `ZECUSDT`).

`error_log` viser at:
- Bridge svarer `403 endpoint_not_whitelisted` for `/v5/market/instruments-info`
- Direkte fallback fra edge-runtime treffer Bybit CloudFront og får `403` (geo-blokk)

Resultatet er at `executor.ts` (linje 218) gjør riktig fail-closed: uten `qtyStep` ville Bybit avvise ordren med retCode 10001, så signalet stoppes pre-submit. Koden i executor er korrekt — det er bridge-allowlisten som er mangelfull.

`bridge/src/server.js` `ALLOWED_ENDPOINTS` inneholder kun `/v5/market/kline` og `/v5/market/tickers` for public data. `/v5/market/instruments-info` brukes av `fetchInstrumentRules` men er aldri whitelistet.

## Endring

**Én linje** i `bridge/src/server.js`, i `ALLOWED_ENDPOINTS`-settet:

```js
"/v5/market/kline",
"/v5/market/tickers",
"/v5/market/instruments-info",   // <— legg til
```

`fetchInstrumentRules` i `supabase/functions/_shared/bybit-public.ts` kaller allerede denne endpointen via bridgen når `useBridge=true`, så ingen edge-side-endring trengs. Endepunktet er public/read-only, ingen signering — samme klasse som `kline`/`tickers`.

## Out of scope

- Ingen endringer i `executor.ts`, signal-prosessering, Phase 2B-trigger, snapshot-pipeline, risk-engine, dispatcher eller replay.
- Ingen DB-migrasjoner.
- Ingen retry-logikk eller cache-prewarm i edge-koden — vil være separate forbedringer hvis vi senere vil tåle bridge-nedetid.
- Direct-fallback (CloudFront 403) fikses ikke — bridge er den autoritative pathen i live, og det er forventet at edge-IP er geo-blokket.

## Deploy / verifikasjon

1. Operatøren deployer bridge på VPS (npm restart eller tilsvarende — bridge-prosessen kjører utenfor Lovable).
2. Bekreft `/v1/health` svarer `bybit_reachable: true`.
3. `sim-inject` en ENTER-LONG på `BSBUSDT` i live, eller vent på neste TradingView-alarm; trail skal nå vise `instrument_rules` (info) i stedet for `entry_blocked_no_qty_step`.
4. Sjekk at `error_log` ikke får nye `bridge_http_403` for `instruments-info`.

## Hvorfor ikke noe mer

Vi har én konkret feilmodus: én public endpoint manglet i allowlisten. Å utvide scope (retry, prewarm, alternativ datakilde) ville endre executor-pathen, og det ligger utenfor det du har bedt om — og utenfor de stående reglene om å ikke røre execution-pipen for ikke-relaterte oppgaver.
