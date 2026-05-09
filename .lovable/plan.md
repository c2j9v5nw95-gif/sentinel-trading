# Fix Bybit 403 / non-JSON execution failure

## Rotårsak

Når `api.bybit.com` returnerer **HTTP 403 med ikke-JSON body** (typisk Cloudflare/WAF som blokkerer Supabase Edge sin egress-IP/region før forespørselen treffer Bybit selv), klassifiserer `bybit-rest.ts` det som `bad_json:403` og kaster en generisk `BybitError(retCode: -1)`. Det skiller seg ikke fra "Bybit svarte med ødelagt JSON", så:

- meldingen som havner i `signals.decision_reason` er kryptisk
- vi får ingen Telegram-varsel
- vi mangler diagnostikk (`cf-ray`, `server`, `endpoint`, body-snippet)
- vi har ikke noe operatør-verktøy som tester nøyaktig samme mainnet-endepunkt som executor bruker
- base-URL er hardkodet — vi kan ikke bytte til alternativ Bybit-domene/proxy uten redeploy med kodeendring

Signalet ender allerede som `status='error'` (fail-fast fra forrige tur fungerer), så vi trenger ikke endre kø-logikken — bare gjøre feilen forståelig, varslet og enklere å omgå.

## Plan

### 1. Ny error-klasse: `BybitTransportError`
Egen klasse for transport-nivå feil (Cloudflare-block, ikke-JSON, network), separat fra `BybitError` (som er API-nivå med `retCode`).

```ts
// bybit-rest.ts
export class BybitTransportError extends Error {
  constructor(
    public kind: "forbidden" | "bad_json" | "network",
    public httpStatus: number,
    public endpoint: string,
    public diagnostics: {
      content_type?: string;
      cf_ray?: string;
      server?: string;
      request_id?: string;
      body_snippet?: string;
      base_url: string;
    }
  ) {
    super(`bybit_transport_${kind}:${httpStatus}:${endpoint}`);
  }
}
```

`request()` kaster denne i stedet for `BybitError` når:
- `res.status === 403` og body ikke parses som JSON → `kind: "forbidden"` (ikke retryable)
- annen status med ikke-JSON body → `kind: "bad_json"` (ikke retryable)

Begge logger fulle headers (`content-type`, `cf-ray`, `server`, `x-bapi-request-id`) + de første 500 tegnene av body.

### 2. Konfigurerbar base-URL
Les `BYBIT_API_BASE_URL` fra env i `live-client.ts`. Default: `https://api.bybit.com`. Lar operatør bytte til `api.bytick.com` (offisielt mirror) eller egen proxy uten redeploy.

```ts
const LIVE_BASE = Deno.env.get("BYBIT_API_BASE_URL") ?? "https://api.bybit.com";
```

Ny secret `BYBIT_API_BASE_URL` (valgfri) registreres via `add_secret` når brukeren godkjenner.

### 3. Dispatcher: håndter transport-feil eksplisitt
I `dispatcher.ts` catch-blokken: hvis `e instanceof BybitTransportError`, lag en strukturert `decision_reason` (`bybit_transport_forbidden:/v5/order/create`) og legg full diagnostikk i `error_log.context` + `system_alerts.context`. Status forblir `error` (allerede fail-fast).

### 4. Telegram critical alert
Send `severity: "critical"`, `category: "bybit_diagnostic_failure"` med:
- symbol, action, endpoint, http_status, cf_ray, server, body-snippet
- klar tekst som forklarer "Cloudflare/WAF/IP-block — dette er IKKE en API-key feil"

Bruker `notify(...)` som allerede finnes (fire-and-forget, deduper kritisk).

### 5. Operatør-diagnose for samme endpoint som executor
Utvid `op-test-bybit-connection` med en ny check: **`order_endpoint_reachability`** som gjør en *signed* `POST /v5/order/create` med ugyldig `qty=0` mot mainnet. Forventet utfall:
- 200 + `retCode != 0` → endpoint nådd, signering OK ✅ (Cloudflare slipper oss gjennom)
- `BybitTransportError(forbidden)` → bevist Cloudflare-block, viser cf-ray + server i UI ❌

Dette gir operatør et eksakt en-knapp svar på "blir vi blokkert akkurat nå?" mot samme URL som executor faktisk bruker.

### 6. UI-forklaring
I `BybitDiagnosticsPanel.tsx`: når en check feiler med `code: "bybit_transport_forbidden"`, vis en infoboks:

> **Cloudflare/WAF blokkerer forespørselen før den når Bybit.**
> Dette er ikke en API-nøkkel-feil. Mulige årsaker:
> - Lovable Cloud sin egress-IP står på Bybit/Cloudflare sin blokkliste
> - Geografisk region-restriksjon
> - WAF-regel utløst av rate eller header-mønster
>
> Tiltak: prøv `BYBIT_API_BASE_URL=https://api.bytick.com` eller sett opp en proxy. Diagnostikk: cf-ray=`<verdi>`, server=`<verdi>`.

Vise `cf_ray` / `server` / `body_snippet` fra `bybit_diagnostics.checks.order_endpoint_reachability.error.detail` så operatør kan eskalere til Bybit support med konkret bevis.

### 7. Signal-kortet i `_app.signals.tsx`
Når `decision_reason` starter med `bybit_transport_forbidden:`, vis et lite varsel med samme korte forklaring (egress/Cloudflare) og lenke til diagnose-panelet, i stedet for den rå strengen.

## Tekniske detaljer (filer)

- **`supabase/functions/_shared/bybit-rest.ts`**
  - Legg til `BybitTransportError` (eksportert)
  - I `request()`: detekter `res.status === 403` *før* JSON-parse → kast `BybitTransportError("forbidden", ...)`. Hvis JSON.parse feiler ellers → kast `BybitTransportError("bad_json", ...)`. Begge kastes umiddelbart (ingen retry — er ikke i `isRetryableHttpStatus`).
  - I catch-grenen: ikke retry på `BybitTransportError`.

- **`supabase/functions/_shared/live-client.ts`**
  - `LIVE_BASE = Deno.env.get("BYBIT_API_BASE_URL") ?? "https://api.bybit.com"`.
  - Ingen endring i klasse-strukturen.

- **`supabase/functions/_shared/dispatcher.ts`**
  - I catch-blokk: hvis `BybitTransportError`, bygg `decision_reason = "bybit_transport_${kind}:${endpoint}"`, fyll `error_log.context.diagnostics`, og kall `notify({severity:"critical", category:"bybit_diagnostic_failure", ...})`.

- **`supabase/functions/_shared/venue-client.ts`**
  - I `submitOrder` catch: re-kast `BybitTransportError` urørt så dispatcher fanger det med riktig type. Allerede dekket — bare verifisere at vi ikke wrapper det i `Error`.

- **`supabase/functions/op-test-bybit-connection/index.ts`**
  - Ny check `order_endpoint_reachability` (live-mode only).
  - I `explainBybitError`: håndter `BybitTransportError` separat → `code: "bybit_transport_forbidden"` med diagnostics.

- **`src/components/BybitDiagnosticsPanel.tsx`**
  - Render forklaring + diagnostics for `bybit_transport_forbidden`.

- **`src/routes/_app.signals.tsx`**
  - Friendly rendering for `decision_reason` som starter med `bybit_transport_*`.

## Hva som IKKE endres

- `MAX_ENTRY_SIGNAL_AGE_MS = 30s` (fail-fast fra forrige tur er riktig)
- Kø-håndtering / cron / pg_cron — separat sak (signaler blir korrekt `error`, ikke stuck)
- Ingen retry for transport-feil — vi ønsker rask, klar feiling

## Hva brukeren må bekrefte før implementasjon

1. **Skal jeg legge til `BYBIT_API_BASE_URL` som ny (valgfri) secret nå?** Hvis ja, jeg ber om verdien etterpå (default `https://api.bybit.com` brukes hvis ikke satt).
2. **Telegram critical alert**: nåværende `notify(...)` deduperer i 5 min. OK?
