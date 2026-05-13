
## Mål

Gjøre helse-gaten faktisk operativ slik at entry-signaler for ZECUSDT og BSBUSDT blokkeres når deres siste `HEALTH_ALL`-snapshot er under terskel (PF, winrate, net profit). Andre symboler påvirkes bare hvis deres egen helse er dårlig.

## Bakgrunn (kort)

- TradingView sender helse som `(symbol, HEALTH_ALL, '')` til `health_snapshots`.
- Entry-signaler kommer som `(symbol, ES1/EL1/XS1/XL1, STRAT2)`.
- Nåværende `evaluateHealth` matcher snapshot og terskel på signalets eget `(strategy, tag)` — som aldri finnes for entries → alltid `no_thresholds` → alltid pass.
- Konsekvens: helse-gaten har vært en no-op i produksjon.

## Endringer

### 1. Endre helse-gaten til å bruke HEALTH_ALL per symbol

Fil: `supabase/functions/_shared/health-gate.ts`

- Slå opp `strategies`-rad for `(name='HEALTH_ALL', tag='')` for å hente terskler (`health_min_winrate`, `health_min_profit_factor`, `health_min_net_profit`).
- Slå opp siste `health_snapshots`-rad for `(symbol, strategy='HEALTH_ALL', tag='')` (uavhengig av signalets strategi).
- Behold dagens semantikk:
  - Ingen terskler satt → `pass`, `reason='no_thresholds'`.
  - Ingen snapshot → `pass`, `reason='no_health_data'` (advar, ikke blokker første gang).
  - Brutt terskel → `fail` med konkret reason (`winrate_below_threshold` osv.).
- Behold `strategy_disabled`-sjekken, men flytt den til å se på `HEALTH_ALL`-raden (eller fjern hvis det ikke gir mening — `HEALTH_ALL` skal nok alltid være enabled).
- Inkluder `symbol`, `applied_strategy='HEALTH_ALL'`, snapshot-tuple og terskler i `metrics` slik at decision_trail blir lesbar.

Ingen endring i `dispatcher.ts` er nødvendig — den kaller fortsatt `evaluateHealth({ symbol, strategy, tag })`, gaten ignorerer bare strategy/tag internt.

### 2. Sett terskler på HEALTH_ALL-strategien

Data-fix via insert-tool (UPDATE):

```
UPDATE strategies
   SET health_min_profit_factor = 1.0,
       health_min_net_profit    = 0,
       updated_at = now()
 WHERE name = 'HEALTH_ALL' AND tag = '';
```

Begrunnelse: PF ≥ 1.0 og net_profit ≥ 0 er en minimal "ikke tap penger systematisk"-grense. Winrate står åpen siden lav winrate kan være OK ved høy PF. Terskler kan justeres etterpå i Strategies-UI.

Effekt umiddelbart:
- ZECUSDT (PF 0.36, net −11) → blokkert med `profit_factor_below_threshold`.
- BSBUSDT (PF 0.34, net −56) → blokkert.
- Andre symboler: hvis deres `HEALTH_ALL`-snapshot har PF ≥ 1 og net ≥ 0 → trader som før. Hvis de har dårlig helse, blir de også blokkert (det er hele poenget).

### 3. (Valgfritt, ikke i denne planen)

Per-symbol override av terskler via `symbol_strategy_overrides` ville krevet nye kolonner — utelater. Dagens UI på `/strategies` lar oss allerede sette HEALTH_ALL-terskler globalt, og det er nok som første steg.

## Verifisering

- Etter endring: send et test-entry på ZEC eller BSB (eller vent på neste live). I `signals.decision_trail` skal `health_gate` ha `outcome='fail'` og `reason='profit_factor_below_threshold'` (eller `net_profit_below_threshold`), og signalet skal være `status='rejected'` med `decision_reason='health:profit_factor_below_threshold'`.
- Sjekk at minst ett annet symbol (f.eks. PENGUUSDT) fortsatt får `health_gate=pass` hvis dens snapshot er sunn.
- Visuelt i Signals-tabellen: ZEC/BSB-entries skal nå gå til "rejected (health)".

## Det jeg IKKE gjør

- Ingen endring i `executor.ts`, `sizing.ts`, `dispatcher.ts`, risk-engine, bridge.
- Ingen schemaendring.
- Ingen endring av `HEALTH_ALL`-snapshot-flyt (TradingView fortsetter uendret).
- Andre symbolers oppførsel endres bare hvis deres egen helse faktisk er under terskel — som er ønsket.
