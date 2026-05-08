
# Paper Execution Mode — Design

A simulation layer that exercises the full Phase 3 execution state machine without touching Bybit. Same code paths, same tables, same decision trails — only the side-effecting Bybit client is swapped for a deterministic simulator.

---

## 1. Principles

1. **One pipeline, two backends.** `_shared/bybit.ts` becomes an interface; `LiveBybitClient` and `PaperBybitClient` implement it. The executor never branches on mode — it just calls the resolved client.
2. **Mode resolved per signal/job at dispatch time** (global flag + per-symbol override), then frozen onto the order/position rows so historical data stays unambiguous even if mode changes later.
3. **Paper writes use the same tables** — `orders`, `positions`, `position_events`, `risk_decisions`, `audit_log`, `signals.decision_trail`, `execution_jobs`, `bybit_executions`. Discrimination is by an `execution_mode` column, never by separate tables.
4. **No silent crossover.** A live order can never be reconciled against paper state, and vice versa — every Bybit-bound call carries the mode and the wrong-mode client refuses to act.

---

## 2. Schema (planned, not yet migrated)

### 2.1 New enum
- `execution_mode` ∈ (`live`, `paper`).

### 2.2 `app_settings`
- `paper_mode_enabled boolean default true` — global default while validating.
- `paper_starting_balance_usdt numeric default 10000` — virtual wallet for sizing.
- `paper_fee_bps numeric default 5.5` — taker fee simulated on fills.
- `paper_slippage_bps numeric default 2` — applied to market fills.
- `paper_fill_latency_ms int default 250`.

### 2.3 `symbols`
- `execution_mode_override execution_mode null` — per-symbol force (`paper`, `live`, or null = use global).

### 2.4 `orders`, `positions`, `execution_jobs`, `bybit_executions`
- Add `execution_mode execution_mode not null default 'paper'` to each.
- Index `(execution_mode, status)` on `orders` and `execution_jobs` (workers filter by mode).

### 2.5 New tables
- `paper_wallet` — single-row virtual account: `balance_usdt`, `equity_usdt`, `realized_pnl`, `unrealized_pnl`, `updated_at`. Reset button in Operator UI.
- `paper_market_prices` — last known price per symbol used for simulated fills, fed by either (a) periodic Bybit *public* ticker pulls (no auth, no orders) or (b) the price embedded in the incoming signal payload. `(symbol, price, source, received_at)`.

All new columns/tables RLS-locked to `operator`; writes via service role.

---

## 3. Mode Resolution

```text
resolveMode(symbol):
  if symbols.execution_mode_override is not null → use it
  else if app_settings.paper_mode_enabled → 'paper'
  else → 'live'
```

Resolved once at:
- Signal dispatch — written into `signals.decision_trail` as a `mode_resolved` step.
- Job creation — stamped on `execution_jobs.execution_mode`.
- Order/position creation — stamped on the row.

Mode is **immutable per row** after creation. Reconciler and protection monitor read mode off the row, not off settings.

---

## 4. Client Interface

`_shared/bybit-client.ts`:

```ts
interface BybitClient {
  mode: 'live' | 'paper'
  getPosition(symbol): Promise<PositionSnapshot>
  getOpenOrders(symbol): Promise<OrderSnapshot[]>
  getExecutions(symbol, since): Promise<ExecutionSnapshot[]>
  getWalletBalance(): Promise<WalletSnapshot>
  setLeverage(symbol, lev): Promise<void>
  switchIsolated(symbol, isolated): Promise<void>
  switchPositionMode(symbol, mode): Promise<void>
  submitOrder(req): Promise<SubmitResult>
  cancelOrder(symbol, orderLinkId): Promise<void>
  setTradingStop(req): Promise<void>          // SL/TSL/TP via /position/trading-stop
  getInstrument(symbol): Promise<InstrumentInfo>
}
```

Both `LiveBybitClient` and `PaperBybitClient` implement this exactly. The factory `getClient(mode)` returns the right one. Executor code is mode-agnostic.

---

## 5. PaperBybitClient — Behavior

### 5.1 State
Backed entirely by Postgres (no in-memory state — survives restarts):
- `paper_wallet` for balance/equity.
- `orders` (rows with `execution_mode='paper'`) for open orders.
- `positions` (rows with `execution_mode='paper'`) for current size.
- `bybit_executions` for synthetic fills.
- `paper_market_prices` for last price.

### 5.2 Pricing
- Read latest `paper_market_prices.price` for the symbol.
- If absent or older than 60s, fall back to the signal payload's `price` field (TradingView always sends one).
- If still absent → return order to `unknown` and raise alert. We do not invent prices.

### 5.3 Order simulation
- `submitOrder` (market, IOC, including reduce-only):
  1. Insert `orders` row `submitted` → simulate `paper_fill_latency_ms` (write `next_run_at` for the executor poll, no real sleep on the request path).
  2. On the next executor tick, fill at `last_price * (1 ± slippage_bps)` (sign = adverse to taker).
  3. Compute fee = `notional * fee_bps`. Deduct from wallet.
  4. Insert synthetic `bybit_executions` row (`exec_id = 'paper:' || order_link_id || ':' || attempt`).
  5. Update `orders` → `filled`, `filled_qty`, `avg_fill_price`.
  6. Apply position delta in `positions` (open/extend/reduce/close).
- `submitOrder` (limit, GTC) — out of scope for paper unless used by SL/TSL (see 5.4).
- `cancelOrder` — flips status to `cancelled`; no fee.

### 5.4 Trading-stop simulation (SL/TSL)
- `setTradingStop` writes the SL/TSL params onto the `positions` row (existing columns: `sl_price`, `tsl_active`, etc.) and inserts a synthetic `orders` row with `purpose='stop_loss'` / `'trailing_stop'`, `status='submitted'`, `reduce_only=true`.
- A periodic paper-tick (cron, see §7) re-evaluates each open paper position against the latest `paper_market_prices`:
  - If price crosses `sl_price` → simulate market reduce-only fill at SL price (no slippage; SL behaves as triggered market — optional tunable).
  - If TSL active → maintain trailing high/low (`positions.reconcile_drift` jsonb stores trail anchor) and trigger when callback breached.
  - On trigger: same fill path as §5.3, position transitions `closing → closed`.

### 5.5 Reads
- `getPosition`, `getOpenOrders`, `getExecutions`, `getWalletBalance` are straight DB reads filtered by `execution_mode='paper'`.

### 5.6 Account-config calls
- `setLeverage`, `switchIsolated`, `switchPositionMode` are no-ops that succeed and log to `audit_log` with `action='paper_account_config'` so the trail step still records.

---

## 6. Executor Integration

No FSM changes from Phase 3. The only edits are:

1. Job creation reads `resolveMode(symbol)` and stamps `execution_jobs.execution_mode`.
2. Job handler instantiates `getClient(job.execution_mode)`.
3. Reconciliation loop runs **two passes**: one for `live` rows, one for `paper` rows, each with its own client. Cross-mode joins are forbidden.
4. Sizing (`_shared/sizing.ts`) reads wallet from `client.getWalletBalance()` — paper returns the virtual wallet, so identical formulas apply with no branching.
5. Risk engine, Health Gate, exposure caps, decision trail — unchanged. The trail just gains one extra step `mode_resolved:{paper|live}`.

---

## 7. Paper Tick & Price Feed

Two cron hooks (`/api/public/hooks/paper-tick`, `/api/public/hooks/paper-prices`):

- **paper-prices** (every 5s): pulls `/v5/market/tickers` (public, no auth) for every symbol with paper activity in the last 24h, upserts `paper_market_prices`. Falls back to disabled if rate-limited.
- **paper-tick** (every 2s): for each open paper position, evaluates SL/TSL trigger logic, advances any `submitted` paper orders past their fill latency, updates wallet equity, writes `position_events`. This is the simulator's "engine".

Both hooks are mode-scoped — they ignore `live` rows entirely.

---

## 8. Replay Compatibility

`replay_signal()` already clones a signal back to `queued`. It needs no changes — the replayed signal goes through dispatch, dispatch resolves mode at *replay time*, and the trail records that. Operators can therefore:
- Replay a historical live signal in paper mode (flip global flag first), or
- Replay a historical paper signal in live mode after validation.

UI: replay dialog gains a read-only line "Will execute in: **paper** (global default)" so operators see the resolved mode before confirming.

---

## 9. Dashboard Surfacing

All existing pages get a mode filter and badge — no new pages required:

- **Header**: persistent badge `PAPER MODE` (amber) or `LIVE` (green) reflecting global setting; tooltip lists per-symbol overrides.
- **Signals table**: new `Mode` column (paper/live chip). Filter dropdown.
- **Positions table**: same chip + filter; paper and live sections visually grouped (or filtered).
- **Orders table**: same.
- **Symbols page**: per-symbol `Execution Mode` selector (`Inherit / Force Paper / Force Live`).
- **Settings page**: global `Paper Mode` toggle, virtual wallet balance, fee/slippage/latency inputs, **Reset Paper State** button (confirms, then truncates paper rows + resets `paper_wallet`).
- **Position detail**: shows paper fees/slippage applied per fill so operators can audit the simulator.

---

## 10. Safety Rails

- DB CHECK / trigger: an order with `execution_mode='live'` cannot reference a `position` with `execution_mode='paper'`, and vice versa.
- `LiveBybitClient` constructor refuses to instantiate if `app_settings.paper_mode_enabled=true` AND no per-symbol live override exists for the call site — prevents accidental live orders while validating.
- Switching the global flag from paper → live writes a `system_alerts(severity=warning, category=mode_switch)` and a forced banner on the dashboard for 24h.
- Reset Paper State requires typing the symbol-set name; never affects live rows.

---

## 11. Out of Scope

- Realistic order-book depth simulation (we use last-price + flat slippage).
- Funding-rate / borrow-fee simulation.
- Partial-fill simulation for paper market orders (always fully filled at simulated price; reflects Bybit market behavior closely enough).
- Paper backtesting over historical bars — this mode is **forward** simulation against live ticker prices only.

---

## 12. Implementation Order (when approved)

1. Schema migration: `execution_mode` enum, columns on existing tables, `paper_wallet`, `paper_market_prices`, settings additions.
2. Refactor `_shared/bybit.ts` into `bybit-client.ts` interface + `LiveBybitClient` (still stub) + `PaperBybitClient`.
3. `getClient(mode)` factory + `resolveMode(symbol)` helper. Add `mode_resolved` trail step in dispatcher.
4. Stamp `execution_mode` on every job/order/position write; split reconcile loop by mode.
5. Cron hooks `paper-prices` and `paper-tick` + ticker fetch helper.
6. Dashboard: header badge, mode chips/filters on Signals/Orders/Positions, Symbols override field, Settings paper panel + reset.
7. Safety rails: DB constraint trigger + live-client refusal guard + mode-switch alert.
8. Test plan: replay one historical signal of each strategy code (EL1..XL5) end-to-end in paper, verify trail, fills, protection re-arm, TSL trigger, full close, and wallet accounting.
