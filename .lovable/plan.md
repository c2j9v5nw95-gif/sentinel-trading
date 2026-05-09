## Mål

HEALTH-alerts fra TradingView skal:
1. Bli lagret som `signals`-rader (ikke kastes pga. timestamptz-parsefeil).
2. Generere fullverdige `health_snapshots`-rader med `net_profit`, `winrate`, `profit_factor`.

## Endringer

### 1. `supabase/functions/_shared/parser.ts`

**a) Tolerere `|` som ekstra separator** (TradingView limer ofte alert-message + studie-output med `|`):
- Utvid splitten i `parseKvText` fra `/[;\n\r]+/` til `/[;\n\r|]+/` slik at `trigger=HEARTBEAT; | netProfit=...` deles riktig og `netProfit` overlever.

**b) Konvertere epoch-ms barTime til ISO**:
- I `fromObject`, hvis `o.barTime` er en ren tall-streng (epoch ms), konverter til `new Date(Number(...)).toISOString()`. Behold støtte for ISO-strenger (slik trade-alertene allerede sender).
- Dette gjør `signals.bar_time` (timestamptz) glad.

### 2. `supabase/functions/_shared/dispatcher.ts`

**a) `recordHealth` skal lese både camelCase og snake_case nøkler fra payload**:
- `num(payload.net_profit ?? payload.netProfit)`
- `num(payload.winrate)`
- `num(payload.profit_factor ?? payload.profitFactor)`

Det parseren legger inn i `signals.payload` er rå-objektet (`raw`), som beholder TradingView-keysene som `netProfit` osv. Dispatcheren må matche.

### 3. Backfill (valgfritt, anbefalt)

Slette de 4 gamle test-`signals`-radene + 1 gamle `health_snapshot` (BTCUSDT/sim) for å starte rent — eller la dem ligge for historikk. Spør brukeren.

## Verifikasjon etter fix

1. Vent på neste HEARTBEAT (kommer hvert ~3s fra TV).
2. Sjekk `signals` for `type='stats'`, `symbol='PENGUUSDT'` → skal eksistere med status `processed`.
3. Sjekk `health_snapshots` → skal ha rader med `net_profit`, `winrate`, `profit_factor` populert (ikke null).
4. Sjekk `/strategies`-siden — `HEALTH_ALL` skal dukke opp med `last_health_at` ferskt.

## Tekniske notater

- Endringene er bakoverkompatible: trade-alerts (som ikke inneholder `|` og bruker ISO `barTime`) er upåvirket.
- Ingen DB-skjemaendring kreves.
- Ingen UI-endring kreves; eksisterende `/signals` og strategi-views vil automatisk vise dataene.
