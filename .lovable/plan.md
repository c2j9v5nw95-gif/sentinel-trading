## Mål

Bygg om `/overview` til en mission-control som gir operatøren umiddelbar situasjonsforståelse. Strengt read-only — ingen endring i execution, dispatcher, bridge, reconcile, risk engine, signal processing eller order routing. Ingen skrivinger fra UI. Ingen schema-endringer.

## Layout (above the fold, 1629px viewport)

```
┌──────────────────────────────────────────────────────────────────┐
│  StatusBar (eksisterende, uendret)                               │
├──────────────────────────────────────────────────────────────────┤
│  [Equity]    [Unrealized PnL]   [Realized PnL today]   [Bridge]  │
│   $X,XXX     +/- $X (n pos)     +/- $X (n trades)      ●healthy  │
│   sparkline  paper vs live      since 00:00 UTC        age 4s    │
├──────────────────────────────────────────────────────────────────┤
│  Active Exposure      │  Recovery / Manual-Required (if any)     │
│  total notional, %    │  red banner with positions needing op    │
│  per-symbol breakdown │                                          │
├──────────────────────────────────────────────────────────────────┤
│  Active Positions (table, always visible)                        │
│  symbol · side · qty · entry · last · uPnL · uPnL% · protection  │
│  · TSL · age · mode (paper/live) · recovery state                │
├──────────────────────────────────────────────────────────────────┤
│  Recent Closed Trades (last 10)   │  Recent Execution Events     │
│  symbol · side · entry/exit ·     │  rejections, recovery        │
│  rPnL · hold time · exit reason   │  attempts, critical alerts   │
└──────────────────────────────────────────────────────────────────┘
```

Recovery/manual_required-blokken vises kun når det finnes rader, og er rød + sticky øverst i innholdsområdet når aktiv.

## Datakilder (kun lesing)

Alt hentes via `supabase` client fra eksisterende tabeller — ingen nye edge functions, ingen mutations.

| Kort | Kilde | Spørring |
|---|---|---|
| Account equity + sparkline | `balance_snapshots` | siste 24t, ordered by `captured_at`, source-filter (live hvis `app_settings.live_enabled`, ellers paper) |
| Unrealized PnL | `positions` der `closed_at is null` | sum `(last_seen_price - entry_price) * qty_open * sign(side)` på klient, eller fra `paper_wallet.unrealized_pnl` for paper |
| Realized PnL today | `positions` der `closed_at >= today 00:00 UTC` | sum `realized_pnl` |
| Bridge health | `bridge_health_checks` | siste rad, vis `ok`, `latency_ms`, `public_ip`, alder |
| Active positions | `positions` der `closed_at is null` | alle felt allerede tilgjengelig |
| Active exposure | derive fra `positions` open + `last_seen_price * qty_open` | gruppér per symbol |
| Closed trades | `positions` der `closed_at is not null` | order by `closed_at desc` limit 10 |
| Execution events | `position_events` (event_type ilike `%recover%`/`%reject%`) + `system_alerts` (severity in warning/critical, unack) | union via to separate queries, merge i UI |
| Recovery / manual_required | `positions` der `exit_recovery_state in ('pending','manual_required')` | egen query |

Refetch-intervaller: equity/snapshots 30s, positions/exposure 5s, bridge 5s, events 10s, sparkline 60s. Bruk `useQuery` med `refetchInterval`, ingen realtime-subscription i denne fasen.

## Komponenter (nye, frontend-only)

Alle under `src/components/overview/`:

- `MetricCard.tsx` — gjenbrukbar kortrad (label, value, delta, sparkline-slot, status pill)
- `EquityCard.tsx` — equity + 24t sparkline (SVG, ingen ny dep — bygg en liten polyline fra balance_snapshots)
- `UnrealizedPnLCard.tsx` — sum over åpne posisjoner, antall posisjoner, paper vs live splitt
- `RealizedPnLTodayCard.tsx` — sum av `realized_pnl` for trades lukket i dag, antall
- `BridgeHealthCard.tsx` — gjenbruk logikk fra `BridgeStatusPanel` men i kort-format
- `ActiveExposurePanel.tsx` — total notional + per-symbol bar
- `RecoveryAlertBanner.tsx` — rød banner når `exit_recovery_state in ('pending','manual_required')`
- `ActivePositionsTable.tsx` — tett tabell, sortert etter `opened_at desc`
- `RecentClosedTradesTable.tsx` — siste 10, med `exit_reason` chip og hold-time
- `RecentExecutionEventsList.tsx` — kombinert liste av siste rejections, recovery-attempts, critical alerts

Eksisterende `EmergencyStopButton` blir værende uendret i header.

## Endringer i routing

- `src/routes/_app.overview.tsx` — bytt ut innholdet i `Overview()` med ny komponentkomposisjon. Behold `createFileRoute("/_app/overview")` og `EmergencyStopButton` (uendret oppførsel — den skriver ikke i dag).

Ingen nye routes, ingen sidebar-endringer.

## Ikke-mål

- Ingen nye tabeller, ingen migrasjoner.
- Ingen nye edge functions.
- Ingen endring i `dispatcher.ts`, `bybit-reconcile`, `execute-entry`, `execute-exit`, `risk-engine`, `executor.ts`, `bridge-rest`, `live-client`, `paper-client`, `sizing*`, `process-signal`, `protection-monitor`, `live-risk-monitor`.
- Ingen mutations fra UI utover det `EmergencyStopButton` allerede gjør (i dag: ingenting, TODO i koden — vi rører den ikke).
- Ingen nye charting-libs. Sparkline tegnes som inline SVG polyline.
- Trade journal, /analytics-side og designsystem-refresh hører hjemme i senere faser (B/C/D).

## Valideringssteg etter implementering

1. Naviger til `/overview` — verifiser at active positions er synlige uten scroll på 1629x1089.
2. Bekreft at ingen network calls går til execute-/recovery-endpoints.
3. Bekreft at recovery-banner vises kun når det faktisk finnes `exit_recovery_state in ('pending','manual_required')`.
4. Bekreft at bridge-badge oppdateres innen 5s når `bridge_health_checks` får ny rad.
5. Sjekk at sparkline rendres uten 3rd-party deps og uten layout shift.

## Tekniske detaljer

- All datahenting via `useQuery` mot `@/integrations/supabase/client`.
- Sparkline: `<svg viewBox="0 0 100 30">` + `<polyline>` normalisert fra balance_snapshots equity-array. Min/max scaling per kort.
- Tidsformatering: lokal `Intl.DateTimeFormat`, alder vises som `Xs/Xm/Xh ago` (samme helper som i `StatusBar`).
- PnL-farger: `text-success` for positiv, `text-danger` for negativ, eksisterende tokens i `src/styles.css`.
- Tabell-rader klikkbare → `Link to="/positions"` med symbol-filter (hvis det allerede støttes; ellers bare lenke til /positions uten params).
- Mode-chip per posisjon (paper/live/testnet) — gjenbruk `ModeChip` om signaturen passer, ellers inline.
