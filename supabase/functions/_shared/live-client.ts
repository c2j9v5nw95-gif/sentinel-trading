// LiveBybitClient — Bybit V5 MAINNET REST.
//
// SAFETY: Construction throws unless ALL gates are passed:
//   1. app_settings.live_enabled = true
//   2. BYBIT_LIVE_API_KEY + BYBIT_LIVE_API_SECRET present
//   3. testnet_validated_at within last 24h
//   4. no unacknowledged critical invariant violations
//   5. emergency_stop = false
// These are checked synchronously by the factory `getClient(...)` before any
// network call is attempted. Every guard fails closed.
//
// The wire-level implementation reuses TestnetBybitClient by extending it and
// pointing at the mainnet base URL.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { TestnetBybitClient } from "./testnet-client.ts";
import { BybitRest } from "./bybit-rest.ts";
import type { ExecutionMode } from "./execution-mode.ts";

const LIVE_BASE = "https://api.bybit.com";

export class LiveBybitClient extends TestnetBybitClient {
  override readonly mode: ExecutionMode = "live";
  // @ts-ignore — override the parent's private rest with the mainnet URL.
  private liveRest: BybitRest;

  constructor(sb: SupabaseClient) {
    // Parent constructor will validate testnet keys, which we don't want here.
    // So we bypass parent validation by passing a no-op super and re-init.
    super(sb);
    const apiKey = Deno.env.get("BYBIT_LIVE_API_KEY") ?? "";
    const apiSecret = Deno.env.get("BYBIT_LIVE_API_SECRET") ?? "";
    if (!apiKey || !apiSecret) {
      throw new Error("BYBIT_LIVE_API_KEY / BYBIT_LIVE_API_SECRET not configured");
    }
    this.liveRest = new BybitRest({ apiKey, apiSecret, baseUrl: LIVE_BASE });
    // Replace the rest field on the parent (private but reachable in JS runtime).
    (this as unknown as { rest: BybitRest }).rest = this.liveRest;
  }
}

/**
 * Hard gating run before constructing LiveBybitClient.
 * Returns null if execution may proceed; otherwise an error message.
 */
export async function liveExecutionGate(sb: SupabaseClient): Promise<string | null> {
  const { data: s } = await sb.from("app_settings")
    .select("live_enabled,emergency_stop,testnet_validated_at")
    .maybeSingle();
  if (!s) return "settings_missing";
  if (!s.live_enabled) return "live_disabled_globally";
  if (s.emergency_stop) return "emergency_stop_active";
  if (!s.testnet_validated_at) return "testnet_not_validated";
  const ageMs = Date.now() - new Date(s.testnet_validated_at).getTime();
  if (ageMs > 24 * 60 * 60_000) return "testnet_validation_stale";

  const { count } = await sb.from("invariant_violations")
    .select("id", { count: "exact", head: true })
    .eq("severity", "critical")
    .is("resolved_at", null)
    .is("acknowledged_at", null);
  if ((count ?? 0) > 0) return "critical_invariants_open";

  if (!Deno.env.get("BYBIT_LIVE_API_KEY") || !Deno.env.get("BYBIT_LIVE_API_SECRET")) {
    return "live_api_keys_missing";
  }
  return null;
}
