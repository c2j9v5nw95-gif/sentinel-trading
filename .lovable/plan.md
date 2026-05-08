
# Foundation Plan — TradingView → Bybit Control System (v2)

This plan covers ONLY the foundation: data model, service boundaries, auth model, and dashboard information architecture. Trading logic itself comes in later phases once this skeleton is approved.

Stack: Vite + React + Tailwind + shadcn/ui + Lovable Cloud (Supabase Auth, Database, Edge Functions). Single operator. Shared-secret webhook auth. Inbound-email provider (Postmark/SendGrid). SL+TSL hybrid protection plus TP1/TP2 staged exits, configurable per symbol.

---

## 1. Auth model

- Single operator. Supabase Auth email + password. Signups disabled after operator account is created.
- One app role today: `operator`. A `user_roles` table + `has_role()` security-definer function are still created so future role splits (viewer/admin) are non-breaking.
- Sensitive secrets (Bybit API key/secret, TradingView shared webhook secret, Postmark inbound secret) live in Edge Function secrets — never in DB, never in browser.
- `app_settings` stores only metadata about the webhook secret (`webhook_secret_rotated_at`, `webhook_secret_version`, `webhook_secret_hint` = last 4 chars). The actual secret value never touches the database.
- Frontend never calls Bybit. Every Bybit call is server-side via an Edge Function that verifies the operator's Supabase JWT (or, for ingest endpoints, the shared secret).
- RLS: operational tables are operator-only. Ingest tables are written only by edge functions via service role.

---

## 2. Backend service boundaries (Edge Functions)

Shared code lives in `supabase/functions/_shared/` (parser, normalizer, action mapper, Bybit V5 client, risk engine, logger).

Public ingest (no JWT, secret-validated):
- `ingest-webhook` — TradingView HTTP webhook. Validates `secret=` field, persists raw payload, inserts a `signals` row, returns 200 fast.
- `ingest-email` — Postmark/SendGrid inbound POST. Validates provider basic-auth + shared secret, extracts the alert body, inserts into the same `signals` table through the same parser. Email is allowed per-symbol (see `symbols.preferred_transport`), not only as a global fallback.

Both ingest functions do the minimum work: auth check → store raw → parse → normalize → insert signal → return.

Processing (DB trigger / pg_net / cron):
- `process-signal` — pulls a queued signal, runs Health Gate → Risk Engine → action dispatch. Idempotent via `signals.dedupe_key`.
- `execute-entry` — places entry on Bybit using per-symbol sizing, then immediately places fixed SL. If SL placement fails after retries, position is flagged `unprotected`, a critical alert is raised, and entries are auto-paused.
- `execute-exit` — handles TP1, TP2/REST, SL, failsafe, opposite, trend-fail. Quantity is computed from current live Bybit position. Exits are never gated by Health.
- `protection-monitor` — cron (~15s). Reconciles open positions vs Bybit, activates TSL when per-symbol activation profit is reached, re-arms missing SLs, flags drift.
- `record-health` — stores `type=stats` snapshots keyed by normalized symbol + strategy + tag.

Operator actions (JWT-protected):
- `op-emergency-stop` — flips kill switch, optionally flat-closes all positions.
- `op-bybit-proxy` — narrow read-only proxy for dashboard (positions, balances, open orders).
- `op-rotate-webhook-secret` — generates a new secret, stores it in Edge Function secrets via the management API, updates `app_settings.webhook_secret_rotated_at` + `webhook_secret_version` + `webhook_secret_hint`, returns the new secret to the operator exactly once.

---

## 3. Database schema (Supabase / Postgres)

All tables: `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, RLS enabled, operator-only via `has_role(auth.uid(), 'operator')`.

### Identity & config
- `user_roles(user_id, role)` — enum `app_role` (`operator`).
- `app_settings` (single row): `entries_paused`, `emergency_stop`, `webhook_secret_rotated_at`, `webhook_secret_version int`, `webhook_secret_hint text`, `email_ingest_enabled`, `default_leverage`, `max_concurrent_positions`, `max_daily_loss_pct`, `dedupe_window_seconds int default 20`.
- `symbols` — per-symbol config:
  - `symbol` (normalized, e.g. `PIEVERSEUSDT`), `display_symbol`, `enabled`, `category` (`linear`).
  - `preferred_transport` enum `transport_pref` (`webhook` | `email` | `either`, default `webhook`).
  - Sizing: `position_size_mode` (`fixed_usdt` | `pct_equity`), `position_size_value`, `leverage`, `margin_mode` (`isolated` | `cross`).
  - Protection: `sl_pct` (mandatory), `tsl_enabled`, `tsl_activation_profit_pct`, `tsl_callback_pct`.
  - Staged exits: `tp2_enabled boolean default false`, `tp1_exit_percent numeric(5,2) default 100`.
  - DB CHECK constraint: `(tp2_enabled = false AND tp1_exit_percent = 100) OR (tp2_enabled = true AND tp1_exit_percent > 0 AND tp1_exit_percent < 100)`.
  - `notes`.
- `strategies` — `name` (`EL1`, `ES1`, …), `tag` (`STRAT2`, …), `enabled`, `health_min_winrate`, `health_min_profit_factor`, `health_min_net_profit`, `last_health_at`. Unique on `(name, tag)`.

### Action & strategy mapping
- Enum `signal_action`: `ENTER-LONG`, `ENTER-SHORT`, `EXIT-LONG`, `EXIT-SHORT`, `HEALTH`.
- Enum `exit_reason` (resolved from strategy code, stored on `signals` and `orders`):
  - Long: `XL1` → `tp1`, `XL4` → `tp2_rest`, `XL2` → `sl_failsafe`, `XL3` → `opposite`, `XL5` → `trend_fail`.
  - Short: `XS1` → `tp1`, `XS4` → `tp2_rest`, `XS2` → `sl_failsafe`, `XS3` → `opposite`, `XS5` → `trend_fail`.
- Enum `entry_reason`: `EL1` → long entry, `ES1` → short entry.
- Mapping is implemented in `_shared/strategy-map.ts` and validated against a `strategy_codes` lookup table (seeded with the codes above) so unknown codes fail loudly.

### Ingest & signals
- `raw_alerts` — append-only audit: `transport` (`webhook`|`email`), `received_at`, `remote_ip`, `headers jsonb`, `body_text`, `auth_status` (`ok`|`bad_secret`|`malformed`), `signal_id` (nullable fk).
- `signals` — normalized alert:
  - `transport`, `type` (`trade`|`stats`), `action` (`signal_action`), `symbol` (normalized), `strategy`, `tag`,
  - `entry_reason` / `exit_reason` (resolved from strategy code, nullable when not applicable),
  - `portion` enum (`full` | `tp1` | `rest`) — defaults: ENTER → `full`, SL/opposite/trend-fail/failsafe → `full`, TP1 → `tp1`, TP2 → `rest`,
  - `bar_time timestamptz` (parsed from TradingView `barTime` if present),
  - `payload jsonb`,
  - `dedupe_key text unique` — see §4 below,
  - `status` (`queued`|`processing`|`accepted`|`rejected`|`error`), `decision_reason`, `processed_at`.

### Risk & health
- `health_snapshots` — keyed by **normalized symbol + strategy + tag** (not strategy alone):
  - `symbol`, `strategy`, `tag`, `net_profit`, `winrate`, `profit_factor`, `bar_time`, `source_signal_id`,
  - composite index `(symbol, strategy, tag, created_at desc)` for "latest snapshot" lookups.
  - A health alert from `PIEVERSEUSDT.P` and from `PIEVERSEUSDT` resolves to the same normalized symbol and therefore the same gate state.
- `risk_decisions` — every gate evaluation: `signal_id`, `gate` (`health`|`risk`|`kill_switch`|`dedupe`|`unprotected_pause`|`transport_mismatch`), `outcome` (`pass`|`block`), `reason`, `metrics jsonb`.

### Execution & positions
- `orders` — every Bybit order attempt: `signal_id`, `position_id`, `symbol`, `side`, `order_type`, `qty`, `price`, `purpose` (`entry`|`sl`|`tsl`|`tp1`|`tp2_rest`|`exit_full`|`manual_close`), `bybit_order_id`, `status` (`submitted`|`filled`|`partial`|`cancelled`|`rejected`|`error`), `error_message`, `request_payload jsonb`, `response_payload jsonb`, `submitted_at`, `finalized_at`.
- `positions` — operator-facing position state, reconciled from Bybit:
  - `symbol`, `side`, `entry_price`, `qty_initial`, `qty_open`, `leverage`, `opened_at`, `closed_at`,
  - `protection_state` (`unprotected`|`sl_only`|`sl_and_tsl`|`closed`),
  - `sl_order_id`, `sl_price`, `tsl_order_id`, `tsl_active`, `tsl_activated_at`,
  - `tp1_done boolean`, `tp1_qty`, `tp2_done boolean`,
  - `entry_signal_id`, `last_exit_signal_id`, `unprotected_since`.
- `position_events` — append-only timeline (`opened`, `sl_placed`, `sl_failed`, `tsl_activated`, `tp1_filled`, `tp2_filled`, `partial_fill`, `closed`, `drift_detected`, `manual_intervention`).

### Operations & audit
- `audit_log` — `actor_user_id`, `action`, `target`, `before jsonb`, `after jsonb`, `ip`.
- `system_alerts` — `severity` (`info`|`warning`|`critical`), `category` (`unprotected_position`, `bybit_api`, `ingest_auth`, `health_block`, `kill_switch`, `drift`, `transport_mismatch`, `unknown_strategy_code`), `message`, `context jsonb`, `acknowledged_at`, `acknowledged_by`.
- `error_log` — uncaught function errors with stack and request_id.

### Indexes
- Unique `signals.dedupe_key`.
- `signals(status, created_at)`, `orders(symbol, submitted_at)`, partial `positions(symbol) where closed_at is null`, `health_snapshots(symbol, strategy, tag, created_at desc)`, `system_alerts(severity, acknowledged_at)`.

---

## 4. Dedupe & barTime handling

Implemented in `_shared/dedupe.ts`:

- Normalize symbol first (`PIEVERSEUSDT.P` → `PIEVERSEUSDT`).
- If TradingView provides `barTime`, dedupe key =
  `normalized_symbol | action | strategy | tag | portion | barTime`.
- If `barTime` is missing, dedupe key =
  `normalized_symbol | action | strategy | tag | portion | floor(received_at / dedupe_window_seconds)`
  with `dedupe_window_seconds` default 20s, configurable in `app_settings`.
- Unique constraint on `signals.dedupe_key` makes the second insert a no-op (logged as a `dedupe` risk decision against the original signal).
- This deliberately avoids minute-bucketing, which would block two legitimate signals in the same minute.

`barTime` is parsed from both `type=stats` and `type=trade` alerts when present, stored on `signals.bar_time` and forwarded into `health_snapshots.bar_time`.

---

## 5. Signal pipeline

```text
TradingView ──webhook──▶ ingest-webhook ─┐
                                         ├─▶ raw_alerts (audit) + signals (queued)
Postmark ────email────▶ ingest-email ────┘                      │
                                                                ▼
                                                       process-signal
                                                                │
                              ┌─────────────────────────────────┤
                              ▼                                 ▼
                      type=stats → record-health        type=trade
                                                                │
                                ┌────────── action mapping ──────────┐
                                ▼                                    ▼
                        ENTER-LONG/SHORT                 EXIT-LONG/SHORT
                                │                                    │
                       Health Gate + Risk Engine          (Health bypassed)
                       transport-pref check               resolve exit_reason+portion
                                │                                    │
                          execute-entry                          execute-exit
                                │                                    │
                       Bybit fill → place fixed SL    qty from live Bybit position
                                │                       portion=tp1 → tp1_exit_percent
                       protection-monitor (cron)       portion=rest → close remainder
                                │                       sl/opposite/trend → 100%
                       TSL activation per symbol
```

Transport-pref check: if a signal arrives via a transport that doesn't match `symbols.preferred_transport` (and pref is not `either`), it's rejected with a `transport_mismatch` risk decision and a warning alert. Email is therefore valid for symbols configured for `email` or `either`.

---

## 6. Order sizing & exit quantity rules

Centralized in `_shared/sizing.ts`:

- **Entry**: quantity comes from `symbols.position_size_mode` + `position_size_value` + current equity, rounded to symbol step size. Leverage and margin mode applied per symbol.
- **TP1 (portion=tp1)**: quantity = `current_bybit_position_qty * tp1_exit_percent / 100`. If `tp2_enabled=false`, this is enforced to 100% by the symbols CHECK constraint, so TP1 closes the whole position.
- **TP2 (portion=rest)**: quantity = remaining live position size on Bybit. Always closes whatever is left, even if a partial TP1 fill or manual intervention changed things.
- **SL / failsafe / opposite / trend-fail**: close 100% of current Bybit position by default.
- All sizing is computed against a fresh Bybit position read inside `execute-exit`, not against cached `positions.qty_open`, to remain correct under drift.
- Both long and short follow the same rules, with side-aware mapping for TP/SL/opposite.

---

## 7. Dashboard information architecture

Layout: persistent left rail + top status bar (kill switch, system health pill, unprotected count). Dark navy theme; semantic tokens for `success`, `danger`, `warning`, `muted` defined in `src/styles.css`. Tabular numbers everywhere.

Routes (each its own `src/routes/*.tsx`, no hash anchors):
- `/` Overview — open positions count, protection state breakdown, today's PnL, recent signals stream, last 5 critical alerts, large EMERGENCY STOP button (typed-confirm modal).
- `/positions` — live table: symbol, side (green/red), entry, mark, PnL, protection pill, SL price, TSL state, TP1/TP2 progress. Row → drawer with full event timeline + orders.
- `/signals` — log with filters (transport, action, exit_reason, status, symbol, strategy, tag). Row → raw alert + parsed fields + dedupe key + risk decision trail.
- `/strategies` — per (strategy, tag): latest health, thresholds, enabled toggle, recent decisions.
- `/symbols` — per-symbol editor: sizing, leverage, SL %, TSL activation %/callback %, **TP2 enabled, TP1 exit %**, **preferred transport**, enable/disable. Form-level guard mirrors the DB CHECK on TP fields.
- `/alerts` — `system_alerts` inbox with acknowledge.
- `/audit` — `audit_log` + `error_log`.
- `/settings` — pause entries, kill switch, **rotate webhook secret** (shows new secret exactly once + `webhook_secret_hint`/`rotated_at`), email ingest toggle, dedupe window seconds, max concurrent positions, max daily loss.
- `/login` — Supabase Auth email/password.

Status bar (every page): kill-switch state, entries-paused, unprotected count (red if >0), Bybit connectivity dot (last successful API age), ingest health (last webhook age, last email age).

UX rules: tabular-nums, explicit protection pills (never inferred), destructive actions require typed confirmation, critical events go to `system_alerts` and the status bar (not toasts).

---

## 8. Deliverables for this phase

1. Enable Lovable Cloud.
2. Migration: enums (`app_role`, `signal_action`, `exit_reason`, `transport_pref`), `has_role` security-definer function, all tables above with RLS, CHECK constraints (TP rules), indexes, seed `strategy_codes`.
3. Seed `app_settings` single row with safe defaults (`entries_paused=false`, `emergency_stop=false`, `dedupe_window_seconds=20`).
4. Dashboard shell: routes, nav, status bar, theme tokens, login + protected layout — wired to live tables but with empty states. No Bybit calls yet.
5. Stub Edge Function files (`ingest-webhook`, `ingest-email`, `process-signal`, `execute-entry`, `execute-exit`, `protection-monitor`, `record-health`, `op-emergency-stop`, `op-bybit-proxy`, `op-rotate-webhook-secret`) with auth checks + `_shared/` skeletons (parser, normalizer, dedupe, strategy-map, sizing, bybit client) and TODOs only.

Phase 2: parser + normalizer + dedupe + strategy-map + Health Gate + Risk Engine.
Phase 3: Bybit V5 execution (entry, SL, TP1/TP2, TSL) + protection monitor.
Phase 4: email ingest provider wiring + transport-mismatch handling + alerting polish.
