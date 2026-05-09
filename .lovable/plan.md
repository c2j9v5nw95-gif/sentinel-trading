## Problem

Du blir kastet ut til `/login` veldig fort etter å ha logget inn. Auth-loggen viser kun ett `/token`-kall (selve innloggingen) og null `/logout` eller refresh-feil. Sesjonen er altså fortsatt gyldig hos Supabase når du blir bouncet — det er klienten vår som omdirigerer.

## Årsak

Auth-vakten i `src/routes/_app.tsx`:

```ts
beforeLoad: async () => {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw redirect({ to: "/login" });
}
```

`beforeLoad` i TanStack Start er **isomorf** — den kjører både på server (SSR) og klient. På server-siden finnes ikke `localStorage`, så Supabase-klienten har ingen lagret sesjon, `getSession()` returnerer `null`, og redirect-en skyter deg ut til `/login`.

Dette utløses av:
- Vite HMR-restart (du ser `[vite] server connection lost. Polling for restart…` i konsollen rett før du blir kastet ut). Hver gang sandboxen restarter (f.eks. når jeg deployer edge functions eller endrer config), gjør appen en SSR-runde og bouncer.
- Hard reload (F5) eller deeplink — alle SSR-renders.
- Også TOKEN_REFRESHED-listeneren i `__root.tsx` kaller `queryClient.invalidateQueries()`, som re-kjører beforeLoad — men det kjører på klient og burde være ok. Hovedproblemet er SSR-sjekken.

## Løsning

Hopp over auth-sjekken under SSR og la klient-siden gjøre vurderingen etter hydrering. Sesjonen ligger i `localStorage` og leses inn synkront når Supabase-klienten initialiseres i nettleseren, så `getSession()` på klient returnerer en gyldig sesjon umiddelbart.

### Endring 1: `src/routes/_app.tsx`

```ts
beforeLoad: async () => {
  // SSR har ingen localStorage; la klient-siden avgjøre etter hydrering.
  if (typeof window === "undefined") return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw redirect({ to: "/login" });
}
```

### Endring 2 (valgfri men anbefalt): `src/routes/__root.tsx`

`onAuthStateChange` kaller `queryClient.invalidateQueries()` ved `TOKEN_REFRESHED`. Det er greit, men det invaliderer alle queries hver ~time og kan gi flikker. Bytt til mer målrettet håndtering:

```ts
} else if (event === "TOKEN_REFRESHED") {
  // No-op: Supabase setter ny token i lagring automatisk;
  // queries trenger ikke invalideres bare fordi token rullerte.
}
```

Hovedfiksen er endring 1. Endring 2 er en oppstramming.

## Verifisering

1. Logg inn på `/login`.
2. Naviger rundt i appen, refresh siden hardt (Ctrl/Cmd+R) — du skal forbli innlogget.
3. Vent på at Vite restarter (eller trigger en redeploy) — ingen redirect til `/login`.
4. Sjekk auth-loggen: kun ett `/token`-kall per faktisk innlogging.

## Tekniske detaljer

- Ingen DB-endringer.
- Ingen edge function redeploy.
- Bare to filendringer (én er valgfri).
- Sesjonens levetid (default 1 time access token + 7 dagers refresh token) endres ikke; refresh skjer automatisk i bakgrunnen via `autoRefreshToken: true`.
