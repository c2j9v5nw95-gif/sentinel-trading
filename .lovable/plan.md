# Health gate: null = pass

## Problem
Du backtester på 3000 lys for å sikre statistisk relevans. Når et symbol ikke har hatt trades i de siste 3000 lysene, sender TradingView `profit_factor: na` (null). I dag tolker gaten `null` som "under terskel" og blokkerer entryen:

```ts
if (minPf != null && (pf == null || pf < minPf))
  return { pass: false, reason: "profit_factor_below_threshold", ... }
```

Det var årsaken til at PIEVERSEUSDT-entryen din i morges ble avvist — snapshotet hadde `profit_factor: null, winrate: null, net_profit: 0`.

## Endring
I `supabase/functions/_shared/health-gate.ts`, behandle `null`-verdier som "ingen data for denne metrikken" → ikke blokker. Bare blokker når metrikken faktisk er rapportert OG ligger under terskel.

**Før:**
```ts
if (minPf != null && (pf == null || pf < minPf))
  return { pass: false, reason: "profit_factor_below_threshold", metrics };
```

**Etter:**
```ts
if (minPf != null && pf != null && pf < minPf)
  return { pass: false, reason: "profit_factor_below_threshold", metrics };
```

Samme mønster for `winrate` og `net_profit` — for konsistens, slik at et symbol uten trades ikke blokkeres av noen av de tre tersklene.

Hvis ALLE tre metrikkene er null, returnerer vi `pass: true` med `reason: "no_metric_data"` (ny grunn) slik at det er tydelig i `risk_decisions`-loggen at gaten passerte fordi det ikke fantes data å sammenligne mot — ikke fordi tersklene var møtt.

Andre gates (stale-vakten på 120 min, `health_strategy_disabled`, snapshot mangler helt) er uendret.

## Filer
- `supabase/functions/_shared/health-gate.ts` — løs opp `pf/wr/np < terskel`-sjekkene som beskrevet, legg til `no_metric_data`-utfall.

## Hvorfor ikke endre frontend også
`SymbolHealthPanel` viser allerede null som "—" og klassifiserer bare som `blocked` når en faktisk verdi ligger under terskel — den logikken er allerede korrekt. Ingen endring der.

## Ikke i scope
- Endre hvordan TradingView-alertet sender stats (du har bekreftet at `na` er forventet ved 0 trades).
- Endre `STALE_MINUTES`-vakten — den skal fortsatt blokkere om HEALTH_ALL-alertet stopper helt.
