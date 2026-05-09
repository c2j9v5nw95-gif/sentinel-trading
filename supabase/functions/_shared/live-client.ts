// LiveBybitClient — Bybit V5 MAINNET REST.
//
// SAFETY: Live is intentionally independent from TestnetBybitClient. It never
// constructs testnet code paths and never requires BYBIT_TESTNET_* credentials.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { VenueBybitClient } from "./venue-client.ts";

const LIVE_BASE = "https://api.bybit.com";

export class LiveBybitClient extends VenueBybitClient {
  constructor(sb: SupabaseClient) {
    super(sb, {
      mode: "live",
      baseUrl: LIVE_BASE,
      apiKey: Deno.env.get("BYBIT_LIVE_API_KEY") ?? "",
      apiSecret: Deno.env.get("BYBIT_LIVE_API_SECRET") ?? "",
    });
  }
}

/**
 * Hard gating run before constructing LiveBybitClient.
 * Returns null if execution may proceed; otherwise an error message.
 */
export async function liveExecutionGate(sb: SupabaseClient): Promise<string | null> {
  const { data: s } = await sb.from("app_settings")
    .select("live_enabled,emergency_stop,live_risk_halted")
    .maybeSingle();
  if (!s) return "settings_missing";
  if (!s.live_enabled) return "live_disabled_globally";
  if (s.emergency_stop) return "emergency_stop_active";
  if (s.live_risk_halted) return "live_risk_breaker_tripped";

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
