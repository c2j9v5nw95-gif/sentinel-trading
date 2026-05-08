# Per-Symbol Exposure Safety Caps

Hard safety limits that override all sizing formulas. If either cap would be exceeded, the trade is rejected and logged as a risk decision — never silently clamped.

## 1. Database (migration)

Add two nullable columns to `public.symbols`:

- `max_position_notional_usdt numeric NULL` — hard cap on estimated exposure (USDT notional)
- `max_margin_usage_usdt numeric NULL` — hard cap on margin allocated (USDT)

CHECK constraints: each must be `> 0` when set. NULL = no cap (uncapped).

No backfill — existing symbols stay NULL (uncapped) until the operator configures them.

## 2. Sizing module (`supabase/functions/_shared/sizing.ts`)

Extend `SymbolSizing` with the two optional caps. Extend `SizingBreakdown` with:

- `maxExposureUsdt: number | null`
- `maxMarginUsdt: number | null`
- `exposureCapExceeded: boolean`
- `marginCapExceeded: boolean`
- `capRejectionReason: string | null` (e.g. `"exposure 620.00 > cap 500.00"`)

`computeEntrySizing` continues to compute the formula-driven values, then evaluates the caps and sets the rejection fields. It does NOT clamp — clamping would silently shrink a trade the operator didn't authorize. Caller is responsible for blocking.

`validateSymbolSizing` additionally rejects non-positive caps (defense in depth alongside the DB CHECK).

## 3. execute-entry enforcement

Order of operations (updated):

1. Fetch fresh balance + ticker + symbol info.
2. `validateSymbolSizing` — abort on invalid config.
3. `computeEntrySizing` — produces breakdown including cap evaluation.
4. **NEW pre-flight gate:** if `exposureCapExceeded || marginCapExceeded`:
   - Insert `risk_decisions` row: `gate = 'exposure_limit'`, `outcome = 'block'`, `reason = capRejectionReason`, `metrics = { estimatedExposureUsdt, marginAllocatedUsdt, maxExposureUsdt, maxMarginUsdt, leverage, multiplier, accountBalancePercent, availableBalanceUsdt, markPrice }`, `signal_id` = current signal.
   - Mark signal `status = 'rejected'`, `decision_reason = capRejectionReason`.
   - Write `audit_log` entry `action = 'entry_rejected_exposure_cap'` with the same metrics.
   - Return without setting leverage or placing any order.
5. Otherwise proceed with set-leverage → market order → SL attach.

Enum check: `risk_decisions.gate` and `outcome` are USER-DEFINED enums. The migration must `ALTER TYPE` to add `'exposure_limit'` to the gate enum if not present (and confirm `'block'` exists on the outcome enum). I'll inspect current enum values in the migration and add only what's missing.

## 4. Dashboard

**Symbols page (`src/routes/_app.symbols.tsx`):** add two columns `Max Notional` and `Max Margin` (show `—` when NULL). Update the "Sizing model" card to document caps as hard overrides.

**Overview / Positions:** when an open position or recent entry attempt exists, show a small "Sizing snapshot" block per symbol with: available balance, margin allocated, leverage, multiplier, estimated exposure, estimated qty, max exposure cap, max margin cap. Cap rows turn red when the formula value would exceed the cap.

**Audit / Signals page:** rejected signals already render via `decision_reason`; surface `gate=exposure_limit` rejections with a red badge and expand to show the metrics JSON.

## 5. Out of scope

- No changes to exit sizing (caps are entry-only — exits use live Bybit position size).
- No retroactive cap enforcement on already-open positions.
- No global (cross-symbol) exposure cap in this pass; that's a separate `app_settings` change if requested later.

## Technical notes

- Caps are evaluated on the *formula* exposure (margin × leverage × multiplier), not on post-fill notional, so the gate runs before any Bybit call.
- Rejection is logged exactly once per signal even if `process-signal` retries; idempotency keyed on `signal_id`.
- All numerics compared with explicit `Number(...)` conversion since Postgres `numeric` returns strings via PostgREST.
