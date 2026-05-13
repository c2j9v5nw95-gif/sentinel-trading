## Mål

Når et symbol auto-opprettes via HEALTH_ALL skal det få samme "aggressive default-profil" som BSBUSDT/ZECUSDT, ikke arve globalt:

| Felt | Verdi |
|---|---|
| `enabled` | `true` |
| `execution_mode_override` | `'live'` |
| `account_balance_percent` | `40` |
| `sl_pct` | `3.5` |
| `tsl_enabled` | `true` |
| `tsl_activation_profit_pct` | `1` |
| `tsl_callback_pct` | `4` |

(Andre felter beholder kolonne-default: `leverage=10`, `margin_mode=isolated`, `position_size_multiplier=1`, `tp1_exit_percent=100`, `preferred_transport=webhook`.)

## Endringer

### 1. `supabase/functions/_shared/dispatcher.ts` (auto-register-blokken, linje ~117-140)

Endre kun **insert-grenen** (når symbolet ikke finnes fra før) til å sette de nye defaultene:

```ts
await sb.from("symbols").insert({
  symbol: signal.symbol,
  enabled: true,
  execution_mode_override: "live",
  account_balance_percent: 40,
  sl_pct: 3.5,
  tsl_enabled: true,
  tsl_activation_profit_pct: 1,
  tsl_callback_pct: 4,
});
```

Audit-loggen `symbol_auto_registered` får `after` utvidet til å inkludere disse defaultene for sporbarhet.

**Reaktiverings-grenen** (`sym.enabled === false`) endres ikke — den setter kun `enabled=true` og rører ikke konfig som operatøren kan ha justert.

### 2. Engangs-fix for FIGHTUSDT og RAVEUSDT

Disse to ble nettopp auto-registrert med `mode=inherit, BAL=5%, SL=1.5%, TSL 1/0.5` (kolonne-defaults). Oppdater dem til den nye profilen via data-update slik at de står likt med BSB/ZEC umiddelbart:

```sql
UPDATE public.symbols
SET execution_mode_override = 'live',
    account_balance_percent = 40,
    sl_pct = 3.5,
    tsl_enabled = true,
    tsl_activation_profit_pct = 1,
    tsl_callback_pct = 4,
    updated_at = now()
WHERE symbol IN ('FIGHTUSDT','RAVEUSDT');
```

PIEVERSEUSDT lar vi være — den ble manuelt opprettet (BAL=2%, lev=5x), så operatøren har bevisst valgt en annen profil. Hvis du vil at den også skal normaliseres, si fra.

LABUSDT/PENGUUSDT er stale og rører vi ikke (de er allerede konfigurert).

## Ikke i scope

- Ingen schema-/kolonnedefault-endringer (defaults forblir forsiktige; det er auto-register-koden som velger den aggressive profilen).
- Ingen UI-endringer.
- Ingen endring i reaktiverings-oppførsel — disabled→enabled rører kun `enabled`-flagget.

## Verifisering

1. SQL etter engangs-fix: FIGHTUSDT og RAVEUSDT viser `mode=live, BAL=40, SL=3.5, TSL 1/4` i Symbols-tabellen.
2. Neste gang et helt nytt symbol sender HEALTH_ALL, dukker det opp med live + 40% + 3.5 / 1/4 — uten manuell editering.
3. `audit_log` for `symbol_auto_registered` viser de nye default-verdiene i `after`.
