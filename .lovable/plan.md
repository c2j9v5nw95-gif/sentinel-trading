## Problem

PENGUUSDT ENTER-LONG signaler kommer som `QUEUED`, men feiler i dispatcher med:

```
exec_error: live_execution_disabled: complete liveExecutionGate before requesting mode='live'
```

…og blir requeued helt til de dør. EXIT-LONG blir deretter avvist med `risk:no_open_position` fordi entry aldri ble utført.

### Rotårsak

`supabase/functions/_shared/bybit-client.ts → getClient()` kaster ALLTID når `mode === 'live'`:

```ts
throw new Error("live_execution_disabled: complete liveExecutionGate before requesting mode='live'");
```

Men ingen i kodebasen kaller faktisk `liveExecutionGate()` før de ber om live-klient. Resultat: live-execution er hardkodet av, selv om:
- `app_settings.live_enabled = true`
- `symbols.execution_mode_override = 'live'` for PENGUUSDT
- `emergency_stop = false`, `live_risk_halted = false`, ingen kritiske invariant-brudd

`LiveBybitClient` finnes og er klar, men blir aldri instansiert.

## Løsning

Aktivér live-pathen ved å la dispatcher kjøre gaten, og la factory instansiere `LiveBybitClient` når gaten har passert.

### 1. `supabase/functions/_shared/bybit-client.ts`
Legg til en eksplisitt opt-in i factory:

```ts
export function getClient(
  mode: ExecutionMode,
  sb: SupabaseClient,
  opts?: { liveGatePassed?: boolean },
): BybitClient {
  if (mode === "paper")   return new PaperBybitClient(sb);
  if (mode === "testnet") return new TestnetBybitClient(sb);
  if (mode === "live" && opts?.liveGatePassed) return new LiveBybitClient(sb);
  throw new Error("live_execution_disabled: complete liveExecutionGate before requesting mode='live'");
}
```

### 2. `supabase/functions/_shared/dispatcher.ts`
Etter `resolveExecutionMode(...)`, kall `liveExecutionGate(sb)` når `mode === 'live'`:

- Hvis gaten returnerer en reason (f.eks. `live_api_keys_missing`, `emergency_stop_active`): sett signal `status='rejected'`, `decision_reason = 'live_gate:<reason>'`, logg i `risk_decisions` + `audit_log`, ingen retry. Trail-event `live_gate_blocked`.
- Hvis gaten returnerer `null`: trail `live_gate_passed`, send `liveGatePassed: true` ned til `executeEntry` / `executeExit`.

### 3. `supabase/functions/_shared/executor.ts`
- Utvid signaturen til `executeEntry` og `executeExit` med `opts?: { liveGatePassed?: boolean }`.
- Send `opts` videre til `getClient(mode, sb, opts)` på linje 55 og 290.

### 4. Verifisering
- Sjekk at `BYBIT_LIVE_API_KEY` og `BYBIT_LIVE_API_SECRET` faktisk er satt som secrets (ellers vil gaten returnere `live_api_keys_missing` og signaler vil bli avvist med klar grunn istedenfor å henge i kø).
- Re-injiser en test-signal eller vent på neste TradingView-alert; PENGUUSDT ENTER-LONG bør nå gå til `processed` med `decision_reason='executed:live'`, og påfølgende EXIT-LONG vil finne en åpen posisjon å lukke.

## Hva endringen IKKE gjør

- Ingen endringer i risk engine, sizing eller TSL/SL-logikk.
- Paper/testnet-paths uendret.
- Sikkerhetsgaten beholdes — vi bare KALLER den nå.
