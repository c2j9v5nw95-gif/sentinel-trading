// Symbol-level execution locks — TypeScript wrapper for the SQL functions.
//
// Usage:
//   const result = await withSymbolLock(sb, "BTCUSDT", "entry", { signalId, jobId }, async (lock) => {
//     // ... do Bybit work; periodically lock.heartbeatOk() will be false if we got preempted.
//   });
//
// Heartbeat runs in the background. If it returns false (lock lost / preempted),
// the consumer's `lock.aborted` flag flips to true. Worker code must check this
// flag at every safe abort point (especially before submitting Bybit orders).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type LockKind = "entry" | "exit" | "replay" | "reconcile" | "protect" | "manual";

// One owner id per worker process boot. Edge Functions get a fresh id per cold start.
export const WORKER_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

const TTL_BY_KIND: Record<LockKind, { ttlSec: number; heartbeatMs: number }> = {
  entry:     { ttlSec: 30, heartbeatMs: 5_000 },
  exit:      { ttlSec: 30, heartbeatMs: 5_000 },
  replay:    { ttlSec: 30, heartbeatMs: 5_000 },
  reconcile: { ttlSec: 60, heartbeatMs: 10_000 },
  protect:   { ttlSec: 20, heartbeatMs: 5_000 },
  manual:    { ttlSec: 300, heartbeatMs: 60_000 },
};

export interface AcquireResult {
  granted: boolean;
  reentrant?: boolean;
  preempted?: boolean;
  took_over?: boolean;
  holder_kind?: LockKind;
  holder_owner_id?: string;
  expires_at?: string;
  previous_kind?: LockKind;
  previous_owner_id?: string;
}

export interface LockHandle {
  symbol: string;
  kind: LockKind;
  ownerId: string;
  /** Set to true if a heartbeat has reported the lock as lost (preempted/expired). */
  aborted: boolean;
  /** Stop the heartbeat timer. Called by withSymbolLock's finally. */
  stop(): void;
}

export async function acquireLock(
  sb: SupabaseClient,
  symbol: string,
  kind: LockKind,
  opts: { jobId?: string | null; signalId?: string | null; allowPreempt?: boolean; ttlSec?: number } = {},
): Promise<AcquireResult> {
  const ttl = opts.ttlSec ?? TTL_BY_KIND[kind].ttlSec;
  const { data, error } = await sb.rpc("acquire_execution_lock", {
    _symbol: symbol,
    _kind: kind,
    _owner_id: WORKER_ID,
    _job_id: opts.jobId ?? null,
    _signal_id: opts.signalId ?? null,
    _ttl_seconds: ttl,
    _allow_preempt: opts.allowPreempt ?? (kind === "exit"),
  });
  if (error) throw new Error(`acquireLock failed: ${error.message}`);
  return (data ?? { granted: false }) as AcquireResult;
}

export async function heartbeat(sb: SupabaseClient, symbol: string): Promise<boolean> {
  const { data, error } = await sb.rpc("heartbeat_execution_lock", {
    _symbol: symbol,
    _owner_id: WORKER_ID,
  });
  if (error) return false;
  return data === true;
}

export async function releaseLock(sb: SupabaseClient, symbol: string): Promise<boolean> {
  const { data, error } = await sb.rpc("release_execution_lock", {
    _symbol: symbol,
    _owner_id: WORKER_ID,
  });
  if (error) return false;
  return data === true;
}

export async function withSymbolLock<T>(
  sb: SupabaseClient,
  symbol: string,
  kind: LockKind,
  opts: { jobId?: string | null; signalId?: string | null; allowPreempt?: boolean; ttlSec?: number },
  fn: (lock: LockHandle) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: "symbol_busy" | "error"; details: AcquireResult | string }> {
  const acquired = await acquireLock(sb, symbol, kind, opts);
  if (!acquired.granted) {
    return { ok: false, reason: "symbol_busy", details: acquired };
  }

  const beatMs = TTL_BY_KIND[kind].heartbeatMs;
  const handle: LockHandle = {
    symbol, kind, ownerId: WORKER_ID, aborted: false,
    stop: () => clearInterval(timer),
  };
  const timer = setInterval(async () => {
    const ok = await heartbeat(sb, symbol);
    if (!ok) handle.aborted = true;
  }, beatMs);

  try {
    const value = await fn(handle);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: "error", details: (e as Error).message };
  } finally {
    handle.stop();
    if (!handle.aborted) {
      await releaseLock(sb, symbol);
    }
  }
}
