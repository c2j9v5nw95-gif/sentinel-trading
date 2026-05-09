## Diagnose

Tre årsaker til at du blir kastet ut:

1. **`_app.tsx` bruker `supabase.auth.getUser()` i `beforeLoad`.** Det er en nettverkskall som returnerer `null` *i samme sekund som access-tokenet utløper*, selv om refresh-tokenet ditt fortsatt er gyldig. På neste klikk → redirect til `/login`. Riktig kall er `getSession()`, som leser fra lokal storage og auto-refresher tokenet i bakgrunnen.

2. **Ingen `onAuthStateChange`-listener noe sted i appen.** Når Supabase-SDK-en silent-refresher tokenet, eller en annen fane logger deg ut, vet ikke routeren noe. Den fortsetter å sende gamle bearer-tokens i React Query, som 401-er, og du opplever det som "logget ut hele tiden".

3. **JWT-utløp er 1 time** (Supabase default). Hver gang du legger appen i bakgrunnen lenger enn det og kommer tilbake, må refresh skje før første navigasjon — race-betingelser oppstår.

## Endringer

### 1. `src/routes/_app.tsx` — bytt `getUser()` → `getSession()`

`getSession()` returnerer cached session umiddelbart og trigger auto-refresh hvis tokenet er nær utløp. `getUser()` gjør en `/auth/v1/user`-kall som svikter på utløpt token uten å forsøke refresh først. Resultat: du blir aldri kastet ut bare fordi token er gammelt — bare hvis refresh faktisk feiler.

### 2. `src/routes/__root.tsx` — global `onAuthStateChange`-listener

Legg til en effekt i `RootComponent` som:
- Lytter på `onAuthStateChange`.
- Ved `SIGNED_OUT`: navigér til `/login` og invalider queryClient (clear cache).
- Ved `TOKEN_REFRESHED`: invalider queryClient så pågående queries får ny token.
- Ved `SIGNED_IN`: invalider routeren slik at `_app` re-evaluerer og slipper deg gjennom uten F5.

Dette gjør tab-bytte og lange pauser smertefritt — tokenet refreshes silent og UI fortsetter å virke.

### 3. Øke JWT-levetid til 24 timer

Default 1 time betyr refresh hvert 60. min. Med 24 timer bryr ikke brukeren seg om refresh — refresh-tokenet er gyldig 30 dager uansett. Endres via Supabase auth config (`jwt_expiry`).

### 4. (Valgfritt) Liten "loading"-fase i `_app.tsx`

For å unngå et glimt av `/login` mens session hydrater på første render, kan vi vise en kort spinner mens `getSession()` venter. Lite UI-inngrep.

## Det som *ikke* endres

- `client.ts` (auto-generert) — `persistSession: true` + `autoRefreshToken: true` er allerede på, så ingenting å gjøre der.
- Login-skjemaet i `login.tsx` — fungerer som det skal.
- Ingen DB-skjemaendring eller RLS-endring.

## Verifikasjon etter fix

1. Logg inn, lukk fanen, vent 2+ timer, åpne igjen → skal *ikke* sende deg til `/login`.
2. Naviger mellom `/positions` → `/signals` → `/symbols` over 30 min — ingen utlogginger.
3. Sjekk Network-fanen: ingen 401-er på `/rest/v1/...` etter idle-perioder.
4. Logg ut manuelt fra én fane → andre faner følger automatisk.
