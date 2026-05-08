// execution-mode — resolves which client (paper, testnet, live) executes a signal.
//
// Order of precedence:
//   1. symbols.execution_mode_override (per-symbol force)
//   2. app_settings: paper_mode_enabled OR testnet_enabled (global default)
//   3. fallback: 'paper' (safe default — never accidentally go live)
//
// Mainnet 'live' is intentionally only reachable via explicit override + a
// disabled (throwing) LiveBybitClient until Phase 4.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type ExecutionMode = "live" | "paper" | "testnet";

export async function resolveExecutionMode(
  sb: SupabaseClient,
  symbol: string,
): Promise<{ mode: ExecutionMode; source: "symbol_override" | "global" | "fallback" }> {
  const [{ data: sym }, { data: settings }] = await Promise.all([
    sb.from("symbols").select("execution_mode_override").eq("symbol", symbol).maybeSingle(),
    sb.from("app_settings").select("paper_mode_enabled,testnet_enabled").maybeSingle(),
  ]);

  const override = sym?.execution_mode_override as ExecutionMode | null | undefined;
  if (override === "live" || override === "paper" || override === "testnet") {
    return { mode: override, source: "symbol_override" };
  }
  if (settings) {
    if (settings.paper_mode_enabled) return { mode: "paper", source: "global" };
    if (settings.testnet_enabled)    return { mode: "testnet", source: "global" };
    return { mode: "live", source: "global" };
  }
  return { mode: "paper", source: "fallback" };
}
