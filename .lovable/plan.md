## Mål

Vis en kort liste i Overview over symboler som **har vært aktive** (har minst ett HEALTH_ALL-snapshot fra før) men som **ikke har sendt nytt helsealert på over 120 minutter**. Disse skal blokkeres for nye entries, og du skal kunne deaktivere dem direkte fra listen.

## Hvordan stale defineres

Et symbol er `stale` når:
1. Det er `enabled=true` i `symbols`
2. Det finnes minst ett snapshot i `health_snapshots` med `strategy='HEALTH_ALL', tag=''` for symbolet (har vært aktivt)
3. Nyeste snapshot for symbolet er > **120 minutter** gammelt (hardkodet konstant `HEALTH_STALE_MINUTES = 120`)

Symboler som aldri har sendt et HEALTH_ALL-snapshot beholder dagens "no data"-oppførsel — de er ikke stale, bare ikke-aktivert ennå.

## Backend — `supabase/functions/_shared/health-gate.ts`

Legg til staleness-sjekk **før** thresholds evalueres. Etter at snapshot er hentet:

```ts
const STALE_MS = 120 * 60 * 1000;
const ageMs = Date.now() - new Date(snap.created_at).getTime();
if (ageMs > STALE_MS) {
  return {
    pass: false,
    reason: "health_stale",
    metrics: { symbol, applied_strategy: HEALTH_STRATEGY, snapshot_age_minutes: Math.round(ageMs / 60000), stale_threshold_minutes: 120 },
  };
}
```

Plassering: rett etter `if (!snap)`-blokken, før wr/pf/np-sammenligningene. Exit-signaler treffer aldri denne gaten (eksisterende logikk i kallerne — uendret).

## Frontend — `src/components/overview/SymbolHealthPanel.tsx`

1. **Ny status `stale`** i tillegg til `open` / `blocked` / `no_data`. Klassifisering basert på `created_at` på siste snapshot:
   - alder > 120 min → `stale` (uavhengig av PF/Net)
   - ellers eksisterende logikk

2. **Layout**: behold to-kolonners grid for Open / Blocked, og legg til en **tredje seksjon under** med tittel "Stale (no health alert > 120m)" som bare vises når listen ikke er tom. Hver rad viser:
   - Symbol
   - Alder på siste snapshot (`fmtAge`)
   - PF/Net fra siste (gamle) snapshot, dempet
   - **"Disable"-knapp** (rød outline)

3. **Disable-knapp**: kaller direkte fra browser-klient
   ```ts
   await supabase.from("symbols").update({ enabled: false }).eq("symbol", sym);
   ```
   RLS-policyen `operator manages symbols` håndterer autorisasjon. Etter suksess: `queryClient.invalidateQueries({ queryKey: ["overview", "symbol_health"] })` så raden forsvinner umiddelbart. Confirm-dialog (`window.confirm`) før kall.

4. **Tittel-oppdatering**: `Symbol health · X open · Y blocked · Z stale` (skip stale-segmentet hvis 0).

## Verifisering

- BSBUSDT/LABUSDT/PENGUUSDT (currently `Blocked` med ferske snapshots) skal forbli i `Blocked`-kolonnen, ikke flyttes til Stale.
- Hvis en TV-alert stopper å sende, vises symbolet som Stale etter 120 min, og en ny entry-signal får `pass=false reason="health_stale"` i `risk_decisions`.
- Klikk "Disable" → `symbols.enabled = false` → raden forsvinner fra alle tre seksjonene neste refetch (siden listen filtrerer på `enabled=true`).

## Ikke i scope

- Ingen schema-endring (ingen nye kolonner/tabeller)
- Ingen endring i andre overview-komponenter
- Ingen automatisk re-aktivering når alerts kommer tilbake (bruker må gjøre det manuelt fra Symbols-siden)
