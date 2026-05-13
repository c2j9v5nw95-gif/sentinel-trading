## Regel (bekreftet)

1. **HEALTH_ALL kommer inn** → symbol auto-opprettes/auto-aktiveres i `symbols` (`enabled=true`).
2. **Åpnes eller blokkeres** basert på snapshot-tallene mot HEALTH_ALL-thresholds (eksisterende logikk i `health-gate.ts`).
3. **Ingen HEALTH_ALL på > 120 min** → `health_stale` → blokkert og vist i Stale-seksjonen (allerede implementert).
4. **Disable-knapp i Stale** → `enabled=false`. Forblir disabled så lenge alerts er borte. Hvis TV-alert noensinne kommer tilbake → auto-reaktiveres ved første HEALTH_ALL.

## Status nå

| Symbol | I `symbols`? | enabled | Siste HEALTH_ALL | Synlig? |
|---|---|---|---|---|
| BSBUSDT, ZECUSDT | ✅ | true | fersk | ✅ Open/Blocked |
| FIGHTUSDT, RAVEUSDT | ❌ mangler | — | fersk (18:30) | ❌ usynlig |
| PIEVERSEUSDT | ✅ | false | fersk (18:15) | ❌ skjult |
| LABUSDT, PENGUUSDT | ✅ | true | 9. mai (stale) | ✅ Stale |

## Endringer

### 1. Backend — auto-register i HEALTH_ALL-skrivingen

I `supabase/functions/_shared/dispatcher.ts` (der HEALTH_ALL-snapshots faktisk skrives — bekreftes ved implementasjon; `record-health/index.ts` delegerer hit), **etter** vellykket insert i `health_snapshots` og kun når `strategy='HEALTH_ALL' AND tag=''`:

```ts
// Auto-register or auto-reactivate the symbol so it shows up in
// SymbolHealthPanel and is eligible for entries. Defaults from the
// symbols table apply (leverage 10, sl_pct 1.5, tsl_enabled, ...).
const { data: existing } = await sb
  .from("symbols")
  .select("symbol, enabled")
  .eq("symbol", symbol)
  .maybeSingle();

if (!existing) {
  await sb.from("symbols").insert({ symbol, enabled: true });
  await sb.from("audit_log").insert({
    action: "symbol_auto_registered",
    target: symbol,
    after: { source: "health_all_received" },
  });
} else if (existing.enabled === false) {
  await sb.from("symbols").update({ enabled: true, updated_at: new Date().toISOString() }).eq("symbol", symbol);
  await sb.from("audit_log").insert({
    action: "symbol_auto_reenabled",
    target: symbol,
    before: { enabled: false },
    after: { enabled: true, source: "health_all_received" },
  });
}
```

Failure-mode: hvis upsert/insert feiler, logges men HEALTH_ALL-mottaket kvitteres fortsatt OK (samme defensive mønster som ellers i dispatcher).

### 2. Frontend — Disable-knapp tooltip

I `SymbolHealthPanel.tsx`, oppdater hover/title på Disable-knappen:
> "Disables symbol. Will auto-reactivate if a HEALTH_ALL alert arrives again."

Confirm-dialog (window.confirm) får samme tekst slik at oppførselen er tydelig.

### 3. Engangs-fix — PIEVERSEUSDT

Sett `enabled=true` umiddelbart via data-insert (TV sender allerede ferske alerts), så den slipper å vente på neste alert-syklus:

```sql
UPDATE symbols SET enabled = true, updated_at = now() WHERE symbol = 'PIEVERSEUSDT';
```

## Verifisering

1. SQL: `SELECT symbol, enabled FROM symbols WHERE symbol IN ('FIGHTUSDT','RAVEUSDT','PIEVERSEUSDT')` — PIEVERSEUSDT umiddelbart `true`; FIGHT/RAVE dukker opp som rader ved neste HEALTH_ALL (~15 min).
2. Etter neste HEALTH_ALL-syklus skal SymbolHealthPanel vise BSBUSDT, ZECUSDT, FIGHTUSDT, RAVEUSDT, PIEVERSEUSDT i Open/Blocked, og LABUSDT/PENGUUSDT i Stale.
3. Klikk Disable på LABUSDT → forsvinner. Auto-aktiveres kun hvis LAB-alert kommer tilbake.
4. `audit_log` viser `symbol_auto_registered` for FIGHT/RAVE og `symbol_auto_reenabled` for PIEVERSE neste gang regelen trigges (PIEVERSE blir manuelt fixet før det rekker å skje).

## Ikke i scope

- Ingen schema-endring
- Ingen endring i `health-gate.ts` (stale-gate er allerede korrekt)
- Ingen automatisk **deaktivering** når 120 min har gått — symbolet forblir `enabled=true` men blokkeres via stale-gate. Operatør velger selv om hen vil disable manuelt.
