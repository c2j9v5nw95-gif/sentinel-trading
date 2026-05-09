## Mål

Gjøre alle relevante parametre i Symbols-tabellen redigerbare direkte fra UI, slik at du slipper å gå via SQL/Cloud for å justere sizing, SL, TSL, TP og hard caps per symbol.

## Hva som skal kunne endres per rad

| Felt | Type | Validering |
|---|---|---|
| `enabled` | toggle (✓/—) | bool |
| `execution_mode_override` | dropdown (allerede gjort) | uendret, men live-bytte beholder eksisterende `ENABLE LIVE`-bekreftelse |
| `preferred_transport` | dropdown: `webhook` / `email` | enum |
| `account_balance_percent` | number input | 0–100 |
| `leverage` | number input | 1–100 |
| `position_size_multiplier` | number input | > 0 |
| `margin_mode` | dropdown: `isolated` / `cross` | enum |
| `sl_pct` | number input | > 0 |
| `tsl_enabled` | toggle | bool |
| `tsl_activation_profit_pct` | number input | ≥ 0 |
| `tsl_callback_pct` | number input | > 0 |
| `tp2_enabled` | toggle | bool |
| `tp1_exit_percent` | number input | 1–100 |
| `max_position_notional_usdt` | number input (tom = NULL) | ≥ 0 eller null |
| `max_margin_usage_usdt` | number input (tom = NULL) | ≥ 0 eller null |

## UX-mønster: inline edit + lagre per rad

For å holde det enkelt og trygt:

1. **Hver rad får en "Edit"-knapp** lengst til høyre. Klikker du, blir feltene i den raden til input/select/toggles. Andre rader er fortsatt read-only.
2. **Lokal draft state** holder endringene til du trykker **Save** (kaller én `update`-mutation mot `symbols` med diffen) eller **Cancel** (kaster draft).
3. **Live-bytte** håndteres som i dag via `ConfirmLiveDialog` med `ENABLE LIVE`-frase.
4. **Validering** før save: tall-felter må parse, grenseverdier sjekkes, ellers vises rød ramme + tooltip og knappen er disabled.
5. Etter save: `invalidateQueries(["symbols"])` så tabellen henter fersk state.

```text
SYMBOL    ON  MODE     TRANSPORT  BAL%  LEV  MULT  MARGIN     SL%  TSL ACT/CB  TP2  TP1%  MAX NOT  MAX MAR  ACTIONS
PENGUUSDT [✓] [paper▾] [webhook▾] [ 5 ] [10] [1.0] [isolated▾][1.5][1.0]/[0.5] [✓]  [100] [    ]   [    ]   [Save] [Cancel]
ZECUSDT    ✓  paper    webhook     5    10x  1     isolated   1.5  1.0/0.5     —    100   —        —        [Edit]
```

## Tekniske detaljer

- **Fil**: kun `src/routes/_app.symbols.tsx` endres. Tabellraden refaktoreres til en egen `<SymbolRow>`-komponent som tar `symbol` + `onSaved`-callback og holder sin egen draft state.
- **Mutation**: gjenbruker mønsteret fra `setOverride`-mutationen — én `useMutation` per rad er ikke nødvendig, en delt mutation som tar `{id, patch}` holder.
- **NULL-håndtering for hard caps**: tom input → `null` i patch. Vis placeholder `—`.
- **RLS**: `symbols`-tabellen har allerede `operator manages symbols` (ALL) policy, så `update` fungerer uten DB-endringer.
- **Ingen DB-migrasjon** og ingen edge-function-endringer trengs.

## Hva planen IKKE dekker

- Legge til/slette symboler (kan komme i en oppfølger med "+ Add symbol"-knapp).
- Bulk-edit av flere rader samtidig.
- Endringer i hvordan executoren leser disse feltene (uendret oppførsel).
