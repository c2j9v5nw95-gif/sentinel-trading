## Mål

Endre "i dag"-grensen i de to kortene som i dag bruker UTC-midnatt, slik at de speiler din lokale dag (Europe/Oslo). Alt annet rører jeg ikke — individuelle tidsstempler vises allerede i din nettlesertid (Oslo), DB lagrer fortsatt UTC, og TradingView-embeddingen lar jeg stå.

## Hva endres

### 1. `src/components/overview/RealizedPnLTodayCard.tsx`
- Erstatt `start.setUTCHours(0,0,0,0)` med et helper-kall som returnerer ISO-strengen for **00:00 Europe/Oslo i dag** (regnet om til UTC før vi sender til databasen).
- Oppdater label fra `"Realized PnL · today (UTC)"` → `"Realized PnL · today (Oslo)"`.
- Oppdater sub-tekst fra `"… closed since 00:00 UTC"` → `"… closed since 00:00 Oslo"`.
- Legg `"today_oslo"` inn i `queryKey` så cachen ikke kolliderer med en eventuell gammel verdi.

### 2. `src/components/mobile/pulse/TodayHero.tsx`
- Samme bytte for `start.setUTCHours(0,0,0,0)` → Oslo-midnatt helper.
- Ingen synlig label endres her (kortet sier bare "Today"), bare grensen.

### 3. Ny liten helper: `src/lib/time/oslo-day.ts`
```ts
// Returns ISO timestamp (UTC) for 00:00 Europe/Oslo of "today".
// Uses Intl with timeZone to find the current Oslo Y-M-D, then converts back.
export function osloDayStartISO(now = new Date()): string { ... }
```
Implementasjonen bruker `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year/month/day })` for å finne dagens Oslo-dato, og bygger så et UTC-tidspunkt for 00:00 i den tidssonen ved å beregne offset via `Intl` (håndterer både CET +01:00 og CEST +02:00 automatisk, inkludert sommertid-overgang).

## Hva som ikke endres

- Database-skjema, RLS, server functions, edge functions, execution, dispatcher, risk engine, signalprosessering — null endringer.
- Alle andre `toLocaleString()`-kall (Signals, Positions, Alerts, Audit, Bridge, Telegram, Symbol detail osv.) — uberørte. De viser allerede Oslo-tid via nettleseren din.
- TradingView-embed på `m.positions_.$symbol.tsx` (`timezone=Etc/UTC`) — uberørt, siden du valgte "bare today-grenser".
- `balance_snapshots` "24h" vinduet i TodayHero — det er rullende 24t, ikke kalenderdag, så det er korrekt som det er.

## Verifisering

- Sjekk Overview: Realized PnL-kortet viser nå "today (Oslo)" og summen inkluderer trades lukket fra 00:00 Oslo (ikke 01:00/02:00 lokal tid som før).
- Sjekk mobil Pulse `/m/pulse`: "Today" Realized-tallet matcher Overview-kortet.
- Build går grønn (kun frontend-endringer, ingen nye dependencies).
