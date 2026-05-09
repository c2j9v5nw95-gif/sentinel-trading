# Kontrollsenter: rename + collapse + add-symbol

## Endring 1 — Rename "Performance" → "Kontrollsenter"

- Rute: `/_app/performance` → `/_app/kontrollsenter`
- Sidemeny-label: "Performance" → "Kontrollsenter"
- Sidetittel + beskrivelse oppdateres
- Filnavn: `src/routes/_app.performance.tsx` → `src/routes/_app.kontrollsenter.tsx`

(TanStack Router regenererer routeTree automatisk.)

## Endring 2 — Én rad per ticker (kollaps)

I dag: én rad per (symbol × strategy × tag) — gir duplikater når H_SHORT/H_LONG kommer i tillegg til HEALTH_ALL.

Ny logikk i `SymbolsTab`:

1. Spør `health_snapshots` som før, sortert nyeste først.
2. **Foretrukket strategi:** velg **siste snapshot der `strategy = 'HEALTH_ALL'`** for hvert symbol.
3. **Fallback:** hvis et symbol *aldri* har sendt HEALTH_ALL, bruk siste snapshot uansett strategi (så ingenting forsvinner stille).
4. Vis en liten "via heartbeat" / "via H_SHORT"-tag i strategi-kolonnen så du ser hvor tallene kom fra.
5. Kolonne "Strategy / tag" omdøpes til "Kilde" i rad-konteksten (heartbeat / annet) — egen "Kilde"-kolonne for sizing-source flyttes til drawer-en (frigjør plass).

**Sizing-resolveren rør ikke** — den slår fortsatt opp per (symbol, strategy, tag) når et faktisk handelssignal kommer inn, så per-strategi-data går ikke tapt. Det er bare visningen som forenkles.

## Endring 3 — "Add symbol"-knapp inline

På rader hvor `kilde = "no symbol"`:

- Erstatt "Edit"-knappen med **"+ Add symbol"** (samme plass).
- Klikk → modal som forhåndsutfyller `symbol` (read-only) og defaults:
  - `enabled: true`
  - `account_balance_percent: 5`, `leverage: 10`, `position_size_multiplier: 1.0`
  - `sl_pct: 1.5`, `tsl_enabled: true`, `tsl_activation_profit_pct: 1.0`, `tsl_callback_pct: 0.5`
  - `max_position_notional_usdt`, `max_margin_usage_usdt` tom (ingen cap)
  - `execution_mode_override: null` (arve global)
- Bruker kan justere før Lagre, eller Lagre rett som er.
- Etter lagring: rad-en oppdaterer seg automatisk (queryClient invalidate `["symbols-perf"]`), og "Edit"-knappen vises i stedet.

Modal-komponenten gjenbrukes som `<AddSymbolModal>` — enkel form med samme `<Field>`-helper som allerede finnes i fila.

## Hva endres i kode

- **Endret/omdøpt:** `src/routes/_app.performance.tsx` → `src/routes/_app.kontrollsenter.tsx`
  - Kollaps-logikk i `SymbolsTab`-queryen
  - Conditional render: "+ Add symbol" på no-symbol rader
  - Ny `AddSymbolModal`-komponent i samme fil
  - Header-tekst oppdatert
- **Endret:** `src/components/AppLayout.tsx`
  - Nav-entry `to: "/performance"` → `to: "/kontrollsenter"`, label "Kontrollsenter"
- **Auto:** `src/routeTree.gen.ts` regenereres av router-pluginen

## Spørsmål før implementering

Ingen — alle valgene er tatt. Kjører.
