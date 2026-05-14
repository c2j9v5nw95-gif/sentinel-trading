## Part 1 — Cosmetic fix: stop stamping `trade_timeframe_*` trail on HEALTH (APPROVED)

- `supabase/functions/ingest-webhook/index.ts` — only push the `trade_timeframe_resolved`/`unresolved` trail entry when `parsed.type === 'trade'`.
- `supabase/functions/sim-inject/index.ts` — only push it when `!isHealth`.
- HEALTH still inserts with `trade_timeframe = null`, no trail noise. No schema change.

---

## Part 2 — Phase 2B: auto-trigger `snapshot-signal-context` (revised auth)

**Mechanism unchanged:** Postgres `AFTER INSERT` trigger on `public.signals` calls the existing `/api/public/hooks/snapshot-signal-context` route via `pg_net.http_post`. Async, fire-and-forget; replay/sim-inject/ingest-webhook all covered automatically. Trade-only filter, idempotent writer, never blocks insert.

**Hardened auth — dedicated `SNAPSHOT_HOOK_SECRET` (no anon key, no client exposure).**

Two storage locations for the same value, populated once by the operator:

1. **Runtime secret** `SNAPSHOT_HOOK_SECRET` (added via the secrets tool; surfaces as `process.env.SNAPSHOT_HOOK_SECRET`). Read by the route handler. Never bundled to client.
2. **DB-only mirror** in a new table `public.internal_hook_config(name text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`. RLS enabled, **zero policies** → invisible to all PostgREST/client roles. Only `SECURITY DEFINER` functions can read it.

**Migration (single SQL).**

1. `CREATE EXTENSION IF NOT EXISTS pg_net;`
2. `CREATE TABLE public.internal_hook_config (...)` + `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` (no policies → fully locked).
3. `ALTER TABLE public.app_settings ADD COLUMN auto_snapshot_signal_context_enabled boolean NOT NULL DEFAULT true;`
   `ALTER TABLE public.app_settings ADD COLUMN snapshot_signal_context_url text;`
   (URL is non-sensitive; it stays in `app_settings`. The secret does NOT.)
4. `CREATE FUNCTION public.trigger_snapshot_signal_context()` `SECURITY DEFINER`, `SET search_path = public`:

```text
RETURNS TRIGGER AS $$
DECLARE
  cfg public.app_settings%ROWTYPE;
  hook_secret text;
BEGIN
  IF NEW.type <> 'trade' THEN RETURN NEW; END IF;

  SELECT * INTO cfg FROM public.app_settings WHERE singleton = true;
  IF NOT cfg.auto_snapshot_signal_context_enabled
     OR cfg.snapshot_signal_context_url IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT value INTO hook_secret
  FROM public.internal_hook_config
  WHERE name = 'snapshot_hook_secret';
  IF hook_secret IS NULL THEN RETURN NEW; END IF;

  BEGIN
    PERFORM net.http_post(
      url     := cfg.snapshot_signal_context_url,
      headers := jsonb_build_object(
                   'Content-Type','application/json',
                   'X-Snapshot-Hook-Secret', hook_secret),
      body    := jsonb_build_object('signal_id', NEW.id),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.error_log(source, message, context)
    VALUES ('trigger_snapshot_signal_context', SQLERRM,
            jsonb_build_object('signal_id', NEW.id, 'sqlstate', SQLSTATE));
  END;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

5. `CREATE TRIGGER trg_signals_auto_snapshot AFTER INSERT ON public.signals FOR EACH ROW EXECUTE FUNCTION public.trigger_snapshot_signal_context();`
6. Revoke any default grants on `public.internal_hook_config` from `anon` and `authenticated` (defensive — RLS already blocks, but no grants belt-and-braces).

**Route hardening (`src/routes/api/public/hooks/snapshot-signal-context.ts`).**

Replace the current `apikey`-based check with:

```text
const expected = process.env.SNAPSHOT_HOOK_SECRET;
if (!expected) return json({ error: 'unconfigured' }, 503);
const got = req.headers.get('x-snapshot-hook-secret');
if (!got || got.length !== expected.length
    || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
  return json({ error: 'unauthorized' }, 401);
}
```

The `apikey` / anon-key path is removed. The endpoint is no longer callable from the browser; only the DB trigger (and operator curl with the secret) can reach it.

**Operator setup (one-time, two steps).**
1. Add runtime secret `SNAPSHOT_HOOK_SECRET` (random 32+ byte token) via the secrets tool — surfaces to the route.
2. Run a one-shot data update (insert tool):
   - `INSERT INTO public.internal_hook_config(name, value) VALUES ('snapshot_hook_secret', '<same value>') ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`
   - `UPDATE public.app_settings SET snapshot_signal_context_url = '<https://.../api/public/hooks/snapshot-signal-context>' WHERE singleton = true;`

Until both halves are populated, the trigger is a silent no-op (kill switch by omission). `auto_snapshot_signal_context_enabled = false` is the explicit runtime kill switch.

**Failure semantics (unchanged).** Non-trade → no-op. Disabled / URL or secret missing → no-op. Any SQL error in trigger → caught, logged to `error_log`, insert always commits. HTTP errors observable in `net._http_response` and `analytics_snapshot_runs`.

**Out of scope (unchanged).** No cron. No regime automation. No execution/dispatcher/risk/sizing changes. No backfill. No edits to `snapshotSignalContext` or `replay_signal`.

---

## Sequencing

1. Land Part 1 cosmetic fix; validate HEALTH row decision_trail no longer carries a `trade_timeframe_*` entry, trade rows still do.
2. Land Part 2 migration + route hardening.
3. Operator: add `SNAPSHOT_HOOK_SECRET` runtime secret, then mirror it into `internal_hook_config` and set the URL in `app_settings`.
4. Validate: insert trade signal via `sim-inject` → snapshot row appears within seconds; insert HEALTH → no trigger fire; flip `auto_snapshot_signal_context_enabled = false` → silent; hit the route from the browser with no/invalid header → 401.
5. Phase 2C (regime automation, screener) builds on this.