
# Excel bulk-import for backtest-resultater

Ny funksjon på Calibration-siden som lar deg laste opp Excel-arket fra scan-verktøyet og få hver rad lagret som en backtest — nøyaktig som dagens én-og-én-lagring, men i bulk. Kjøres hver gang du har en oppdatert scan; rader som allerede finnes med samme scan-dato hoppes over.

## Hva som legges til

**1. Ny "Importer fra Excel"-knapp på Calibration-siden**
- Åpner en dialog: last opp .xlsx, velg strategy_version + timeframe (default `5m`) som skal brukes for alle rader i filen, se preview, kjør import.
- Preview viser: totalt rader i filen, hvor mange som er nye, hvor mange som hoppes over (allerede lagret med samme scan-dato), hvor mange som feiler validering.
- Etter import: liste med resultat per coin (Lagret / Hoppet over / Feilet + grunn).

**2. Ny server-funksjon `importBacktestFromExcel`**
- Mottar parset rad-liste + felles metadata (strategy_version, timeframe).
- For hver rad: sjekker om det allerede finnes en rad for `(user_id, symbol, strategy_version, test_date)` med samme `test_date` som scan-datoen i Excel → hopp over.
- Ellers: kaller nøyaktig samme lagringslogikk som `createBacktestResult` bruker i dag (auto-labeling, sizing-defaults, derived metrics, needs_review-flagg). Ingen ny lagringsvei — vi gjenbruker den eksisterende koden slik at resultatet i databasen blir identisk med manuell lagring.

## Kolonne-mapping Excel → database

| Excel-kolonne | DB-felt |
|---|---|
| Symbol | `symbol` |
| Total PnL (USD) | `net_profit_usd` |
| Total PnL (%) | `net_profit_pct` |
| Max drawdown (USD) | `max_drawdown_usd` |
| Max drawdown (%) | `max_drawdown_pct` |
| Profit factor | `profit_factor` |
| Winrate (%) | `win_rate_pct` |
| Total trades | `num_trades` |
| Scan date (dd.mm.yyyy) | `test_date` (konverteres til `YYYY-MM-DD`) |

Faste verdier per import: `strategy_version` (velges i dialogen), `timeframe` (default `5m`), `extraction_source = 'manual'`, `sizing_assumption_source = 'default_backfill'`. `label` settes automatisk av eksisterende auto-labeling-motor (samme som "Auto-klassifiser" på manuell lagring).

## Duplikat-regel

Per rad: hvis det finnes en tidligere rad for samme `(symbol, strategy_version, test_date)` med *samme test_date* som Excel-raden → **hopp over, ingen skriving**. Nyere scan-dato lagres som ny rad (historikk beholdes, akkurat som i dag). Dette matcher dagens unike indeks `coin_backtest_results_soft_dedupe` og eksisterende manuell flyt.

## Tekniske detaljer

- Excel-parsing i browseren med `xlsx` (SheetJS) — ingen filopplasting til server, kun parsede rader sendes.
- Ny server-fn `bulkCreateBacktestResults` i `src/lib/calibration/calibration.functions.ts` som gjenbruker helpers: `withSizingDefaults`, `computeSizingDerived`, `loadClassificationThresholds`, `autoSuggestLabel`, `detectNeedsReview`. Selve INSERT-loopen kjøres én rad om gangen (600 coins ≈ 600 rader — helt uproblematisk) slik at én dårlig rad ikke stopper resten.
- Dedupe-sjekken gjøres med én `select symbol,test_date` opp front per bruker+strategy_version, ikke per rad.
- Ny komponent `src/components/calibration/ExcelImportDialog.tsx` med opplasting, preview-tabell og resultatrapport.
- Ingen migrasjon — ingen skjemaendringer.
- Ingenting endres i eksisterende manuell lagre-flyt.
