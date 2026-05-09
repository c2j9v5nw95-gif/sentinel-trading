## Mål

Få LABUSDT-signalene gjennom risk-gaten og handlet på Bybit, og ha en tydelig prosess for å legge til nye tickere etter hvert som du aktiverer flere strategier i TradingView.

## Hvorfor signalene blir avvist nå

Signalsporet for LABUSDT viser:

```
parser_pass → normalized_symbol (LABUSDT.P → LABUSDT) → dedupe_pass
→ kill_switch pass → strategy_code pass
→ symbol FAIL: not_configured  →  rejected
```

Risk-engine slår opp `symbols.symbol = 'LABUSDT'` og finner ingen rad. Kun PENGUUSDT ligger i tabellen i dag. Dette er en bevisst sikkerhetsmekanisme: ukjente symboler får aldri lov til å sende ordre. Løsningen er å registrere LABUSDT (og andre tickere du vil handle) eksplisitt med egne innstillinger.

## Plan

### 1. Legg LABUSDT inn i symbols-tabellen

Opprett en rad med samme grunnoppsett som PENGUUSDT så den nye tickeren oppfører seg likt fra første signal:

- `symbol` = `LABUSDT`, `category` = `linear`, `enabled` = true
- `preferred_transport` = `webhook`
- `execution_mode_override` = `live`
- `account_balance_percent` = 5, `leverage` = 10, `margin_mode` = `isolated`
- `sl_pct` = 5
- `tsl_enabled` = true, `tsl_activation_profit_pct` = 1.0, `tsl_callback_pct` = 0.5
- `tp1_exit_percent` = 100, `tp2_enabled` = false

Disse verdiene kan justeres per symbol senere fra Symbols-siden — du har allerede UI for det.

### 2. Verifisere ende-til-ende

- Ny ENTER-SHORT på LABUSDT.P fra TradingView → dispatcher kjører:
  `symbol pass → unprotected_pause → concurrency → live_gate_passed → executeEntry`
- Ordre sendes til Bybit (`/v5/order/create`, Market IOC), SL armes (`/v5/position/trading-stop`).
- TSL armes av `protection-monitor` når urealisert profit ≥ 1 %.
- EXIT-signaler (XS1/XS2/XS3/XS5) kobles til åpen LABUSDT-short via `position_check`.

Sjekkes ved å replay'e en av de eksisterende rejected LABUSDT-signalene fra Signals-siden, eller ved å vente på neste live alert.

### 3. Rutine for nye tickere

Ettersom du sa du vil ha mange symboler aktive samtidig:

- For hvert nytt symbol du aktiverer i TradingView, opprett en rad i Symbols-siden FØR første alert sendes. Dette er det eneste manuelle steget.
- Standardverdiene i `symbols`-tabellen (5 % balanse, x10 leverage, 1.5 % SL, TSL aktivering 1 %, callback 0.5 %) er fornuftige defaults; juster per symbol ved behov.
- TradingView-ticker-suffiks `.P` normaliseres allerede (`LABUSDT.P → LABUSDT`), så alerten trenger ingen endring så lenge du har aktivert symbolet i basisform i tabellen.
- Strategy-tag (`STRAT2` osv.) påvirker ikke registreringen; samme symbol-rad brukes på tvers av strategier. Per-strategi-overstyringer (size, leverage) ligger i `symbol_strategy_overrides` om du trenger finjustering.

### Hvorfor jeg ikke foreslår auto-registrering

Et alternativ ville vært å autoopprette nye symboler første gang en alert kommer inn. Det fraråder jeg for live-handel: en feiltastet ticker fra TradingView ville da blitt akseptert med default leverage og balansebruk og kunne sende en uønsket ordre. Den nåværende "explicit allowlist"-tilnærmingen er en viktig sikkerhetslinje.

## Tekniske detaljer

- Endring: én INSERT i `public.symbols` for `LABUSDT` (dette er en data-endring, ikke skjema). Ingen kodeendring nødvendig — risk-engine, dispatcher, executor og protection-monitor leser allerede `symbols` per ticker.
- Ingen edge-funksjoner trenger å redeployes.
- De fire eksisterende rejected LABUSDT-signalene forblir rejected (det er korrekt revisjonshistorikk). Du kan replay'e dem fra Signals-siden hvis du faktisk vil at de skal handles nå — vær obs på at ENTER-SHORT etterfulgt av EXIT-SHORT fra 4–7 minutter siden trolig ikke gir mening på dagens marked.
