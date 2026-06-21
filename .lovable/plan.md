# Lengre tidsrom på Overview-filteret

## Endring
Utvid `RangeKey` fra `1h | 24h | 7d` til `1h | 24h | 7d | 30d | 90d | 1y`, og legg dem til som knapper i `OverviewFilterBar`.

## Filer
- `src/components/overview/filters.ts` — utvid `RangeKey`-unionen, `RANGE_LABEL` (`30d`, `90d`, `1y`) og `RANGE_MS` med tilsvarende millisekunder (1y = 365 dager).
- `src/components/overview/OverviewFilterBar.tsx` — utvid `RANGES`-arrayen med de nye nøklene; knapperaden får automatisk de nye valgene.

## Ikke i scope
- Endringer i query-logikken i kortene (de bruker allerede `rangeSinceISO(range)` og tåler vilkårlige tidsrom).
- Persistere valgt range mellom besøk (kan tas senere hvis ønsket).
- Den separate "today (Oslo)" og "24h"-cardene — de har egne, faste vinduer som ikke skal styres av filteret.
