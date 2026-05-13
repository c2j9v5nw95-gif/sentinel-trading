## Problem

Tooltipen på `% equity`-cellene i Kontrollsenter og Symbols viser `rule:<label>` fra `sizing_rules.label`. To av reglene har labels som ikke lenger stemmer med `action.set`:

| priority | nåværende label | faktisk action.set |
|---|---|---|
| 20 | High winrate (≥70%) → **15% equity** | account_balance_percent: **40**, leverage: 10 |
| 30 | Medium winrate (≥55%) → **5% equity** | account_balance_percent: **15**, leverage: 10 |

RAVEUSDT (winrate 66,7%) treffer pri 30 → effektiv blir 15% (riktig), men tooltipen viser den gamle teksten "5% equity". Det er kun visuell forvirring — sizing-motoren bruker `action.set`, ikke labelen.

## Endring

Én migration som oppdaterer de to labels så de matcher faktisk action:

```sql
UPDATE public.sizing_rules
SET label = 'High winrate (≥70%) → 40% equity, 10x'
WHERE id = '9bc3c07c-a262-45c9-b1db-4a0d1ad742c1';

UPDATE public.sizing_rules
SET label = 'Medium winrate (≥55%) → 15% equity, 10x'
WHERE id = '3e85aef7-a231-4051-843d-c1541274308c';
```

Ingen kodeendringer. Ingen endring i sizing-logikken — kun tekst.

## Etter

- RAVEUSDT hover: `rule:Medium winrate (≥55%) → 15% equity, 10x` (matcher 15.0 i cellen).
- FIGHTUSDT/PIEVERSEUSDT/ZECUSDT hover: `rule:High winrate (≥70%) → 40% equity, 10x` (matcher 40.0).

## Ikke i scope

- Ingen endring i `Sizing rules`-fanen utover at labelen vises riktig der også (samme felt).
- Ingen endring i action-verdier — du har allerede satt 40/15 bevisst.
