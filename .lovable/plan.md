## Bridge smoke test — wallet-balance via VPS

### Mål
Verifiser end-to-end at en signert Bybit-call gjennom bridge-VPS fungerer, og vis HTTP-status + latency-målinger i en tydelig statusboks i Settings → Bridge Status.

### Hva som mangler i dag
`op-live-wallet` og `op-test-bybit-connection` bruker `BybitRest` **direkte** fra Supabase Edge (CloudFront-egress) — ikke via bridge. Det finnes ingen endepunkt som beviser at bridge-ruten faktisk leverer en signert Bybit-respons.

### Endringer

**1. Ny edge-funksjon: `op-bridge-smoke`**
- JWT + operator-rolle.
- Bruker `BridgeBybitRest` (samme `bridge-rest.ts` som executor vil bruke).
- Kaller `GET /v5/account/wallet-balance?accountType=UNIFIED` (faller tilbake til `CONTRACT`).
- Måler:
  - Total round-trip ms (Supabase → bridge → Bybit → bridge → Supabase)
  - Bridge-rapportert Bybit-latency (fra `trace.duration_ms`)
  - HTTP-status fra bridge og fra Bybit
  - `cf_ray`, `bapi_request_id`, `public_ip`-bekreftelse
- Skriver en rad til `bridge_health_checks` (eller en ny `bridge_smoke_tests`-tabell hvis vi vil holde dem adskilt — anbefalt: ny tabell for å unngå støy i health-grafen).
- Returnerer `{ ok, total_ms, bybit_ms, http_status, ret_code, ret_msg, public_ip, account_summary: { total_equity, available, coins_count }, trace }`.

**2. Ny tabell: `bridge_smoke_tests`** (migrasjon)
Kolonner: `id`, `checked_at`, `ok`, `total_ms`, `bybit_ms`, `http_status`, `ret_code`, `ret_msg`, `public_ip`, `account_equity`, `account_available`, `error`, `raw jsonb`. RLS: kun operator kan lese/skrive (via service_role i edge).

**3. UI: utvid `BridgeStatusPanel`**
Legg til en ny seksjon **"Smoke test (wallet-balance)"** under den eksisterende health-boksen:
- Knapp: **"Run smoke test"** (disabled hvis siste health-check er failed).
- Resultatboks med samme stil som health-statene:
  - Status (Pass/Fail) — grønn/rød chip
  - Total latency (ms)
  - Bybit latency (ms) — fra bridge-trace
  - HTTP-status
  - Bybit retCode + retMsg
  - Konto-equity (USDT)
  - Public IP-bekreftelse (skal matche `46.225.180.1`)
- Hvis fail: vis full feilmelding + `body_snippet` i en "Details"-seksjon.
- Liten historikk-stripe (siste 10 smoke tests).

### Sikkerhet / invariants
- Read-only call — ingen ordreplassering.
- Fortsatt bak operator-rolle.
- Bruker eksisterende `EXECUTION_BRIDGE_URL` + `EXECUTION_BRIDGE_SECRET` (allerede satt).
- Idempotency ikke nødvendig (GET).

### Acceptance
- Klikk "Run smoke test" på `/settings` → grønn boks med:
  - `ok: true`, `http_status: 200`, `ret_code: 0`
  - `public_ip: 46.225.180.1`
  - `total_ms` ~250–600, `bybit_ms` ~150–300
  - Konto-equity-tall vises
- Rad lagret i `bridge_smoke_tests` og synlig i historikk-stripen.

### Etter dette
Med både health (200) og smoke test (Bybit retCode 0) grønne kan vi trygt aktivere bridge-mode for live execution.
