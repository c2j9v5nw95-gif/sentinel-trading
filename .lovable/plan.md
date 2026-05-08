
# Phase 3 — Bybit V5 Execution Engine & Protection Lifecycle (Design)

This is a design-only plan. No code is written until approved. The goal is a deterministic, restart-safe execution layer where Bybit is the source of truth and the local DB is an operational cache.

---

## 1. Core Principles

1. **Bybit = truth, DB = cache.** Every decision boundary re-reads Bybit (`/v5/position/list`, `/v5/order/realtime`, `/v5/execution/list`) before acting on a stale DB row.
2. **Idempotency by client order id.** Every Bybit-bound order carries a deterministic `orderLinkId` derived from `(signal_id, purpose, attempt)`. Retries reuse the same id so Bybit dedupes.
3. **Single writer per symbol.** A symbol-scoped advisory lock (Postgres `pg_try_advisory_xact_lock(hashtext(symbol))`) guarantees no two workers mutate the same position concurrently.
4. **State machine first.** Every order and every position has an explicit FSM. Side effects only on transitions.
5. **Protection invariant.** A position with `qty_open > 0` must, within a bounded window, have `protection_state = protected` and a live SL on Bybit. Violations raise `system_alerts` and trigger the protection monitor.

---

## 2. New / Extended Schema (planned, not yet migrated)

### 2.1 `orders` (extend)
- `order_link_id text unique` — deterministic client id, idempotency key.
- `attempt int default 0` — retry counter for the same purpose.
- `intended_qty numeric` — qty we asked for.
- `filled_qty numeric default 0` — cumulative fills.
- `avg_fill_price numeric`.
- `reduce_only boolean default false`.
- `time_in_force text` — `IOC` for market reductions, `GTC` for SL/TSL.
- `last_synced_at timestamptz` — last reconciliation.
- `cancel_reason text`.
- Status enum extended: `pending_submit | submitted | partially_filled | filled | cancelled | rejected | expired | stale | unknown`.

### 2.2 `positions` (extend)
- `bybit_position_idx int` — 0 one-way, 1/2 hedge.
- `mode text check in ('one_way','hedge')`.
- `margin_mode text` (already on symbols, mirror snapshot).
- `leverage_applied numeric` — what we actually set on Bybit.
- `last_reconciled_at timestamptz`.
- `reconcile_drift jsonb` — last drift report.
- `state text` — FSM (see §4).
- `protection_attempts int default 0`.

### 2.3 New tables
- `execution_jobs` — durable work queue for the executor.
  - `id`, `kind` (`entry|exit|protect|reconcile|cancel|replace`), `signal_id?`, `position_id?`, `symbol`, `payload jsonb`, `status` (`queued|leased|done|failed|dead_letter`), `lease_until`, `attempts`, `last_error`, `next_run_at`, `dedupe_key unique`.
- `bybit_executions` — raw fill ledger mirrored from `/v5/execution/list`. Keyed by `(symbol, exec_id)` unique. Source for `filled_qty` and avg price truth.
- `reconciliation_runs` — audit of each reconcile pass, drift found, actions taken.
- `rate_limit_buckets` — per-endpoint token state (`endpoint`, `tokens`, `refilled_at`) so multiple workers share quota.

All new tables RLS-restricted to `operator` role for SELECT; writes via service role only.

---

## 3. Order Lifecycle FSM

```text
pending_submit
   │  submit() ok
   ▼
submitted ──► partially_filled ──► filled
   │              │                    │
   │              └──► cancelled       └──► (terminal)
   │
   ├──► rejected         (Bybit error, terminal)
   ├──► expired          (TIF lapse, terminal)
   ├──► stale            (no fill within window, eligible for cancel/replace)
   └──► unknown          (lost ack — must be reconciled before next action)
```

Transitions only via:
- `submit()` — POST `/v5/order/create` with `orderLinkId`.
- `reconcile()` — pull `/v5/order/realtime` + `/v5/execution/list`, advance state.
- `cancel()` — POST `/v5/order/cancel`.
- `replace()` — `cancel()` then `submit()` with `attempt+1` (new link id suffix).

`unknown` is the recovery state. Any submit that times out, network-fails, or returns ambiguous code goes to `unknown` and **must not** be re-submitted blindly — the next reconcile pass resolves it by `orderLinkId` lookup.

---

## 4. Position Lifecycle FSM

```text
intended ──► opening ──► open_unprotected ──► open_protected
                │              │                    │
                │              │                    ├──► tp1_partial ──► open_protected (qty reduced, SL re-armed)
                │              │                    ├──► tp2_partial ──► open_protected
                │              │                    └──► closing ──► closed
                │              └──► failed (entry rejected / 0 fill)
                └──► aborted (pre-flight risk reject)
```

Invariants:
- Enter `open_protected` only when SL order confirmed live on Bybit.
- `tp1_partial` and `tp2_partial` re-enter `open_protected` only after SL qty rewritten to current `qty_open`.
- `closed` requires `qty_open == 0` confirmed by Bybit position read, not just our exit fills.

---

## 5. Entry Flow (`execute-entry`)

Pre-conditions already enforced in Phase 2 (risk gates, exposure caps). Entry job runs under symbol lock:

1. **Pre-flight reconcile**: read Bybit position for symbol. If a position already exists in our intended direction, reject as `duplicate_entry` and trail it. If opposite direction, route to "flip" decision (out of scope this phase — block + alert).
2. **Account mode check**: ensure `position_mode` (`one_way|hedge`) matches symbol config; if not, set via `/v5/position/switch-mode`. Cache result.
3. **Margin & leverage**: call `/v5/position/switch-isolated` and `/v5/position/set-leverage` only when current values differ (read first to avoid `110043` "leverage not modified" noise — treat that code as success anyway).
4. **Sizing**: recompute notional from live wallet balance + symbol caps (already in `sizing.ts`). Round to instrument `lotSize`/`minOrderQty`.
5. **Submit market entry** with `orderLinkId = entry:{signal_id}:{attempt}`, `reduceOnly=false`, `timeInForce=IOC`.
6. **Await fill** via short reconcile loop (poll `/v5/order/realtime` + `/v5/execution/list` up to N seconds). Allowed terminal outcomes: `filled`, `partially_filled` (accept partial), `rejected`, `unknown`.
7. **On any fill > 0**: create/upsert `positions` row, transition to `open_unprotected`, set `unprotected_since=now()`.
8. **Immediately** enqueue `protect` job (see §7). Entry job does not return success until protect job is enqueued and `qty_open` recorded.
9. **On `unknown`**: do not retry submit; enqueue `reconcile` job, leave signal in `accepted` (executor) state with `attempt` unchanged.

---

## 6. Exit Flow (`execute-exit`)

Triggered by `EXIT-LONG`, `EXIT-SHORT`, `XL1..XL5`, plus internal TP1/TP2.

1. **Pre-flight**: read Bybit position. If `size == 0` → mark signal `no_position`, close local position row, done. (Bybit truth wins.)
2. **Compute exit qty**:
   - Full exit: `qty = bybit_size` (live).
   - TP1 portion: `qty = round(bybit_size * tp1_exit_percent / 100, lotSize)`.
   - TP2 / rest: `qty = bybit_size` (whatever remains).
   - Never derive qty from local `qty_open` — Bybit is truth.
3. **Submit reduce-only market** with `orderLinkId = exit:{signal_id}:{portion}:{attempt}`, `reduceOnly=true`, `timeInForce=IOC`.
4. **Await fill** via reconcile poll. Accept partial fills; on partial, do not auto-retry the residual unless explicitly a "full close" exit (in which case re-submit residual with `attempt+1`, still reduce-only).
5. **Post-exit re-arm**: if remaining `qty_open > 0`, enqueue `protect` job to rewrite SL to new qty. Position transitions back to `open_protected` only after SL confirmed.
6. **Full close**: confirm `bybit_size == 0` via fresh read before transitioning to `closed`. Cancel any leftover SL/TSL orders for this symbol.

---

## 7. Protection Lifecycle (`protection-monitor`)

Runs as a job + cron sweep (every 10s).

1. **Arming after entry**: place SL via `/v5/position/trading-stop` with `slPrice = entry * (1 ± sl_pct)`, `tpslMode=Full`, qty = live `qty_open`. On success, position → `open_protected`.
2. **Arming retries**: bounded retries (e.g. 5 attempts, exponential backoff up to 30s). Each attempt increments `protection_attempts`. After cap → `system_alerts(severity=critical, category=unprotected_position)` and the position is flagged `manual_intervention_required` (still tracked, not auto-closed).
3. **Re-arm after partial exit (TP1/TP2)**: rewrite trading-stop with new qty. SL price unchanged unless TSL activation criteria met.
4. **TSL activation**: when unrealised profit ≥ `tsl_activation_profit_pct`, switch SL to a trailing stop with `callbackRatio = tsl_callback_pct`. Record `tsl_active=true`, `tsl_activated_at`.
5. **Sweep**: cron pass finds positions with `qty_open > 0` AND (`unprotected_since older than threshold` OR `protection_state != protected`) and re-runs the arming job.
6. **Cancel-on-close**: when position closes, explicitly cancel any residual conditional orders for the symbol to prevent orphaned SL.

---

## 8. Reconciliation Loop

Runs every ~15s, plus on-demand after any `unknown` order outcome and on worker startup.

For each symbol with activity in the last 24h:
1. Acquire symbol advisory lock (skip if held).
2. Pull `/v5/position/list?symbol=…`, `/v5/order/realtime?symbol=…&openOnly=0`, `/v5/execution/list?symbol=…&startTime=lastCursor`.
3. Upsert raw fills into `bybit_executions` (idempotent by `exec_id`).
4. For each open order DB row: match by `orderLinkId`, advance FSM. Orders DB-open but missing on Bybit and older than `stale_threshold` → `stale` → cancel attempt or mark `unknown` resolved.
5. For each Bybit order with no DB row: insert as `discovered` (manual or recovered) and alert.
6. Recompute position truth: `qty_open := bybit_size`, `entry_price := bybit_avgPrice`. Diff vs DB → write `reconcile_drift` and `position_events(event_type='drift')`. Drift > tolerance raises alert.
7. Protection check: if `bybit_size > 0` and no live SL on Bybit → enqueue `protect` job.
8. Position closed on Bybit but DB still open → transition to `closed`, snapshot final pnl from executions, cancel residual orders.
9. Write `reconciliation_runs` summary.

This loop is also the **startup recovery** path: on boot, every symbol with non-terminal state is reconciled before any new signal is processed. `process-signal` blocks new entries while a `recovery_pending` flag is set in `app_settings`.

---

## 9. Idempotency, Retries, Rate Limits, Timeouts

- **`orderLinkId` scheme**: `{purpose}:{signal_id}:{detail}:{attempt}` — max 36 chars, hash if longer. Bybit rejects duplicates with `110072` → treat as success and reconcile.
- **HTTP client** (`_shared/bybit.ts`): timeout 8s connect / 12s total. AbortController. Single-flight per `orderLinkId` within a process.
- **Retry policy**: only retry on network error, 5xx, or Bybit codes in a defined `RETRYABLE_CODES` set (e.g. `10002`, `10006`, `170136`). Backoff: 250ms, 750ms, 2s, 5s, 10s; max 5 attempts. Non-retryable codes terminate to `rejected` immediately.
- **Rate limiter**: token bucket per endpoint group stored in `rate_limit_buckets`, shared across workers via row-level `UPDATE … RETURNING`. On Bybit `10006`/header `X-Bapi-Limit-Status=0` → drain bucket and back off.
- **Job queue semantics**: `execution_jobs` rows leased with `UPDATE … WHERE status='queued' AND next_run_at<=now() RETURNING …` + `lease_until`. Orphaned leases reclaimed after expiry. After max attempts → `dead_letter` + alert.

---

## 10. Duplicate Execution Prevention (multi-layer)

1. Signal-level dedupe (Phase 2, already in place).
2. `execution_jobs.dedupe_key` unique per `(signal_id, kind, attempt)`.
3. Symbol advisory lock during entry/exit.
4. Pre-submit Bybit position check (refuses entry if same-direction position exists for same `signal_id` reference in `positions.entry_signal_id`).
5. Bybit-side `orderLinkId` uniqueness.
6. Reconcile diffs against `bybit_executions` ledger before declaring any order "filled".

---

## 11. One-Way vs Hedge Mode

- Symbol config gains `position_mode` (default `one_way`).
- On first activity per symbol, executor calls `/v5/position/switch-mode` if mismatch.
- Hedge mode: include `positionIdx` (1 long / 2 short) on every order; one-way uses `0`. Stored on `positions.bybit_position_idx`.
- Reconciliation matches positions on `(symbol, side, positionIdx)`.

---

## 12. State Machine Diagram

```text
SIGNAL accepted
     │
     ▼
execution_jobs(kind=entry) ──lease──► entry FSM
                                     │
                                     ├─ duplicate? ─► reject + trail
                                     ├─ unknown   ─► reconcile job
                                     └─ filled>0  ─► positions.opening → open_unprotected
                                                                │
                                                                ▼
                                            execution_jobs(kind=protect)
                                                                │
                                                ┌──ok──► open_protected ◄──────────┐
                                                │                                   │
                                                └──fail (capped)──► alert            │
                                                                                    │
SIGNAL exit accepted ──► execution_jobs(kind=exit) ──► exit FSM ──► partial? ──► protect (re-arm)
                                                              └──► full close ──► closed (after Bybit size==0)

cron(15s) ──► reconcile loop ──► drift fix / orphan cleanup / protection sweep
```

---

## 13. Out of Scope (this phase)

- Live Bybit calls — this plan defines structure; switching from stubs is a follow-up implementation phase.
- Position flips on opposite-direction signal (block + alert only).
- Cross-symbol portfolio risk (already handled by Phase 2 caps).
- UI changes beyond surfacing `reconciliation_runs`, drift, and dead-letter execution jobs on the existing dashboards (detailed UI spec deferred to implementation PR).

---

## 14. Implementation Order (when approved)

1. Schema migration (orders/positions extensions, new tables, enums).
2. `_shared/bybit.ts` real V5 client (signing, rate limiter, retry, timeouts).
3. `_shared/executor.ts` — job queue lease + symbol lock + FSM transitions.
4. `_shared/reconcile.ts` — the loop.
5. Refactor `execute-entry` / `execute-exit` / `protection-monitor` into thin job handlers calling executor primitives.
6. Cron wiring (`/api/public/hooks/reconcile`, `/api/public/hooks/executor-tick`).
7. Startup recovery flag + gating in `process-signal`.
8. Dashboard surfaces (drift, reconcile runs, dead-letter execution jobs, protection alerts).
9. Integration test plan against Bybit testnet before flipping live.

