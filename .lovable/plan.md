
# Symbol-Level Execution Locking — Design

A single coordination primitive that every Phase 3 execution path (entry, exit, replay, reconcile, protection re-arm) must acquire before touching Bybit or position rows for a given symbol. Built as a Postgres-backed `execution_locks` table with TTL + heartbeat, atomically managed by SECURITY DEFINER functions. Visible in the dashboard and crash-safe by design.

---

## 1. Why a Table (not raw advisory locks)

Postgres advisory locks (`pg_try_advisory_xact_lock`) are atomic and cheap, but:
- They die with the connection — invisible to the dashboard.
- They can't carry metadata (owner, job kind, acquired-at, heartbeat).
- They can't be "broken" by an operator.
- They don't survive across the supabase-js connection pool well.

So the canonical lock is the **`execution_locks` table** with TTL + heartbeat. We still keep one advisory lock **inside the SQL acquisition function** to serialize the test-and-set, eliminating the small race window between SELECT and INSERT.

---

## 2. Schema (planned)

### 2.1 New enums
- `lock_kind` ∈ (`entry`, `exit`, `replay`, `reconcile`, `protect`, `manual`).

### 2.2 `execution_locks` table
| column            | type                    | notes |
|-------------------|-------------------------|-------|
| `symbol`          | text PRIMARY KEY        | one row per locked symbol |
| `kind`            | `lock_kind` NOT NULL    | what the holder is doing |
| `owner_id`        | text NOT NULL           | worker/process id (uuid v4 generated per worker boot) |
| `job_id`          | uuid NULL               | references `execution_jobs.id` when applicable |
| `signal_id`       | uuid NULL               | references `signals.id` when applicable |
| `acquired_at`     | timestamptz NOT NULL    | first-grab time |
| `heartbeat_at`    | timestamptz NOT NULL    | last refresh |
| `ttl_seconds`     | integer NOT NULL        | per-kind default (see §4) |
| `expires_at`      | timestamptz GENERATED   | `heartbeat_at + ttl_seconds * interval '1 second'` |
| `metadata`        | jsonb                   | anything useful (action, attempt, etc.) |

Indexes: `(expires_at)` for stale sweeps; primary key gives O(1) lookup.

RLS: `operator` SELECT only. All writes via `SECURITY DEFINER` SQL functions (service-role).

### 2.3 `execution_lock_events` (audit trail)
Append-only log of acquire/release/steal/expire events for the dashboard and audit. Columns: `id, symbol, kind, owner_id, event` (`acquired|released|heartbeat|stolen|expired|preempted`), `previous_kind`, `previous_owner_id`, `note`, `created_at`.

---

## 3. Lock Acquisition — SQL functions

All atomic. All `SECURITY DEFINER`, `search_path=public`, executable only by service role (REVOKE from `public` and `authenticated`).

### 3.1 `acquire_execution_lock(_symbol text, _kind lock_kind, _owner_id text, _job_id uuid, _signal_id uuid, _ttl_seconds int, _allow_preempt boolean) returns jsonb`

Pseudocode:

```text
PERFORM pg_advisory_xact_lock(hashtext('exec_lock:' || _symbol));  -- serialize T&S

SELECT * INTO existing FROM execution_locks WHERE symbol = _symbol;

IF existing IS NULL OR existing.expires_at <= now() THEN
  -- free or stale: take it
  INSERT ... ON CONFLICT (symbol) DO UPDATE SET ...;
  log('acquired' or 'stolen');
  RETURN { granted:true, took_over:existing IS NOT NULL };
END IF;

-- held and fresh
IF existing.owner_id = _owner_id AND existing.kind = _kind THEN
  -- reentrant for same owner+kind: refresh heartbeat
  UPDATE execution_locks SET heartbeat_at = now() WHERE symbol = _symbol;
  log('heartbeat');
  RETURN { granted:true, reentrant:true };
END IF;

-- preemption rules (see §5)
IF _allow_preempt AND can_preempt(existing.kind, _kind) THEN
  UPDATE ... SET kind=_kind, owner_id=_owner_id, ...;
  log('preempted');
  RETURN { granted:true, preempted:true, previous_kind:existing.kind };
END IF;

RETURN { granted:false, holder:existing.owner_id, holder_kind:existing.kind,
         expires_at:existing.expires_at };
```

The advisory lock is transactional (`xact`), so it auto-releases on commit/rollback — a worker crash mid-function never leaves it stuck.

### 3.2 `release_execution_lock(_symbol text, _owner_id text) returns boolean`
Releases only if the caller still owns the row. Logs `released`. Returns `true`/`false`.

### 3.3 `heartbeat_execution_lock(_symbol text, _owner_id text) returns boolean`
Updates `heartbeat_at = now()` only if owner matches and lock not expired. Returns `false` if the lock was lost (caller MUST abort).

### 3.4 `expire_stale_locks() returns int`
Sweeper — deletes rows where `expires_at <= now()` and logs `expired`. Run by cron every 30s.

### 3.5 Read-only `current_execution_locks()` view
For the dashboard. Joins lock rows with derived `age_seconds`, `seconds_until_expiry`, `is_stale` (expired but not yet swept), and (where available) signal/job summary.

---

## 4. TTLs by Kind

| kind        | default TTL | heartbeat cadence | rationale |
|-------------|-------------|-------------------|-----------|
| `entry`     | 30s         | 5s                | one Bybit market round-trip + sizing |
| `exit`      | 30s         | 5s                | same |
| `replay`    | 30s         | 5s                | runs through dispatcher + executor |
| `reconcile` | 60s         | 10s               | may pull positions/orders/executions |
| `protect`   | 20s         | 5s                | trading-stop call only |
| `manual`    | 300s        | n/a               | operator-held via UI; no auto-heartbeat |

A worker that is healthy refreshes its heartbeat well before TTL. If it crashes, the row goes stale within at most one TTL window and any other worker may grab it.

---

## 5. Preemption Rules — Exit > Entry

Encoded in `can_preempt(current, requested)`:

| current → / requested ↓ | entry | exit | replay | reconcile | protect | manual |
|-------------------------|:-----:|:----:|:------:|:---------:|:-------:|:------:|
| **entry**               | no    | YES  | no     | no        | no      | YES    |
| **exit**                | no    | no   | no     | no        | no      | YES    |
| **replay**              | no    | YES  | no     | no        | no      | YES    |
| **reconcile**           | no    | YES  | no     | no        | no      | YES    |
| **protect**             | no    | YES  | no     | no        | no      | YES    |

- **Exits always preempt entries/replays/reconciles/protects.** They first signal the holder via a `lock_preempted` flag (the holder's next heartbeat returns `false`, the holder must roll back its in-flight work cleanly). Then the exit takes the lock.
- **Manual** (operator from dashboard) preempts anything — last-resort kill switch for stuck symbols.
- All other combinations wait or fail-fast (caller decides via `_allow_preempt=false`).

A holder whose heartbeat returns `false` MUST:
1. Abort any pre-Bybit-call work in-flight.
2. NOT roll back already-submitted Bybit orders (those become reconciler's problem — Bybit truth wins).
3. Mark its `execution_jobs` row `failed_preempted` with `next_run_at = now()+5s` so it retries cleanly after the higher-priority job finishes.

---

## 6. Reconciliation vs Stale Locks

Reconciler uses a special path:
1. Sweep expired locks first (`expire_stale_locks()`).
2. For each symbol with non-terminal state, attempt to acquire `kind=reconcile` with `_allow_preempt=false`.
3. If acquisition fails because someone else holds the lock and it's NOT yet expired → **skip this symbol this pass**; reconcile only idle symbols. Prevents reconciler from racing against an in-flight entry.
4. After a configurable `RECONCILE_FORCE_AFTER` (default 5 minutes) of continuous lock-busy on the same symbol, escalate to `_allow_preempt=true` AND raise `system_alerts(severity=warning, category=long_held_lock)` so an operator can intervene.

---

## 7. Replay Compatibility

`replay_signal()` already requeues a signal. The replayed signal goes through dispatch like any other; when its `execution_jobs` row leases, the executor must call `acquire_execution_lock(symbol, kind='replay', ...)` exactly like a normal entry/exit — replays are not special-cased and cannot bypass locking.

The replay UI shows a warning banner if the target symbol currently holds a non-`replay` lock: "Symbol is busy (kind=entry, age 12s). Replay will queue and retry."

---

## 8. Duplicate Webhook Retry Protection

Layered defense — locks are the last layer:
1. `signals.dedupe_key` (already in place) — rejects duplicate inbound webhooks before they are even queued.
2. `execution_jobs.dedupe_key` (Phase 3) — rejects duplicate jobs derived from the same `(signal_id, kind, attempt)`.
3. `execution_locks` — even if both layers above fail, the second job to attempt acquisition for the same symbol gets `granted:false` and either waits or aborts.
4. Bybit `orderLinkId` — Bybit-side dedupe of any orders that somehow get through.

---

## 9. Worker Identity & Heartbeat Loop

Each Edge Function invocation:
1. Generates a stable `owner_id = crypto.randomUUID()` at startup, stored in module-level `WORKER_ID` constant.
2. Wraps the critical section in:

```ts
const lock = await acquireLock(symbol, "entry", { jobId, signalId, ttlSec: 30 });
if (!lock.granted) return { status: "skipped", reason: "symbol_busy", holder: lock.holder };
const beat = setInterval(async () => {
  const ok = await heartbeat(symbol);
  if (!ok) { aborted = true; clearInterval(beat); /* trigger graceful abort */ }
}, 5_000);
try { await doWork(); }
finally { clearInterval(beat); await releaseLock(symbol); }
```

3. `try { ... } finally { release }` guarantees release on normal exits and exceptions; TTL covers crashes.

---

## 10. Dashboard Surfacing

New "Execution Locks" panel on the Positions page (and a small chip in the StatusBar):

- **StatusBar chip**: `🔒 3 locked` (clickable → opens the panel). Red dot if any lock is past TTL but not yet swept.
- **Panel table** (`current_execution_locks` view, refresh 2s):
  - Symbol · Kind chip · Owner (truncated) · Age · Heartbeat age · Expires in · Job/Signal links · `Steal` button (operator role; opens confirm modal that calls `acquire_execution_lock(..., kind='manual', _allow_preempt=true)`).
  - Row tinted amber when `heartbeat_age > 2 × cadence` (worker likely dead, will expire soon).
  - Row tinted red when expired.
- **Per-symbol detail** in Positions row: when a row's `symbol` is locked, show a small `🔒 entry · 12s` badge inline.
- **Audit log** filter chip for `lock_*` events from `execution_lock_events`.

---

## 11. Failure Modes Covered

| Scenario                                         | Outcome |
|--------------------------------------------------|---------|
| Worker crashes mid-entry                         | Lock expires after TTL; another worker re-acquires; reconciler resolves any half-done Bybit state. |
| Two webhooks for same signal arrive in parallel  | Signal dedupe rejects #2; even if both reached executor, only one gets the lock. |
| Reconciler fires while exit is mid-flight        | Reconciler sees fresh lock, skips symbol that pass. |
| Operator hits Replay during entry                | Replay queues; lock acquisition fails until entry finishes; UI shows busy banner. |
| Exit signal arrives during a slow entry          | Exit preempts; entry's next heartbeat returns false → entry aborts pre-submit; if entry already submitted to Bybit, reconciler folds the result in. |
| Lock row stuck because of a Postgres bug        | Sweeper expires it; or operator clicks Steal. |
| Network partition between worker and DB         | Heartbeat fails → worker treats lock as lost and aborts further side-effects. |

---

## 12. Out of Scope

- Cross-symbol locks (portfolio-level) — handled by Phase 2 concurrency cap.
- Distributed consensus across regions — single Postgres is the source of truth.
- Lock fairness/queueing — callers re-poll with backoff; we don't implement a wait queue.

---

## 13. Implementation Order (when approved)

1. Migration: `lock_kind` enum, `execution_locks`, `execution_lock_events`, `current_execution_locks` view, RLS.
2. SQL functions: `acquire_execution_lock`, `release_execution_lock`, `heartbeat_execution_lock`, `expire_stale_locks`. Tests via direct SQL.
3. `_shared/locks.ts` helper: `acquireLock / heartbeat / releaseLock / withSymbolLock(symbol, kind, fn)` wrapper.
4. Cron: `/api/public/hooks/expire-locks` every 30s calling `expire_stale_locks()`.
5. Wire `withSymbolLock` into Phase 3 `execute-entry`, `execute-exit`, `protection-monitor`, `reconcile`, and the replay path.
6. Dashboard: StatusBar chip + Positions panel + Steal modal + audit filter.
7. Test plan: simulated crash mid-entry, exit-preempts-entry, reconcile-skips-busy-symbol, operator-steal, double-webhook-replay.
