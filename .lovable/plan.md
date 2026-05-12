
## Mål

Få ZECUSDT og BSBUSDT til faktisk å trade med 40 % equity-andel, fjerne overrides som ikke matcher noe entry-signal, og gjøre det vanskelig å gjenta samme feil i UI.

## Bakgrunn (kort)

- Sizing-resolveren matcher overrides på eksakt `(symbol, strategy, tag)`.
- Du har overrides på `(ZEC/BSB, HEALTH_ALL, '')`, men `HEALTH_ALL` er en helse-snapshot-strategi, ikke en entry-strategi.
- Faktiske entry-signaler kommer som `ES1/EL1/XS1/XL1/...` med tag `STRAT2`.
- Resultat: overrides treffer aldri, og symbol-default 5 % brukes.

## Endringer

### 1. Data-fix (ingen skjemaendring)

Bruk insert-tool (UPDATE/DELETE):

- `UPDATE symbols SET account_balance_percent = 40 WHERE symbol IN ('ZECUSDT','BSBUSDT')`
- `DELETE FROM symbol_strategy_overrides WHERE strategy IN ('HEALTH_ALL','H_LONG','H_SHORT')` (rydd vekk de ubrukte/feilrettede radene)

Andre symboler (`PENGUUSDT`, `LABUSDT`, `PIEVERSEUSDT`) røres ikke.

### 2. UI-guardrail i sizing-override-skjemaet

Mål: gjør det åpenbart hvis valgt `(symbol, strategy, tag)` ikke matcher reelle entry-signaler.

Filplassering (basert på eksisterende ruter, sannsynligvis `src/routes/_app.symbols.tsx` eller en tilhørende komponent — bekreftes ved implementering):

- I strategi-velgeren for `symbol_strategy_overrides`:
  - Filtrer ut `HEALTH_ALL`, `H_LONG`, `H_SHORT` fra dropdown-en (de er aldri entry-strategier).
  - Sorter resterende strategier etter antall reelle entry-signaler siste 30 dager (mest brukte øverst).
- Etter at bruker har valgt `(symbol, strategy, tag)`:
  - Kjør lett spørring mot `signals` (count entries siste 30d for valgt tuple).
  - Hvis treffet er 0: vis en gul "Warning"-banner i form-en: "Ingen entry-signaler matcher denne tuplen siste 30 dager — overriden vil ikke aktiveres."
  - Lagring blokkeres ikke; brukeren kan fremdeles lagre bevisst.

### 3. Verifisering

- Kjør et nytt ZEC-eller BSB entry-signal (eller vent på neste live), og verifiser i `signals.decision_trail` at `sizing.metrics.marginAllocatedUsdt` ≈ 40 % av `availableBalanceUsdt` og `effectiveLeverage = 10`.
- Sjekk at sizing-override-form viser advarsel hvis man velger `HEALTH_ALL` (skal nå være filtrert bort).

## Det jeg IKKE gjør i denne planen

- Ingen endring i `executor.ts`, `sizing.ts`, `sizing-resolver.ts`, dispatcher, bridge, recovery, eller execution-paths.
- Ingen skjemaendring (kun data-update + frontend).
- Ingen endring i `sizing_rules` (globale regler).
- Andre symboler beholder sin nåværende `account_balance_percent`.
