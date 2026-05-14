## Verdict

**The BSBUSDT failure happened BEFORE the Phase 1 deployment.**

| Event | Time (UTC, 2026-05-14) |
|---|---|
| BSBUSDT entry signal received | **18:45:06** |
| Order rejected (`bybit_10001:Qty invalid`) | **18:45:17** |
| Phase 1 migration timestamp `20260514190341` | **19:03:41** |
| Phase 1 edge-function deploy (executor/sizing/bybit-public/telegram) | shortly after 19:03 |

So this is **not a regression** — it is the same class of failure Phase 1 was designed to prevent. A replay AFTER Phase 1 will exercise the new fail-closed + bridge-cache + Telegram path.

## Evidence (signal `0c3010c8-2053-4207-9476-1208f6ce62cf`)

```text
signals
  symbol           BSBUSDT
  type/action      trade / ENTER-SHORT
  status           error
  decision_reason  order_submit_failed:bybit_10001:Qty invalid
  processed_at     18:45:19.771

risk_decisions
  18:45:09  gate=risk  outcome=pass  reason=all_gates_passed
  (no qty_zero / instrument_rules_unavailable entry — pre-Phase-1)

orders  (single row)
  status            rejected
  qty               1055.1842274282963   ← raw, unrounded float
  error_message     bybit_10001:Qty invalid
  request_payload   { qty: 1055.1842274282963, orderType: Market, side: Sell, ... }
  response_payload  null

system_alerts        (none in this window)
notification_events  (none in this window)
```

## Mapped to your checklist

| Field you asked for | Value found in trail |
|---|---|
| instrument_rules step | **not logged** — pre-Phase-1 executor didn't record `instrument_rules_unavailable` |
| qtyStep | **not logged / null** — bridge `fetchInstrumentRules` failed silently, no field stored |
| raw qty | `1055.1842274282963` (in `orders.qty` and `orders.request_payload.qty`) |
| rounded qty | **none** — `roundDownStep` was a no-op because qtyStep was null |
| attempted_qty | `1055.1842274282963` (sent verbatim to Bybit) |
| requireQtyStep=true | **N/A pre-Phase-1** — flag did not exist yet |
| Telegram / system_alert for `order_submit_failed` | **NOT created** (0 rows in `system_alerts` and `notification_events` for that window) — exactly the blind-spot Phase 1 closes |

## What to expect when you replay AFTER Phase 1

If `fetchInstrumentRules` succeeds (memory-cache or direct fallback now wired):
- `qtyStep` resolved → raw `1055.184…` rounded down to a valid step → order accepted (or rejected on a different reason, but visibly so).
- `decision_trail` will include the rounded qty.

If `fetchInstrumentRules` still returns null:
- Executor fail-closes BEFORE submit.
- `risk_decisions` row with `reason=instrument_rules_unavailable`.
- `system_alerts` row, severity `critical`, category `order_submit_failed`.
- `notification_events` row dispatched to Telegram (category now in `enabled_categories`).
- `signals.decision_reason = order_submit_failed:instrument_rules_unavailable`.
- `orders` row with `status=rejected`, `qty=0`, `attempted_qty` recorded in `request_payload`.

## Recommendation

Safe to replay. Either path is now observable end-to-end. If you want, I can pre-warm the instrument-rules cache for `BSBUSDT` via `op-bridge-smoke` or a one-off direct fetch before you hit Replay — say the word and I'll plan that as a follow-up.
