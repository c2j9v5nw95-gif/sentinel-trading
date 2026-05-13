## Mål

Gjør disablede symboler i Symbols-tabellen visuelt tydelige — i dag står de bare med "—" i ON-kolonnen og er ellers identiske med aktive rader.

## Endring

Kun `src/routes/_app.symbols.tsx`, visnings-raden (linje 337-386). Ingen logikk-endringer.

1. **Dim hele raden** når `s.enabled === false`: legg til `opacity-50 grayscale` på `<tr>`. (Live-rødfarging fjernes for disablede så de ikke roper "LIVE" når de faktisk er av.)
   ```
   className={
     !s.enabled ? "opacity-50 grayscale" :
     isLive ? "bg-danger/10" : ""
   }
   ```

2. **Erstatt "—" i ON-kolonnen med en tydelig pille** når disabled:
   - Aktiv: grønn `✓`-pille (`border-success/40 bg-success/10 text-success`)
   - Disabled: muted "OFF"-pille (`border-border bg-muted text-muted-foreground uppercase`)

3. **Symbol-navnet** får `text-muted-foreground line-through` når disabled, slik at det er lesbart i en skanning at raden ikke er aktiv.

## Ikke i scope

- Ingen sortering/flytting av disablede til bunnen (kan legges til senere hvis ønsket).
- Ingen endring i edit/aktiver-flyt.
- Ingen endring av "Live default sizing on switch"-teksten i Sizing model (den sier fortsatt 5 — men auto-register-defaulten i backend er nå 40. Si fra hvis du vil at jeg oppdaterer den teksten samtidig).

## Verifisering

LABUSDT og PENGUUSDT skal i Symbols-listen vises dempet/grayscale, med gjennomstreket symbolnavn og en "OFF"-pille i ON-kolonnen. Aktive rader (BSB, FIGHT, RAVE, ZEC, PIEVERSE) ser ut som før.
