
## Tekstbasert analyse på `/analysis`

Formål: gi deg en lesbar oppsummering ("hva sier dataene?") i tillegg til tabeller og heatmaps. Alt genereres deterministisk klientside fra samme `AnalysisRow[]` — ingen LLM, ingen nye kall, ingen DB-endringer.

---

### Plassering

Ny "Insights"-boks øverst på `/analysis` (over de tre fanene), pluss en kortere per-fane oppsummering nederst i hver fane. Boksen kan kollapses.

```text
┌─────────────────────────────────────────────────────────┐
│  Filtre: strategy · timeframe · min_trades              │
├─────────────────────────────────────────────────────────┤
│  📋 Insights (auto-generert, 6–10 punkter)              │
│  • Datasettets størrelse & label-fordeling              │
│  • Top drivere (separation)                             │
│  • Sweet spots (segmenter)                              │
│  • Advarsler (skjevheter / lav n)                       │
├─────────────────────────────────────────────────────────┤
│  [ Drivers ]  [ Ranking ]  [ Segments ]                 │
└─────────────────────────────────────────────────────────┘
```

---

### Hvilke funn tas med

**1. Datasett-sammendrag (alltid)**
- Antall symboler inkludert / ekskludert, med grunn ("X ekskludert pga no_trades, Y pga needs_review").
- Label-fordeling: "12% profitable+, 23% profitable, 30% marginal, 35% rejected".
- Andel som mangler nøkkel-features (dekningsgrad), så du vet hvor mye vi kan stole på tallene.

**2. Topp drivere (Drivers-innsikt)**
- Topp 3 features rangert på |Cohen's d| mellom {profitable, profitable+} og rejected.
- For hver: retning + tallverdi, f.eks. *"`historical_trend_quality` skiller best (d=0.82): vinnere har median 0.71 vs. tapere 0.54."*
- Topp 3 Pearson-korrelasjoner mot `net_profit_pct` og `profit_factor` (med n og fortegn).

**3. Sweet spots (Segments-innsikt)**
- For hver kvartil-bucket-analyse: fremhev den bucket'en med høyest win-share ({profitable, profitable+} / n) hvis den er ≥1.5× datasettets baseline.
- Eks: *"Coins med `spread_bps` i Q1 (≤3.2 bps) har 42% win-share vs. 18% totalt — 2.3× løft."*
- Fra 2D-heatmap: hvis en celle har n≥5 og win-share ≥ 2× baseline, rapporter kombinasjonen.

**4. Anti-mønstre**
- Buckets med win-share = 0 og n ≥ 5 → "unngå-sone".
- Eks: *"`flips_per_day` Q4 (≥8.4): 0/12 vinnere — unngå høy-flip regime."*

**5. Ranking-innsikt (Ranking-tab)**
- Top-5 kandidater med score + hva som driver scoren ("dominert av PF" / "høy risk-adj").
- Advarsel hvis top-N er dominert av én label eller én timeframe (potensiell bias).

**6. Datakvalitets-advarsler**
- Features med <30% dekning → "for lite data, ekskluderes fra rangering".
- Skjevheter: hvis >70% av rader har `label=rejected`, si "strategien filtrerer aggressivt — vurder mildere terskler".
- Hvis kun én `strategy_version` finnes: "for sammenligning trengs flere versjoner".

**7. Konkrete anbefalinger (regelbaserte, ikke ML)**
Kombinerer topp drivere + sweet spots til én setning per driver:
- *"Prioriter symboler med HTQ > 0.65 OG spread_bps < 5 OG mtf_alignment_pct > 60 — 8 av 10 slike er profitable+."*
- Regelen genereres kun hvis den treffer ≥5 symboler og win-share ≥ 60%.

---

### Teknisk

- Ny fil `src/lib/analysis/insights.ts`: ren TS, tar `AnalysisRow[]` + `RankedRow[]` inn, returnerer `Insight[]` (`{severity: 'info'|'positive'|'warning', category, text}`).
- Ny komponent `src/components/analysis/InsightsPanel.tsx`: kollapsbart kort, grupperer insights etter kategori, bruker eksisterende badge/color-tokens.
- Wires inn i `src/routes/_app.analysis.tsx` — bruker allerede lastede rader, ingen ekstra fetch.
- Ingen endringer i `analysis.functions.ts`, `stats.ts` (utvides kun med små hjelpere hvis nødvendig, f.eks. `winShareBaseline`).

### Ute av scope
- Ingen LLM-oppsummering (det kan legges til senere hvis du vil ha "naturligere" tekst; da via Lovable AI server-fn).
- Ingen lagring av insights i DB — regenereres hver gang datasettet lastes.
- Ingen endringer i eksisterende faner ut over å vise en kort insight-linje relevant for fanen.

### Verifisering
- Insights matcher tallene i tabellene manuelt (sample-sjekk top driver + top segment).
- Ved 0 inkluderte rader vises "for lite data" i stedet for tomme punkter.
- Ingen NaN/Infinity i tekst.
