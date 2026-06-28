# Passord-reset for Lekvaken@gmail.com

Du valgte A (send reset nå). Lenken i e-posten må ha en side å lande på — den finnes ikke i prosjektet i dag, så jeg bygger den minimumssiden samtidig. Ingen endringer i trading-logikk, execution eller backend-data.

## Hva jeg gjør

1. **Opprett `/reset-password`-rute** (`src/routes/reset-password.tsx`, offentlig)
   - Leser Supabase recovery-token fra URL-hash (Supabase setter en midlertidig session ved `type=recovery`)
   - Skjema: nytt passord + bekreft passord (min 8 tegn)
   - Kaller `supabase.auth.updateUser({ password })`
   - Ved suksess: redirect til `/login` med bekreftelsesmelding
   - Feilhåndtering hvis lenken er utløpt/ugyldig

2. **Send reset-mail til Lekvaken@gmail.com**
   - Engangs server-funksjon som kaller `supabase.auth.resetPasswordForEmail("Lekvaken@gmail.com", { redirectTo: "<published-url>/reset-password" })`
   - Bruker published URL (`https://signal-guard-pilot.lovable.app/reset-password`) som redirect, slik at lenken virker både fra mobil-appen og nettleser
   - Kjøres én gang via `invoke-server-function` etter deploy, og fjernes/eller står som ufarlig admin-only hjelper

3. **Legg til "Glemt passord?"-lenke i `src/routes/login.tsx`**
   - Liten lenke under passord-feltet → navigerer til `/forgot-password`
   - Ny `src/routes/forgot-password.tsx` (offentlig): e-postfelt, kaller `resetPasswordForEmail` med samme `redirectTo`
   - Gjør at du (og evt. andre operatører) kan gjøre dette selv neste gang uten å mase på meg

## Forutsetning

Auth-emails må kunne sendes fra Lovable Cloud. Hvis ingen e-postdomene er satt opp, kommer reset-mailen via Lovables default-mal — det er greit for nå (du trenger bare lenken, ikke branding). Hvis sending feiler, sjekker jeg `email_domain--check_email_domain_status` og foreslår oppsett som neste steg.

## Etter implementering

- Du får mail fra Supabase/Lovable med "Reset password"-lenke
- Åpne lenken (helst i mobil-nettleser først for å verifisere), sett nytt passord
- Logg inn i Lovable-mobilappen med nytt passord

Tekniske detaljer: bruker `supabase.auth.resetPasswordForEmail` + `updateUser`, ingen RLS/DB-endringer, ingen nye secrets, ingen endringer på `_app`-guard eller eksisterende ruter utover lenken i login.
