## To ting

### 1. Synliggjøre disablede symboler i Kontrollsenter → Symbols

I dag har Status-kolonnen kun tre tilstander: `unregistered`, `BLOCKED`, `trades`. Et symbol som finnes i `symbols` med `enabled=false` vil i praksis vises som `trades` eller `BLOCKED` avhengig av tall — ikke som "av".

**Endring i `src/routes/_app.kontrollsenter.tsx`** (visnings-raden, linje 162-205):

- Legg til en sjekk `const isDisabled = r.sym && r.sym.enabled === false;` før Status-cellen.
- Når `isDisabled`:
  - Hele `<tr>` får `opacity-50 grayscale` (samme mønster som vi nettopp brukte i Symbols-siden).
  - Symbol-navnet i `<td>` får `text-muted-foreground line-through`.
  - Status-pille viser `DISABLED` (`border-border bg-muted text-muted-foreground uppercase`) i stedet for BLOCKED/trades.
  - `% equity` og `Lev`-cellene viser `—` (siden symbolet ikke trader uansett).
- Ingen endring for `unregistered`, `BLOCKED`, `trades`.

Ingen logikk-endring i `evaluateClient` — kun visuell tilstand.

### 2. Fjerne BTCUSDT-raden

Sjekket opprinnelsen:
- `health_snapshots`: én rad, `strategy='sim'`, fra 2026-05-08 (sim-injection, ikke ekte TradingView-alert).
- `signals`: tilhørende rad er `transport=webhook, type=stats, strategy=sim, action=HEALTH` — altså en simulert testalert.

BTCUSDT vises fordi Symbols-tabben faller tilbake til siste snapshot (uansett strategi) når ingen HEALTH_ALL finnes for symbolet. Det er korrekt oppførsel for ekte symboler, men her er kilden en gammel sim-test.

**Engangs-fix:** slett den ene sim-snapshoten:
```sql
DELETE FROM public.health_snapshots WHERE symbol='BTCUSDT' AND strategy='sim';
```

Da forsvinner BTCUSDT fra listen umiddelbart. Signal-raden i `signals` beholdes for sporbarhet (den dukker ikke opp i Kontrollsenter — kun i Signals/Audit).

## Ikke i scope

- Ingen filterregel for å skjule alle `strategy='sim'`-snapshots fra Kontrollsenter generelt — vi kan ta det hvis flere sim-symboler dukker opp i fremtiden.
- Ingen endring i Symbols-siden (gjort i forrige loop).
- Ingen endring i `evaluateClient`/sizing-logikk.

## Verifisering

1. BTCUSDT er borte fra Kontrollsenter → Symbols.
2. Hvis du midlertidig disabler f.eks. BSBUSDT i Symbols-siden, dukker den opp i Kontrollsenter med dimmet rad, gjennomstreket navn og en `DISABLED`-pille i Status-kolonnen.
