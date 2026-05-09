## Rotårsak

Alle `ENTER-LONG`-signaler de siste timene (PENGUUSDT, LABUSDT) blir avvist med `exec_rejected:no_mark_price`. Mønsteret i DB er entydig:

- `payload.price = null` og `payload.close = null` på alle feilende signaler → TradingView-alertene sender ikke pris i bodyen.
- Executor faller derfor tilbake til `fetchLastPrice()` i `supabase/functions/_shared/bybit-public.ts`, som gjør et direkte `fetch("https://api.bybit.com/v5/market/tickers...")` fra Supabase edge runtime (eu-central-1).
- **Det er nøyaktig samme Bybit WAF-blokkering vi bygde bridgen for å løse** — bare for offentlige endepunkter denne gangen. Kallet returnerer enten 403 eller timeout, fallback gir `null`, og executor stopper på `entry_price_unavailable: no_mark_price` før noen ordre forsøkes.

PIEVERSEUSDT-raden i skjermbildet er vår egen dry-run (`kill_switch:entries_paused`) og er forventet — ikke en bug.

`EXIT-LONG`-avvisningene (`risk:no_open_position`) er en konsekvens: ingen entry har gått igjennom, så det finnes ingen posisjon å lukke når exit-alerten kommer. Fikser vi mark-price, forsvinner også den.

## Plan

### 1. Hovedfiks: rut offentlig markedsdata via bridge (server-side)
Legg en lettvekts public-data-klient inn i `bridge-rest.ts` (eller eksisterende `BridgeBybitRest`) som proxer:
- `GET /v5/market/tickers?category=linear&symbol=...`
- `GET /v5/market/instruments-info?category=linear&symbol=...`

Bridgen trenger ikke signere disse — den videresender bare GET-en fra sin egen IP (`46.225.180.1`), som Bybit ikke blokkerer. Endre `fetchLastPrice` og `fetchInstrumentRules` i `bybit-public.ts` til å gå via bridge når `app_settings.use_execution_bridge = true` og falle tilbake til direkte kall ellers (for paper/lokal utvikling). Logg `entry_price_source: bridge_public_ticker` i decision-trail.

### 2. Belt-and-suspenders: bruk pris fra TradingView når den finnes
Dokumenter (i `BridgeStatusPanel` eller eget hint i Signals-siden) at TradingView-alert message bør inkludere `price={{close}}` slik at executor slipper å spørre Bybit i det hele tatt. Dette er allerede støttet av parser — vi mangler bare avsender-konfigurasjon.

### 3. Forbedret feillogging
I dag taper `fetchLastPrice` HTTP-status og responskropp stille (`return null` på alle catch-grener). Legg inn én `error_log`-rad ved feil med `{symbol, http_status, error_kind, body_snippet}` slik at vi ikke trenger å gjette neste gang.

### 4. Verifisering
- Deploy bridge endring + edge-funksjoner.
- Send på nytt en LABUSDT ENTER-LONG (live, real ordre — krever bekreftelse) **eller** trigg én manuell `process-signal` på et eksisterende `no_mark_price`-signal etter å ha gjenåpnet det via `replay_signal()`. Forventet trail: `entry_price_fallback: bridge_public_ticker (price=…)` → `entry_sizing_ok` → `bridge_order_submit` → enten `filled` eller en _ordre-_relatert feil (ikke pris-relatert).

### Tekniske detaljer
**Filer som endres:**
- `supabase/functions/_shared/bridge-rest.ts` — ny `getPublicTicker(symbol)` / `getInstrumentRules(symbol)` som proxer GET via bridge.
- `supabase/functions/_shared/bybit-public.ts` — bytt rå `fetch` mot bridge-klient bak en `useBridge`-flag, behold direkte kall som fallback. Legg inn `error_log`-rad ved feil.
- `supabase/functions/_shared/executor.ts` — send `useBridge` videre til `fetchLastPrice` / `fetchInstrumentRules` (samme flag som allerede plumbes inn til `BridgeBybitRest`).
- Bridge-VPS (utenfor dette prosjektet): trenger en publisert `GET /public/v5/market/...`-rute som videresender forespørselen uten signering. **Avhengighet** — denne må verifiseres / legges til på VPS-siden før edge-koden virker.

**Database/migrasjoner:** ingen.
**Hemmeligheter:** ingen nye.
**Risiko:** lav — bare lese-trafikk gjennom bridge, ingen ordreflyt endres.

## Avhengigheter / spørsmål til deg

1. Har bridge-VPS-en allerede en passthrough-rute for `/v5/market/*`, eller må vi legge den til? (Avgjør om vi kan lande fiksen helt i Lovable, eller om VPS må oppdateres parallelt.)
2. Vil du at jeg skal **fikse koden nå (uten ekte ordre-test)** og la neste live-alert fra TradingView være verifisering, eller vil du at jeg etterpå sender en manuell ENTER-LONG på et live-symbol for å bekrefte hele bridge-løypa?