# Performance-side med regelbaserte sizing-tiers

## Problemet i dag

- `health_snapshots` (winrate, PF, net_profit) finnes i DB men vises **ingensteds** i UI.
- Sizing (`account_balance_percent`, `leverage`, SL, TSL) er **statisk** per symbol — den endrer seg ikke selv om strategien begynner å prestere dårligere.
- Helse-gates (`min_winrate`, `min_pf`, `min_net_profit`) finnes per *strategi*, ikke per *symbol*, og er kun pass/fail — du kan ikke si "winrate < 55 → halver størrelsen".

Du vil ha **både** globale regler (winrate-tiers, net_profit ≤ 0 stenger) **og** per-coin overrides.

## Løsning

### 1. Ny side `/performance`

Tabell med én rad per **(symbol × strategy × tag)** som har en snapshot:

| Symbol | Strategy/tag | Winrate | PF | Net profit | Effektiv % equity | Effektiv leverage | Status | Kilde | Edit |
|---|---|---|---|---|---|---|---|---|---|

- **Effektiv %/leverage** = det som faktisk vil bli brukt ved neste signal, beregnet fra reglene (eller override).
- **Kilde** viser hvor verdien kom fra: `tier:winrate≥70`, `override:PENGUUSDT`, eller `default`.
- **Status:** grønn (handler), rød (blokkert av gate), gul (mangler data / venter).

### 2. Globale sizing-regler (`sizing_rules`-tabell, ny)

Ordnet liste med betingelser → effekt. Evalueres top-down, første match vinner.

```text
Eksempel:
1. net_profit ≤ 0          → BLOCK
2. winrate ≥ 70            → balance_pct = 15
3. winrate ≥ 55            → balance_pct = 5
4. (default)               → balance_pct = symbol.account_balance_percent
```

Hver regel har:
- `priority` (sortering)
- `enabled`
- `condition` (jsonb: `{metric: "winrate", op: ">=", value: 70}` evt. AND-array)
- `action` (jsonb: `{block: true}` eller `{set: {account_balance_percent: 15, leverage: 10}}`)
- `label` (fritekst)

Redigeres på en egen "Rules"-fane på `/performance` — drag-and-drop for prioritet, "Add rule"-knapp.

### 3. Per-coin overrides

På samme `/performance`-side, "Edit"-drawer per rad:

- **Sizing override** (per (symbol, strategy, tag)): hvis satt, brukes i stedet for regelresultatet.
  - account_balance_percent, leverage, position_size_multiplier, max_notional, max_margin
- **Risk parameters** (per symbol): sl_pct, tsl_enabled, tsl_activation_profit_pct, tsl_callback_pct
- **Force block / force allow** (overstyrer reglenes BLOCK)

Ny tabell `symbol_strategy_overrides (symbol, strategy, tag, balance_pct, leverage, multiplier, max_notional, max_margin, force_state)` — alt nullable, kun satte felt overstyrer.

### 4. Evalueringskjede ved signal

I `executor.ts` / sizing-koden, ny helper `resolveSizing(symbol, strategy, tag)`:

```text
1. Hent siste health_snapshot (samme nøkkel som health-gate)
2. Hvis override.force_state = 'block' → BLOCK
3. Hvis override.force_state = 'allow' → bruk override-verdier (hopp over regler)
4. Evaluer sizing_rules top-down mot snapshot:
     - første matchende regel med {block:true}     → BLOCK
     - første matchende regel med {set:{...}}      → bruk dem som base
5. Override-felter som er satt overstyrer base
6. Resterende felter faller tilbake til symbols-raden
→ returner {balance_pct, leverage, multiplier, max_notional, max_margin, blocked, source}
```

`source` logges i `risk_decisions.metrics` så du i Signals-trailen ser nøyaktig hvilken regel som ga sizingen.

## DB-endringer (ny migrasjon)

```sql
create table public.sizing_rules (
  id uuid primary key default gen_random_uuid(),
  priority int not null,
  enabled boolean not null default true,
  label text not null,
  condition jsonb not null,
  action jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.symbol_strategy_overrides (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  strategy text not null,
  tag text not null default '',
  account_balance_percent numeric,
  leverage numeric,
  position_size_multiplier numeric,
  max_position_notional_usdt numeric,
  max_margin_usage_usdt numeric,
  force_state text check (force_state in ('block','allow')),
  unique (symbol, strategy, tag)
);
-- + RLS: operator manages både
```

## Endringer i kode

- **Ny migrasjon** for to tabellene over.
- **Ny:** `src/routes/_app.performance.tsx` — to faner: "Symbols" (radene) og "Rules".
- **Ny:** `src/components/RuleEditor.tsx`, `src/components/SizingOverrideDrawer.tsx`.
- **Ny:** `supabase/functions/_shared/sizing-resolver.ts` — `resolveSizing()`.
- **Endret:** `executor.ts` — bruk `resolveSizing()` i stedet for å lese `symbols`-raden direkte.
- **Endret:** sidebar — ny lenke "Performance".
- **Beholdes:** Symbols-siden (basisparametre) og Strategies-siden (gates), men det meste av daglig styring flytter til Performance.

## Spørsmål før implementering

1. **`net_profit`-blokk:** skal det være en *forhåndsdefinert* default-regel jeg seeder (`net_profit ≤ 0 → BLOCK`), eller skal du legge den inn selv via UI? Anbefaler seeded.
2. **Eksisterende `strategies.health_min_*`-gates:** behold parallelt (fungerer fortsatt som "hard floor"), eller migrer til regelmotoren og fjern? Anbefaler behold som baseline-floor.
3. **Tier-eksempelet "55–70 → 5%":** når winrate er nøyaktig 55, treffer den den tieren? (Antar `≥`, dvs. 55 = ja.) OK?
4. **Override-granularitet:** per (symbol, strategy, tag) som foreslått, eller bare per symbol? Per-tuple er kraftigere men mer å vedlikeholde.
