## Sannheten om hva vi setter hos Bybit

- **SL** — armes alltid ved entry (`executor.ts` → `setTradingStop({slPrice})`)
- **TSL** — armes av `protection-monitor` når posisjonen når aktiveringsterskel (`setTradingStop({trailingStop})`)
- **Ingen TP-ordre** ligger noen gang hos Bybit

Alle andre exits er reduce-only market orders **vi** sender, trigget av enten et TradingView-signal (XL1–XL5 / XS1–XS5) eller vår interne `protection-monitor`. Dagens "BYBIT TP1 hit"-merking er feil — TP1 er aldri en Bybit-ordre.

## Ny "Closed by"-klassifisering

Tre mulige *triggere* som faktisk kan lukke en posisjon, mappet til prefiks og farge:

| Prefiks | Tone | Hvem trigget | Hvordan vi kjenner igjen |
|---|---|---|---|
| `[BYBIT]` | warning | Bybits native SL eller TSL fylte (vi sendte ingen ordre) | Posisjonen lukket via `bybit-reconcile` (`event_type='reconciliation_drift'` med `closed=true` i detail), og det finnes ingen `exit_*`/`sl_triggered`/`tsl_triggered` på posisjonen |
| `[MONITOR]` | danger | Vår `protection-monitor` så at intern SL/TSL ble brutt og sendte reduce-only exit | `event_type='sl_triggered'` eller `'tsl_triggered'` |
| `[TV]` | success / warning | TradingView-signal trigget reduce-only exit | Det finnes `exit_*`-event for posisjonen, og `signals.strategy_code` på `last_exit_signal_id` (eller siste exit-signal koblet til posisjonen) er XL1–XL5 / XS1–XS5 |
| `[RECOVERY]` | danger | `bybit-reconcile` tvangslukket | `event_type='exit_recovery_succeeded'` |
| `[MANUAL]` | muted | Operator stengte | `event_type='manual_close'` |

### Etikett (det som vises etter prefikset) — bruker strategikoden direkte

For `[TV]` viser vi den faktiske TradingView-koden så det matcher Pine-strategien 1:1:

| strategy_code | Etikett | Tone |
|---|---|---|
| XL1 | `[TV] XL1 · TP1` | success |
| XL2 | `[TV] XL2 · SL/Failsafe` | warning |
| XL3 | `[TV] XL3 · Opposite` | success |
| XL4 | `[TV] XL4 · TP2 (REST)` | success |
| XL5 | `[TV] XL5 · Trend fail` | warning |
| XS1 | `[TV] XS1 · TP1` | success |
| XS2 | `[TV] XS2 · SL/Failsafe` | warning |
| XS3 | `[TV] XS3 · Opposite` | success |
| XS4 | `[TV] XS4 · TP2 (REST)` | success |
| XS5 | `[TV] XS5 · Trend fail` | warning |

For `[BYBIT]`: `SL fill` hvis `tsl_active=false` på posisjonen, `TSL fill` hvis `tsl_active=true`.
For `[MONITOR]`: `SL` for `sl_triggered`, `TSL` for `tsl_triggered`.

Beskrivelsen (`description` fra `strategy_codes`) vises i tooltip sammen med rå `event_type` og evt. `signals.exit_reason`.

## Implementasjon

**Endrede filer (kun frontend):**

`src/components/overview/RecentClosedTradesTable.tsx`:
- Utvid query til å hente:
  - `position_events` med alle relevante `event_type`-verdier (inkludert `reconciliation_drift`)
  - `positions.tsl_active` og `positions.last_exit_signal_id` (legges til i select hvis ikke allerede der)
  - `signals.strategy_code` for `last_exit_signal_id`
- Ny `classifyExit({ events, position, exitSignal })`-funksjon med prioritet:
  1. `manual_close` → `[MANUAL]`
  2. `exit_recovery_succeeded` → `[RECOVERY]`
  3. `sl_triggered` → `[MONITOR] SL`
  4. `tsl_triggered` → `[MONITOR] TSL`
  5. `exit_*` (TV-trigget) → `[TV] {strategy_code} · {label}` basert på lookup-tabell over
  6. `reconciliation_drift` uten øvrige exit-events → `[BYBIT] SL fill` eller `[BYBIT] TSL fill` basert på `position.tsl_active`
  7. Ingen match → `—`
- Tre nye prefikstoner (success/warning/danger/muted)
- Tooltip: `event_type` + `strategy_code` + `description` + `exit_reason`

**Ingen backend- eller schema-endringer.** Alle data finnes allerede.

## Verifisering

- BSBUSDT-rad med `XL2/XS2` → `[TV] XL2 · SL/Failsafe` (warning)
- ZECUSDT-rad med `XS1` → `[TV] XS1 · TP1` (success) — ikke lenger `[BYBIT] TP1 hit`
- BSBUSDT-rad med `XL5/XS5` → `[TV] XL5 · Trend fail` (warning)
- Hypotetisk rad der Bybits native SL fylte → `[BYBIT] SL fill` (warning)
