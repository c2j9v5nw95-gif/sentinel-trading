## Funn

- Skjermbildet matcher en eldre `ZECUSDT` exit som ble stoppet av `live_gate:bridge_unhealthy:The signal has been aborted`.
- Den nye koden har begynt å bypass’e `bridge_unhealthy` for exit-signaler, mens entry-gates fortsatt er uendret.
- Den aktuelle ZECUSDT-posisjonen er nå lukket i databasen etter en senere exit, men jeg ser to safety-hull som bør tettes før vi stoler på patchen:
  - Recovery-worker bruker `getClientAsync(..., { liveGatePassed: true })`, men lar fortsatt `useBridge` bli styrt av app settings. Kravet ditt sier: hvis bridge health er stale, skal vi fortsatt forsøke exit via bridge. Recovery bør derfor tvinge bridge når bridge er konfigurert.
  - Idempotency er per attempt (`RECOV-<pos>-<attempt>`). Det er bra for retries etter kjent feil, men ved “unknown/duplicate” bør samme `orderLinkId` kunne reconciles før ny attempt øker risikoen for dobbelt-submit.

## Plan

1. **Behold entry-adferd helt uendret**
   - Ikke endre health gate, live gate, risk gate, sizing eller entry execution.
   - Alle endringer begrenses til exit/recovery-kodebaner.

2. **Gjør live exit-bypass eksplisitt safety-only**
   - Behold bypass kun for risk-reduserende exits ved:
     - `bridge_unhealthy:*`
     - `live_risk_breaker_tripped`
     - `critical_invariants_open`
   - Fortsett å blokkere hard-stopp som `emergency_stop_active`, `live_disabled_globally`, `settings_missing`, manglende credentials.
   - Legg audit-trail som tydelig viser `live_gate_bypassed_for_exit` med original årsak.

3. **Tving recovery via bridge når mulig**
   - I `bybit-reconcile` skal live recovery bruke `getClient("live", ..., { liveGatePassed: true, useBridge: true })` når bridge er konfigurert.
   - Hvis bridge ikke er konfigurert, fall tilbake til direct live client kun dersom live API keys finnes.
   - Dette påvirker bare recovery, ikke entries.

4. **Strammere idempotency og “unknown” håndtering**
   - Før ny recovery attempt: sjekk venue-posisjon først.
     - Hvis Bybit viser flat: kun reconcile local state.
     - Hvis Bybit viser åpen: submit reduceOnly close.
   - Ved `duplicate_order_link_id`/unknown: ikke anta suksess. Re-sjekk venue-posisjon:
     - Flat: marker recovered.
     - Fortsatt åpen: behold pending og retry med bounded backoff.
   - Fortsett med deterministisk `orderLinkId` og symbol lock.

5. **Full audit trail per recovery attempt**
   - Logg `exit_recovery_attempted`, `exit_recovery_failed`, `exit_recovery_succeeded`, og `exit_recovery_manual_required` i `position_events` og `audit_log`.
   - Inkluder `attempt`, `orderLinkId`, `venue_size`, `venue_side`, transportvalg (`bridge`/`direct`) og feiltekst.

6. **Critical alert + manual intervention**
   - Ved ukjent/rejected Bybit-respons: send warning/critical etter alvorlighetsgrad og retry bounded.
   - Etter maks attempts: sett `exit_recovery_state = manual_required`, opprett critical system alert og Telegram alert.
   - Ikke åpne ny eksponering under noen recovery path: alle recovery orders må ha `reduceOnly: true` og side motsatt av venue/local position.

## Teknisk scope

- Endre kun:
  - `supabase/functions/_shared/dispatcher.ts`
  - `supabase/functions/bybit-reconcile/index.ts`
  - eventuelt `supabase/functions/_shared/bybit-client.ts` hvis vi trenger en trygg helper for bridge-forced live client.
- Ingen endring i entry-gates eller entry execution.
- Ingen ny database-migrasjon med mindre audit/event-feltene mangler nødvendig kapasitet; dagens JSON-felter ser tilstrekkelige ut.
- Etter implementering deployes relevante backend functions og valideres mot logs/edge function testkall.