# Plan: balance_snapshots + isolert snapshot-service

Strengt read-only analytics-lag. Ingen endringer i dispatcher, bridge, executor, risk engine, sizing, signal-handling eller execution clients.

## 1. Ny tabell: `balance_snapshots`

Read-only fra UI-perspektiv. Skrives kun av snapshot-edge-funksjonen.

Kolonner:
- `id uuid pk`
- `source text` — `'paper'` eller `'live'`
- `captured_at timestamptz default now()` (indeksert)
- `total_equity numeric` — total konto-equity i USDT
- `available_balance numeric` — fri saldo
- `unrealized_pnl numeric`
- `realized_pnl numeric` (kun paper; null for live)
- `used_margin numeric`
- `account_mode text` — f.eks. `unified:3` eller `paper`
- `raw jsonb` — full respons (debug / fremtidige metrics)
- `error text` — populeres hvis snapshot feilet (vi lagrer rad uansett for monitoring)

Indekser: `(source, captured_at desc)`.

RLS: kun `operator` kan lese. Ingen insert/update/delete-policy → kun service-role (cron + edge function) kan skrive. Mønster identisk med `bridge_health_checks` / `bridge_smoke_tests`.

## 2. Ny edge function: `analytics-snapshot-balances`

**Helt separat fra execution-stacken.** Importerer ikke fra `_shared/dispatcher.ts`, `_shared/executor.ts`, `_shared/live-client.ts`, `_shared/venue-client.ts`, `_shared/locks.ts`, `_shared/risk-engine.ts` eller `_shared/sizing*`.

Tillatte imports:
- `_shared/db.ts` (kun `serviceClient`)
- `_shared/bybit-rest.ts` (read-only signer; brukes allerede av `op-live-wallet` og `op-test-bybit-connection`)

Logikk:
1. Les `paper_wallet` (singleton-rad). Skriv én rad med `source='paper'`.
2. Les `app_settings.live_enabled`. Hvis true OG `BYBIT_LIVE_API_KEY` + `BYBIT_LIVE_API_SECRET` finnes:
   - Kall `/v5/account/info` og `/v5/account/wallet-balance` (samme kall som `op-live-wallet`).
   - Skriv én rad med `source='live'`.
3. Ved feil: logg en rad med `error` satt, `total_equity=null`. Funksjonen returnerer alltid 200 så cron ikke kverner retries.

Konservativ: ingen ordre-API, ingen position-API, ingen mutasjoner mot Bybit. Kun GET wallet-endpoints.

`supabase/config.toml`: `verify_jwt = false` for funksjonen siden den kalles av cron uten JWT.

## 3. pg_cron: hvert 5. minutt

Via supabase--insert (ikke migrasjon, siden URL/anon-key er prosjektspesifikk):

```sql
select cron.schedule(
  'analytics-snapshot-balances-5min',
  '*/5 * * * *',
  $$ select net.http_post(
       url:='https://djqhpgbsgelzhrfyxfhl.supabase.co/functions/v1/analytics-snapshot-balances',
       headers:='{"Content-Type":"application/json","apikey":"<anon>"}'::jsonb,
       body:='{}'::jsonb
     ) $$
);
```

Ekstensjoner `pg_cron` og `pg_net` aktiveres hvis ikke allerede på.

## 4. UI: ingen endringer i denne runden

Tabellen begynner å samle data umiddelbart. Equity curve / drawdown-grafer kobles på når vi bygger den nye Overview/Analytics-siden i neste runde — da har vi historikk å vise fra dag 1.

## Garantier

- Ingen filer i `_shared/dispatcher.ts`, `_shared/executor.ts`, `_shared/live-client.ts`, `_shared/risk-engine.ts`, `_shared/sizing*`, `_shared/locks.ts`, `_shared/bridge-rest.ts`, eller noen `execute-*` / `process-signal` / `protection-monitor` / `bybit-reconcile` / `bybit-recovery` funksjon røres.
- Snapshot-funksjonen er en isolert leser. Den deler kun den lavnivå HMAC-signeren (`bybit-rest.ts`) som allerede brukes av andre read-only diagnose-endepunkter.
- 5-minutters cadence → ~288 rader/dag/source. Ubetydelig DB-belastning. Ingen rate-limit-risiko mot Bybit (read-endpoints, ett kall hvert 5. min).
- Feil i snapshot påvirker ikke trading: cron logger til `cron.job_run_details`, funksjonen returnerer 200, raden får `error`-felt satt for synlighet.

## Tekniske detaljer (utvikler)

Filer som opprettes:
- migration: `create table public.balance_snapshots ...` + RLS
- `supabase/functions/analytics-snapshot-balances/index.ts`
- `supabase/config.toml`: legge til block for ny funksjon med `verify_jwt = false`
- supabase--insert: `cron.schedule(...)` + `create extension if not exists pg_cron; create extension if not exists pg_net;`

Ingen klient-kode eller trading-relaterte filer endres.
