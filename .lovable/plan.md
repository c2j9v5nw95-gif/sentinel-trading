## Mål

Etter forklaringen er vi enige om at det er klargjørende å se **både** den konfigurerte og den effektive verdien overalt — ikke gjette, ikke skjule. Begge tabellene skal vise samme tallsett:

- **Konfigurert** = symbol-rad i `symbols` (det du selv har satt — f.eks. 40 % / 10x).
- **Effektiv** = det `sizing-resolver` faktisk bruker etter at sizing rules + per-tuple overrides har spilt ut (f.eks. 15 % / 10x for FIGHTUSDT).

## Endringer

### 1. `src/routes/_app.kontrollsenter.tsx` (Symbols-tab)

- Bytt kolonneheaderne **% equity** og **Lev** til to celler hver: vis effektiv verdi stort, og under den vises konfigurert verdi som liten muted tekst hvis de er forskjellige (f.eks. `15.0` på linje 1 og `cfg 40.0` i `text-xs text-muted-foreground` under). Hvis like, vis kun ett tall.
- Når effektiv stammer fra en sizing rule eller override, legg på en liten badge/hover-tooltip med kilden (`r.eval.source` finnes allerede — `rule:high_winrate_equity`, `override:FIGHTUSDT`, `default`). Tooltip via `title=`.
- Ingen logikk-endring: `evaluateClient` returnerer allerede både effektiv verdi og kilde. Vi trenger bare å hente konfigurert verdi fra `r.sym` for sammenligning.

### 2. `src/routes/_app.symbols.tsx`

- Legg til to nye read-only kolonner ved siden av **Bal %** og **Lev**: `Eff Bal %` og `Eff Lev`. De viser effektiv verdi etter samme regelsett som Kontrollsenter, og har samme tooltip-kilde.
- For å unngå duplisert logikk: trekk ut `evaluateClient` + `matches` fra `_app.kontrollsenter.tsx` til en delt fil `src/lib/sizing-eval.ts` (ren klient-helper, ingen Supabase-kall — tar `snap, sym, ov, rules` som argumenter). Begge sidene importerer derfra.
- Symbols-siden henter nå også siste `health_snapshots` (kollapset til ett rad per ticker, samme prefer-HEALTH_ALL-logikk som Kontrollsenter), `symbol_strategy_overrides` og `sizing_rules` for å kunne kalle `evaluateClient`. Hvis snapshot mangler for et symbol → effektiv = konfigurert (ingen rules treffer uten snapshot).
- Ingen endring i edit-modus eller validering. Bare to ekstra display-kolonner.

### 3. Ingen DB-endring, ingen executor-endring

Sizing-resolveren på serveren er allerede sannhetskilden. Vi endrer kun visning. Ingen `sizing_rules` slås av; ingen migrasjoner.

## Resultat

- Du ser med ett blikk på Symbols-siden at FIGHTUSDT er konfigurert til 40 % men trader effektivt på 15 % pga. `high_winrate_equity`-regelen — uten å åpne Kontrollsenter.
- Kontrollsenter viser også konfigurert ved siden av effektiv, så du raskt ser hva som ville skjedd hvis regelen ikke hadde truffet.
- Tooltip på effektiv-kolonnen forteller hvilken regel/override som førte til verdien.

## Filer som endres

- `src/lib/sizing-eval.ts` (ny — eksporterer `evaluateClient`, `matches`, typer)
- `src/routes/_app.kontrollsenter.tsx` (importerer fra sizing-eval, viser konfigurert under effektiv)
- `src/routes/_app.symbols.tsx` (henter snaps/overrides/rules, legger til Eff Bal % + Eff Lev kolonner)

## Ikke i scope

- Ingen redigering av effektiv-verdi direkte (det gjøres fortsatt via Edit på symbol eller via override-drawer i Kontrollsenter).
- Ingen ny indikator for "blocked by rule" i Symbols (Kontrollsenter har allerede status-pillen som dekker det).
