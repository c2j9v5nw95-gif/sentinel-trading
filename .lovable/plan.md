# Phase 2.5: Operational Safeguards

Four pre-execution safeguards layered onto the existing pipeline. No Bybit work yet.

## 1. Database changes (one migration)

`signal_status` enum — add `dead_letter` and `replay`. (`replay` is unused as a status today but reserved; the replay row gets `queued` and replay metadata in payload.)

`app_settings` — add `emergency_stop_blocks_exits boolean NOT NULL DEFAULT false`. By default emergency stop blocks **entries only**; exits still flow. Operator can opt into "block exits too" explicitly.

`signals` — add columns:
- `replay_of uuid NULL` — points to original signal (no FK to keep replays even if origin is purged later, but logically references signals.id)
- `replay_by uuid NULL` — operator who triggered the replay
- `replay_at timestamptz NULL`
- `bypass_dedupe boolean NOT NULL DEFAULT false`
- `retry_count int NOT NULL DEFAULT 0`
- `error_stack text NULL`
- `request_id text NULL` (carry through from ingest if present; auto-gen otherwise)
- `decision_trail jsonb NOT NULL DEFAULT '[]'::jsonb` — ordered array of `{ step, outcome, reason?, metrics?, at }` entries

Index: `signals(status) WHERE status IN ('dead_letter','queued','processing')` for the worker + dashboard.

A new RPC / server function `replay_signal(signal_id, bypass_dedupe)` that requires `operator` role; copies a signal row into a new one with `status='queued'`, links via `replay_of`, sets `replay_by=auth.uid()`, `replay_at=now()`, optionally pre-empts dedupe by appending `|replay=<uuid>` to the dedupe key.

## 2. Decision trail (`_shared/trail.ts`)

New helper module:
```ts
type TrailStep = {
  step: string;          // "parser_pass" | "normalized_symbol" | "dedupe_pass" | ...
  outcome: "pass" | "fail" | "skip" | "info";
  reason?: string;
  metrics?: Record<string, unknown>;
  at: string;            // ISO timestamp
};
class Trail {
  add(step, outcome, reason?, metrics?): void
  toJSON(): TrailStep[]
}
async flushTrail(sb, signalId, trail): Promise<void>  // updates signals.decision_trail
```

Steps are appended at every gate, in this canonical order:
- `parser_pass` / `parser_fail` (recorded in raw_alerts when no signal row exists yet, then mirrored on the signal once created)
- `normalized_symbol` (info, with `{ raw, normalized }`)
- `dedupe_pass` / `dedupe_skip` (skip when bypass_dedupe=true)
- `claimed` (info)
- `exit_priority` (info, when bypassing health/transport for an exit)
- `health_gate_pass` / `health_gate_skip` / `health_gate_fail`
- `transport_pass` / `transport_skip` / `transport_fail`
- `kill_switch_pass` / `kill_switch_fail`
- `symbol_pass` / `symbol_fail`
- `unprotected_pause_pass` / `unprotected_pause_fail`
- `concurrency_pass` / `concurrency_fail`
- `position_check_pass` / `position_check_fail` (exits)
- `exposure_limit_pass` / `exposure_limit_fail` (will be wired by execute-entry in Phase 3; the slot is already in the trail)
- terminal: `accepted` / `rejected` / `dead_letter`

Single flush at end of `dispatchSignal` (and at the catch boundary) so the trail survives errors. The existing `risk_decisions` table stays — it's the canonical rejection log; `decision_trail` is the per-signal narrative.

## 3. Exit-priority short-circuit (in `dispatcher.ts`)

After claim, if `isExit(action)`:
- Skip Health Gate entirely (`trail.add("health_gate","skip","exit_priority")`).
- Skip transport_mismatch check (record skip step).
- Skip strategy_disabled check (already only enforced inside health-gate; risk-engine's symbol enabled check stays).
- Still enforce: `emergency_stop` only when `app_settings.emergency_stop_blocks_exits=true`; `symbol_not_configured`; `missing_symbol`; `unknown_strategy_code` (treated as malformed); `no_open_position`.

`risk-engine.ts` gets a new `mode: 'standard' | 'exit_priority'` flag so the gate ordering is one place. Exits never check `entries_paused` (already true) and never check `unprotected_pause` (already true). Add: exits never check `max_concurrent_positions` (already true). Add: exits skip `transport_mismatch`.

## 4. Dead-letter queue

`signals.status='dead_letter'` is reached when:
- An uncaught exception escapes `dispatchSignal` after retry attempts (default `MAX_RETRIES=2`), OR
- Any required external dependency (DB write) fails with a non-transient error.

Mechanics in `dispatcher.ts` catch block:
- Increment `retry_count`. If `< MAX_RETRIES`, set status back to `queued` so the next batch picks it up; else set `dead_letter`, persist `error_stack`, record `dead_letter` step in trail, write `audit_log` row `action='signal_dead_letter'`, raise a `system_alerts` row (severity=`critical`).
- `process-signal` worker batch query continues to claim only `status='queued'` — dead-letter rows never auto-resurrect.

Operator can replay a dead-letter signal via the same replay path (creates a fresh `queued` copy; the dead-letter original stays as historical evidence).

## 5. Replay (operator-driven)

New `createServerFn` `replaySignal({ signalId, bypassDedupe })` in `src/lib/signals.functions.ts`:
- Wrapped in `requireSupabaseAuth` + `has_role(uid,'operator')` check (RLS-backed).
- Calls a Postgres function `public.replay_signal(uuid, boolean)` (SECURITY DEFINER, role-gated) that does the row copy + dedupe-key salt + `replay_*` metadata, then returns the new signal_id.
- Server fn then fires the existing `process-signal` HTTP fan-out (same as ingest does) to dispatch the new row immediately.

UI:
- Signals page row gets a **Replay** button (operator only). Confirms via shadcn dialog with checkbox "bypass dedupe".
- Replayed signals render with a small `↺ replay of <short-id>` chip and link back to original.
- New tab/section **Dead Letter** at the top of the Signals page (or a separate `/signals/dead-letter` route) that lists `status='dead_letter'` rows with replay button + expandable error_stack.

## 6. Signal details UI

Click a signal row → side sheet (shadcn `Sheet`) showing:
- Header: action / symbol / strategy / tag / status / decision_reason
- Replay metadata if present
- Ordered **Decision Trail** (timeline UI) rendered from `decision_trail`, with pass/fail/skip pills and per-step metrics expandable
- Linked `risk_decisions` entries
- Raw payload + raw_alert reference
- Replay button (and "Replay without dedupe" toggle)

Audit log page already shows `signal_dispatched` / `signal_dead_letter` / `signal_replayed` actions; add filter chips for these three.

## 7. Migration order & implementation sequence

1. Migration: enum + columns + index + `replay_signal` SQL function.
2. `_shared/trail.ts` and refactor `dispatcher.ts` + `risk-engine.ts` to thread the trail through every gate and honor exit-priority + emergency_stop_blocks_exits.
3. `ingest-webhook` — record initial trail steps (`parser_pass`, `normalized_symbol`, `dedupe_pass`/`skip`) when creating the signal; set `request_id`.
4. Dead-letter logic + retry loop in dispatcher; update `process-signal` batch query.
5. `src/lib/signals.functions.ts` with `replaySignal` server fn.
6. UI: signal details Sheet, replay button, dead-letter section, audit-log filters.
7. Smoke tests: unhealthy-strategy + EXIT bypasses gate; dead-letter via forced exception; replay copy creates a new row with linked metadata.

## Out of scope

- No Bybit calls in this phase; `accepted` and `dead_letter` are still terminal.
- No automatic dead-letter replay; strictly operator-driven.
- No multi-tenant operator scoping (single operator).
- No global retry-window tuning UI; `MAX_RETRIES` is a constant for now (2).

## Technical notes

- `decision_trail` is append-only in code (we never rewrite earlier steps).
- Replay copies preserve `payload` verbatim; only metadata + dedupe key differ.
- `request_id` is a UUID generated at ingest if TradingView didn't supply one.
- `replay_signal` SQL is SECURITY DEFINER and double-checks `has_role(auth.uid(),'operator')` to defend against accidental anon exposure.
