## Mål

Trygt switche fra paper til live trading på Bybit. Live-modusen har flere harde gates som må være grønne, både i UI og i edge-funksjonene. Denne planen er en **sjekkliste + flyt**, ikke en kode-endring (alt er allerede implementert).

## To måter å gå live på

1. **Globalt live** (`app_settings.live_enabled = true`) — alle symboler uten override går live.
2. **Per-symbol live** (`symbols.execution_mode_override = 'live'`) — anbefalt: behold global = paper, og sett kun PENGUUSDT til live i Symbols-siden. Andre symboler forblir trygt på paper.

Anbefaling: **start med per-symbol live på ÉN coin** med små caps, ikke globalt.

## Live-gates (alle må være grønne)

Dette er sjekket både i `liveExecutionGate` (edge) og i Settings-siden (UI):

| Gate | Hvor | Hvordan fikse |
|---|---|---|
| `BYBIT_LIVE_API_KEY` + `BYBIT_LIVE_API_SECRET` satt | Cloud secrets | Allerede satt ✅ |
| `app_settings.live_enabled = true` (kun for global) | Settings-side | Trykk "Live" radio + skriv `ENABLE LIVE` |
| `app_settings.emergency_stop = false` | Settings-side | Skal være av |
| `app_settings.live_risk_halted = false` | Live risk-banner | Skal være av |
| Ingen åpne kritiske invariant-violations | Invariants-side | Acknowledge alle åpne |
| Bybit live diagnostic OK siste 24t | Settings → "Test live connection" | Kjør test, alle read-only checks må være ✓ |
| (Per-symbol vei) `symbols.execution_mode_override = 'live'` | Symbols-side | Per-symbol mode-dropdown → live + skriv `ENABLE LIVE` |

I tillegg finnes en *risk breaker* som auto-pauser entries (men ikke exits) hvis:
- åpne posisjoner > `live_risk_max_open_positions` (default 1)
- total eksponering > `live_risk_max_total_exposure_pct` (default 50%)
- per-symbol eksponering > `live_risk_max_symbol_exposure_pct` (default 30%)
- urealisert drawdown > `live_risk_max_unrealized_drawdown_pct` (default 5%)
- daglig tap > `live_risk_max_daily_loss_pct` (default 5%)
- ≥ `live_risk_max_consecutive_losses` tap på rad (default 4)

## Anbefalt flyt (per-symbol live for PENGUUSDT)

1. **Verifiser API-nøkler**: gå til Settings → Bybit Diagnostics → "Run live test". Alle read-only checks skal være ✓ (account, balance, position read, order read). `safe_order_test` kan være rød — den krever at live allerede er på.
2. **Sjekk balanse**: live wallet skal vise faktisk saldo i USDT.
3. **Acknowledge alle kritiske invariants** hvis noen er åpne (Invariants-siden).
4. **Sett konservative caps på PENGUUSDT** før du flipper:
   - `account_balance_percent`: f.eks. 1–2 % (ikke standard 5)
   - `leverage`: f.eks. 3–5x (ikke 10)
   - `max_position_notional_usdt`: hard cap, f.eks. $50
   - `max_margin_usage_usdt`: hard cap, f.eks. $10
   - `sl_pct`: behold 1.5 (eller stramere)
5. **Bytt mode på PENGUUSDT-raden** i Symbols → `live`. Bekreft `ENABLE LIVE`-frasen. Systemet vil:
   - Sette `execution_mode_override = 'live'`
   - **Overskrive sizing til defaults** (`balance%=5, leverage=10, multiplier=1.0`) ⚠️
   - Du må deretter justere tilbake til de konservative verdiene fra steg 4 via Edit-knappen.
6. **Send én test-alert** fra TradingView. Sjekk Signals-siden:
   - Status skal bli `processed`
   - Decision trail skal vise `entry_submitted: pass` og `sl_armed: pass`
   - Telegram-varsel `live_entry` skal komme
7. **Verifiser på Bybit-app**: at posisjonen finnes, leverage er riktig, SL er satt.
8. **Følg med på exit**: når exit-alert kommer, sjekk at `exit_submitted: pass` og at posisjonen er flat på Bybit.

## Hva planen IKKE gjør

- Ingen kode-endringer — alt er allerede på plass.
- Endrer ikke risk-breaker-defaults (de kan strammes i Settings hvis ønsket).
- Skrur ikke på global live — kun per-symbol PENGUUSDT.

## Rekkefølge nå

Bekreft hvilken vei du vil gå (per-symbol vs. global), så veileder jeg deg gjennom punkt 4–5 med eksakte caps. Eller om du heller vil ha en **"go live"-wizard** som slår sammen disse stegene i én UI-flyt.
