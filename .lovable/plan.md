## Mål

Forbedre Telegram-meldingene slik at du:
1. Får en **bekreftet entry-melding** som viser at SL faktisk er satt på Bybit (med pris og %), og hvilken TSL-konfig som vil aktiveres senere.
2. Får en **avsluttende minirapport** når en posisjon stenges — med PnL i USDT og %, hva som avsluttet trade, holdetid, entry/exit-pris osv.
3. Får faktisk Telegram-melding også når SL eller TSL trigger via `protection-monitor` (i dag: helt stille).

Strengt kun varsel-/notifikasjons-laget. **Ingen endringer i** dispatcher, executor-flyten, ordre-routing, sizing, risk engine eller bridge.

---

## Endringer

### 1. `supabase/functions/_shared/telegram.ts` — rikere melding

Utvid `AlertPayload` med valgfrie felter:
- `entry_price`, `exit_price`
- `pnl_pct` (PnL i % av notional)
- `hold_seconds` (varighet)
- `sl_price`, `sl_pct`, `tsl_enabled`, `tsl_activation_pct`, `tsl_callback_pct`
- `confirmed_by_venue: boolean` (entry-bekreftelse)

Oppdater `buildMessage()` slik at:
- For `live_entry`: viser entry pris + qty + leverage + exposure + en "Protection"-blokk med `SL @ <pris> (-<sl_pct>%) ✅ confirmed` og `TSL: aktiveres ved +<X>%, callback <Y>%`. Hvis `confirmed_by_venue=false` → vis ⚠️ i stedet.
- For `tp_hit`/`sl_hit`/`live_exit`: rendres som en **mini-rapport**:
  ```
  ✅ EXIT — PENGUUSDT LONG
  Reason: TP1 hit
  Entry: 0.01234 → Exit: 0.01290
  Qty: 1234.5 (50% closed)
  PnL: +6.91 USDT (+4.55%)
  Hold: 2m 14s
  ```
  Tegn (✅/❌) basert på `pnl ≥ 0`.

Ingen endringer i gating (rate limit / dedupe / severity beholdes).

### 2. `supabase/functions/_shared/executor.ts` — entry & exit

**Entry (`executeEntry`):**
- Flytt `notify({ category: "live_entry" })` slik at den sendes **etter** at SL er forsøkt satt (ikke før).
- Inkluder i payload: `entry_price`, `sl_price`, `sl_pct`, `tsl_enabled`, `tsl_activation_pct`, `tsl_callback_pct`, `confirmed_by_venue: true`.
- Hvis SL feiler og auto-close-pathen kjører: `unprotected_position`-meldingen finnes allerede — uendret.

**Exit (`executeExit`):**
- I `notify({ category: tp_hit | sl_hit | live_exit })` (rundt linje 532), legg til:
  - `entry_price = posRow.entry_price`
  - `exit_price = fillPrice`
  - `pnl` (finnes), `pnl_pct = pnl / (entry_price * filledQty) * 100`
  - `hold_seconds = (now - posRow.opened_at) / 1000`
  - `qty = fill.filledQty`, `leverage = posRow.leverage`
  - Bedre `reason`-streng (f.eks. "TP1 hit", "TP2 (rest) hit", "SL failsafe", "Manual exit").

### 3. `supabase/functions/protection-monitor/index.ts` — TSL/SL-stille-exit

I `closeAtMarket()`, etter vellykket fyll og DB-update:
- Beregn `pnl` og `pnl_pct` (samme formel som executor).
- Kall `notify({ category: reason === "sl" ? "sl_hit" : "tsl_update" /* eller ny "tsl_hit" via live_exit */ })` med samme rike payload som exit-rapporten.
- Bruk **eksisterende kategorier** (`sl_hit`, `tp_hit`, `live_exit`) — ingen DB-/enum-endringer. TSL-trigger rapporteres som `live_exit` med `reason: "TSL hit"` for å unngå å innføre ny kategori.

Kun for `mode !== "paper"`, som ellers i koden.

---

## Hva som IKKE endres

- Ingen endring i `signals`, `positions`, `orders`, `notification_settings` schema.
- Ingen endring i hvilke kategorier som er aktivert by default.
- Ingen endring i rate limit / dedupe.
- Ingen endring i dispatcher, sizing, risk-engine, bridge eller live execution-pathen.
- `paper_wallet`-oppdatering uendret.

---

## Eksempel — slik vil neste PENGUUSDT-trade se ut på Telegram

**Entry (etter at SL er bekreftet på Bybit):**
```
ℹ️ LIVE_ENTRY [WARNING]
Symbol: PENGUUSDT LONG
Leverage: 10x · Qty: 1234.5 · Entry: 0.01234
Exposure: 152.34 USDT

Protection ✅
SL @ 0.01215 (−1.50%) confirmed
TSL: arms at +1.0% profit, 0.5% callback
```

**Exit:**
```
✅ TP_HIT — PENGUUSDT LONG
Reason: TP1 hit (50% closed)
Entry: 0.01234 → Exit: 0.01290
Qty: 617.2
PnL: +3.46 USDT (+2.80%)
Hold: 2m 14s
```

---

## Risiko / forbehold

- Entry-meldingen sendes nå ~100–500 ms senere (etter SL-bekreftelse). Det er fortsatt umiddelbart i menneskelig tidsskala.
- TSL-trigger som tidligere var stille på Telegram blir nå hørbar — det vil si flere meldinger ved aktiv handel. Hvis det blir for mye, kan vi senere legge til en egen toggle.
- Rate limit på 60 s gjelder fortsatt — entry og exit som kommer innen 60 s av hverandre kan fortsatt bli kollapset. Du har sagt du øker TV-timeframe, så dette skal ikke være et problem i praksis.
