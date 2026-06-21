# EquityCard: 90d/1y viser feil verdi pga. 1000-rad-grense

## Årsak
`EquityCard` henter `balance_snapshots` slik:
```ts
.gte("captured_at", since)
.order("captured_at", { ascending: true })
.limit(1000)
```

Balance-snapshots tas hyppig (sannsynligvis hvert minutt fra `analytics-snapshot-balances`). 90 dager × 1440 min = ~130 000 rader, langt over 1000-grensen. Med `ascending: true` + `limit(1000)` får du de **eldste** 1000 snapshotene i vinduet — fra perioden før kontoen ble fundet. Derfor:
- `last` = equity tidlig i vinduet (≈ 0 USDT før innskudd)
- `first` = enda tidligere (også ≈ 0)
- Resultat: "0,00 USDT, +0,00, 90d · 39d ago"

`27d ago` på 30d-kortet er samme symptom — `lastAt` peker på siste snapshot i de eldste 1000, ikke faktisk nyeste. På 30d traff vi tilfeldigvis nær toppen av dataene fordi det var færre rader; på 90d/1y bommer det grovt.

## Fiks
Bytt til to målrettede spørringer i stedet for én begrenset liste:

1. **Første snapshot i vinduet** (for delta-basis):
   `select(captured_at,total_equity).gte(captured_at, since).order(asc).limit(1)`
2. **Nyeste snapshot totalt** (for "last" + "lastAt"):
   `select(captured_at,total_equity).order(desc).limit(1)`
3. **Sparkline-data**: nedsamplet serie i vinduet. Enklest: hent nyeste N (f.eks. 500) med `order(desc).limit(500)`, reverser klientside. Det gir tett kurve i nylig tid; for lange vindu (90d/1y) tegner sparkline siste ~8 timer ved 1-min-snapshots — fortsatt en gyldig "trendlinje" og bedre enn nåværende oppførsel, men ikke en jevn fordeling over hele vinduet.

Hvis du vil ha en jevn fordeling over hele vinduet (anbefalt for 90d/1y), legger jeg til en `bucket`-basert downsampling: del vinduet i ~200 bøtter, hent én rad per bøtte via en PostgreSQL-funksjon (`distinct on (bucket)` eller `time_bucket` hvis tilgjengelig). Det krever en ny RPC.

## Forslag — to nivåer
- **A (rask, ingen DB-endring):** Bare fiks "siste verdi" + "første i vindu" med to limit(1)-queries. Sparkline viser nyeste 500 punkter (fin på 1h/24h/7d, "zoomet inn" på 90d/1y).
- **B (komplett):** A + ny RPC `equity_snapshots_bucketed(since, source, buckets)` for jevn sparkline over hele vinduet.

## Filer
- **A:** `src/components/overview/EquityCard.tsx` (omskriv `queryFn` + delta-beregning).
- **B:** I tillegg migrasjon for RPC + `.rpc("equity_snapshots_bucketed", ...)`-kall.

Hvilken vil du ha — A, eller B?
