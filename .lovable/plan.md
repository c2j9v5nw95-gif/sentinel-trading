# Phase 2: Signal Pipeline (no live execution)

Wire the queue from `signals` (status=queued) through normalization → strategy mapping → Health Gate → Risk Engine → terminal status. Bybit calls remain stubs; the pipeline ends by marking the signal `ready_for_execution` (or `rejected`) with full risk_decisions / audit trails.

## 1. Shared modules (already in place — small hardening only)

- `parser.ts`, `normalize.ts`, `dedupe.ts`, `strategy-map.ts` already work and are used by `ingest-webhook`. Only changes:
  - `parser.ts`: also accept `barTime` casing variants and ignore an optional `secret=` line so it doesn't pollute `payload.raw` after auth.
  - `strategy-map.ts`: add `sideOf(action)` helper and a `requiresPosition(action)` helper for the Risk Engine.
- New `supabase/functions/_shared/health-gate.ts`:
  - `evaluateHealth(sb, { symbol, strategy, tag })` → `{ pass, reason, metrics }`.
  - Reads the latest `health_snapshots` row for `(symbol, strategy, tag)` and the matching `strategies` row; compares to `health_min_winrate`, `health_min_profit_factor`, `health_min_net_profit` (NULL threshold = skip that check).
  - Returns `pass=true` with `reason="no_thresholds_configured"` if strategy has no thresholds, or `reason="no_health_data"` if no snapshot yet (configurable: default = pass with warning, never silently block until at least one stats alert was received).
  - HEALTH alerts always pass this gate (it's only consulted for trade signals).
- New `supabase/functions/_shared/risk-engine.ts`:
  - `evaluateRisk(sb, signal, mapping)` → `{ outcome: 'pass'|'block', gate, reason, metrics }`.
  - Sequential gates, first failure wins:
    1. `kill_switch` — `app_settings.emergency_stop` blocks ALL; `entries_paused` blocks ENTER-* only.
    2. `risk` — symbol row exists & `enabled=true`; strategy row exists & `enabled=true`.
    3. `transport_mismatch` — if `symbols.preferred_transport != 'either'` and `signal.transport != preferred_transport`, block.
    4. `unprotected_pause` — if any open `positions.protection_state='unprotected'`, block ENTER-* (exits always allowed).
    5. `risk` (concurrency) — count distinct open positions; block ENTER-* when `>= app_settings.max_concurrent_positions`.
    6. `risk` (no_position) — EXIT-* with no matching open position → block with reason `no_open_position`.
  - Each call ends with one `risk_decisions` insert (`gate`, `outcome`, `reason`, `metrics`, `signal_id`).
  - Health Gate is run separately (only for trade signals, before Risk Engine) so the rejection reason cleanly attributes to `gate=health`.
- New `supabase/functions/_shared/dispatcher.ts`:
  - `dispatchSignal(sb, signalId)` — pure function that runs one signal end-to-end. Used by both `process-signal` (queue worker) and a future post-insert trigger.

## 2. `record-health` (implement)

POST `{ signal_id }` (or signal row) and:
1. Fetch the signal; assert `type='stats'`.
2. Insert `health_snapshots` row with `symbol`, `strategy`, `tag`, `net_profit`, `winrate`, `profit_factor`, `bar_time`, `source_signal_id`, raw `payload`.
3. Update `strategies.last_health_at = now()` (upsert by `(name, tag)` if missing — but do NOT auto-create strategies with thresholds; create with NULL thresholds so the gate falls back to the safe default).
4. Mark signal `status='processed'`, `processed_at=now()`, `decision_reason='health_recorded'`.
5. Return `{ ok, snapshot_id }`.

## 3. `process-signal` (implement)

Two invocation modes, same handler:
- POST with `{ signal_id }` → process that one signal.
- POST with `{}` (cron) → claim up to N (default 25) `signals` rows where `status='queued'` ordered by `received_at`, process in order.

Per signal:
1. Optimistic claim: `update signals set status='processing' where id=$1 and status='queued' returning *`. If no row, skip (already taken / dedupe collision).
2. If `type='stats'`: call record-health logic inline (same module), commit, continue.
3. If `type='trade'`:
   - Resolve mapping from `strategy_code` (re-resolve defensively; ingest already populated columns).
   - **Health Gate** — `evaluateHealth(...)`. On block: `risk_decisions` row with `gate='health'`, mark signal `status='rejected'`, `decision_reason=...`, return.
   - **Risk Engine** — `evaluateRisk(...)`. On block: signal `status='rejected'`, `decision_reason=...`, return.
   - On pass: mark signal `status='ready_for_execution'`, `decision_reason='gates_passed'`, `processed_at=now()`. **Do NOT call Bybit.** Phase 3 will pick these rows up.
4. Always write an `audit_log` entry with `action='signal_dispatched'` and the full decision context.

## 4. Trigger from ingest

`ingest-webhook` already inserts the signal. After insertion, fire-and-forget POST to `process-signal` with `{ signal_id }` using the project's internal function URL + service-role key (no `await` on the response, just `void fetch(...)` with a 5s abort). This gives sub-second latency without blocking the TradingView ACK. The cron-style empty-body invocation remains as a safety net for missed dispatches.

## 5. Status enum check

Confirm `signal_status` enum already includes `queued`, `processing`, `rejected`, `processed`, and add `ready_for_execution` if missing. Migration only if needed (will be checked first via `pg_enum` SELECT).

## 6. Dashboard surfacing (light pass)

- `/signals`: show `status`, `decision_reason`, latest matching `risk_decisions.gate` for rejected rows.
- `/audit` already lists `audit_log`; surface the new `signal_dispatched` action with metric chips (gate, outcome).
- No new pages.

## 7. Out of scope for Phase 2

- Bybit calls: `execute-entry`, `execute-exit`, `protection-monitor`, leverage push remain stubs. Their inputs (sizing breakdown, exposure caps, SL params) are already Phase-1/3 defined.
- Email ingest (`ingest-email`) stays disabled.
- pg_cron schedule wiring; we'll provide the endpoint and document the cron call but leave actual scheduling for the Phase 3 review.

## Technical notes

- All sb calls use `serviceClient()`; RLS bypassed intentionally (background worker).
- `risk_decisions.metrics` is `jsonb` — store all numeric inputs as numbers (PostgREST returns `numeric` as string; convert with `Number(...)`).
- Concurrency count: `select count(*) from positions where closed_at is null` filtered by symbol when needed.
- Idempotency: optimistic `status` claim guarantees one worker per signal; ingest's unique `dedupe_key` already prevents duplicate inserts.
