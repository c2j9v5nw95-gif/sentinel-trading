
# Label Review Support — Diagnose + Safe Batch Recompute

Mål: hjelpe deg fullføre Label Review før Fase A. To leveranser, i rekkefølge.
Ingen endringer i execution-stacken, ingen endringer i kalibreringsvekter, ingen endringer i bestående confirmed labels eller TradingView-tall.

---

## Leveranse 1 — Read-only Diagnose Report

### Plassering
Nytt panel øverst på `/calibration` (kollapsbart, default åpent): **"Label Health Diagnostics"**.

### Data
En ny server-function `getLabelDiagnostics` (`requireSupabaseAuth`, GET) som kjører ett enkelt aggregert SQL-spørring mot `coin_backtest_results` og returnerer:

1. **Distribusjon — confirmed label**: antall rader per `label` (alle 5 verdier inkl. `no_trades`).
2. **Distribusjon — auto-suggested label**: antall rader per `auto_suggested_label`.
3. **Disagreement matrix**: antall rader der `label != auto_suggested_label`, brutt ned per `(confirmed, suggested)`-par.
4. **No-trades count**: `count(*) where num_trades = 0`.
5. **Review-status**: `count(*) where needs_review = true`, fordelt på `label_source` (`auto` vs `manual_override`).
6. **kNN exclusion breakdown** — speiler eksakt filteret i `run-inline.server.ts`:
   - excluded: `label = 'no_trades'`
   - excluded: `needs_review = true AND label_source = 'auto'`
   - included: alt annet
   - viser også included-tallet per `label`.
7. **Per strategy_version**: antall rader, fordelt per `label`.
8. **Mistenkelige rader** (4 separate counts + topp-10 liste per kategori):
   - `marginal` / `rejected_backtest` med `net_profit_pct > 0`
   - `marginal` / `rejected_backtest` med `profit_factor > 1`
   - `marginal` / `rejected_backtest` med `win_rate_pct >= 50`
   - rader merket `marginal` / `rejected_backtest` men hvor ny `autoSuggestLabel` ville foreslått `profitable` eller `profitable_plus` (krever client-side recompute fra screener_snapshot + sizing-derived fields — kjøres i samme server-function, kun lesing).

### UI
- Tall vises i compact grid (samme stil som eksisterende dashboard-kort).
- Hver mistenkelig kategori har en "Vis rader"-knapp som åpner et drawer med symbolene, test_date, label, suggested og knapp som linker til allerede eksisterende Label Review-modal.
- "Eksporter CSV" for hver tabell (client-side).
- Read-only. Ingen mutasjoner.

---

## Leveranse 2 — Safe Batch Recompute

### Plassering
Egen seksjon under Diagnostics: **"Recompute auto-suggested labels"**.

### Sekvens (alltid 2 trinn — aldri direkte skriv)

**Trinn A — Dry-run preview (default, ingen skrive-effekt):**
Ny server-function `recomputeAutoLabels({ dry_run: true, strategy_version?: string, only_unreviewed?: boolean })`:
1. Henter alle (eller filtrerte) rader inkl. screener_snapshot, sizing-felter og bestående TradingView-tall.
2. For hver rad: kjør `withSizingDefaults` → `computeSizingDerived` → `autoSuggestLabel` med gjeldende thresholds fra `app_settings`.
3. Returner per rad: `id, symbol, test_date, confirmed_label, current_auto, new_auto, new_quality_score, new_reason_codes, will_set_needs_review (boolean), changed (boolean)`.
4. UI viser summary (X endringer av Y rader, fordelt på label-shift) + tabell med diff per rad + filter (kun endrede / kun no_trades-korreksjoner / etc.).

**Trinn B — Commit (krever eksplisitt knapp + bekreftelses-modal):**
Samme server-function med `dry_run: false`. Skriver KUN følgende kolonner:
- `auto_suggested_label`
- `backtest_quality_score`
- `classification_reason_codes`
- `classification_diagnostics` (positive/negative_drivers, safety_overrides, summary)
- `classification_config_version`
- `needs_review = true` HVIS `confirmed_label != new_auto_suggested_label` OG `label_source != 'manual_override'`

Hardkodede garantier:
- Aldri rør `label` (confirmed)
- Aldri rør `label_source` (manual_override beskyttes 100%)
- Aldri rør TradingView-tall (`net_profit_pct`, `max_drawdown_pct`, `num_trades`, etc.)
- Aldri rør `screener_snapshot`
- `num_trades = 0` → `auto_suggested_label` settes alltid til `no_trades` (allerede slik `autoSuggestLabel` er implementert; vi legger en assertion i tillegg for å fail-fast hvis det noensinne skulle drifte)
- Rader med `label_source = 'manual_override'` får aldri `needs_review = true` automatisk fra denne recompute-jobben

### Audit
Hver commit-kjøring skriver én rad til `audit_log` (action: `label_recompute_batch`) med summary av endringene (antall per label-shift, filter brukt, hvem som kjørte).

---

## Teknisk plan (kort)

### Filer
- `src/lib/calibration/label-diagnostics.functions.ts` — `getLabelDiagnostics`, `recomputeAutoLabels`. Begge `requireSupabaseAuth` + role-check (`has_role(auth.uid(), 'operator')`).
- `src/components/calibration/LabelDiagnosticsPanel.tsx` — UI for Leveranse 1.
- `src/components/calibration/BatchRecomputeSection.tsx` — UI for Leveranse 2 (dry-run preview + commit modal).
- `src/routes/_app.calibration.tsx` — monter de to nye komponentene over eksisterende tabell.

### Database
Ingen migration. Alle felt finnes allerede (`auto_suggested_label`, `backtest_quality_score`, `classification_reason_codes`, `classification_diagnostics`, `classification_config_version`, `needs_review`, `label_source`).

### Hva som IKKE endres
- Ingen endring i `scoring.ts` (autoSuggestLabel-logikk)
- Ingen endring i `run-inline.server.ts` (kalibrerings-pipelinen)
- Ingen endring i `app_settings`-thresholds
- Ingen endring i kNN-vekter, k, half_life, confidence-grenser
- Ingen endring i execution, dispatcher, sizing, risk
- Ingen Fase A (feature importance) eller Fase C (Tradable Top-N) — venter til du har bekreftet label-kvaliteten

---

## Akseptkriterier

1. Diagnose-panelet viser alle 8 tellinger og oppdateres når jeg endrer en label manuelt.
2. Dry-run på recompute viser nøyaktig diff uten å skrive til DB.
3. Commit endrer kun de 6 listede kolonnene, beviselig via før/etter-sammenligning av en rad med `label_source = 'manual_override'` (skal være uendret bortsett fra `auto_suggested_label` / quality / diagnostics — `label` og `needs_review` skal forbli som de var).
4. Etter commit: rader med `num_trades = 0` har `auto_suggested_label = 'no_trades'`.
5. `audit_log` har én rad per commit-kjøring med oppsummering.
