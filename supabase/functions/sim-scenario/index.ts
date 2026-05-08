// sim-scenario — orchestrates multi-step simulation presets.
// All steps run server-side so the operator UI doesn't need to keep an open
// connection. Each step appends to scenario_runs.steps for live-tail.
//
// Body: { preset, symbol, strategy?, tag?, base_price? }
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type Step =
  | { kind: "inject"; action: string; strategy_code?: string; price?: number; duplicate?: boolean }
  | { kind: "tick"; price: number }
  | { kind: "wait"; ms: number }
  | { kind: "monitor" }
  | { kind: "lock"; symbol: string; ttl: number };

const PRESETS: Record<string, (s: { symbol: string; basePrice: number }) => Step[]> = {
  tp1_then_tp2: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice },
    { kind: "wait", ms: 1500 },
    { kind: "tick", price: basePrice * 1.01 },
    { kind: "inject", action: "EXIT-LONG", strategy_code: "XL1", price: basePrice * 1.01 },
    { kind: "wait", ms: 1500 },
    { kind: "tick", price: basePrice * 1.02 },
    { kind: "inject", action: "EXIT-LONG", strategy_code: "XL4", price: basePrice * 1.02 },
  ],
  sl_after_entry: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice },
    { kind: "wait", ms: 1500 },
    { kind: "tick", price: basePrice * 0.97 }, // below default SL of 1.5%
    { kind: "monitor" },
  ],
  opposite_signal_exit: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice },
    { kind: "wait", ms: 1500 },
    { kind: "inject", action: "EXIT-LONG", strategy_code: "XL3", price: basePrice * 0.999 },
  ],
  duplicate_webhook_retry: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice, duplicate: true },
  ],
  stale_health: ({ symbol }) => [
    { kind: "inject", action: "HEALTH" },
  ],
  transport_mismatch: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice }, // sim-inject defaults to webhook; symbols.preferred_transport may differ
  ],
  dead_letter_recovery: ({ symbol }) => [
    // No price tick — entry will fail with no_mark_price and re-queue/dead-letter.
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1" },
    { kind: "wait", ms: 1500 },
    { kind: "tick", price: 100 },
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: 100 },
  ],
  lock_contention: ({ symbol, basePrice }) => [
    { kind: "lock", symbol, ttl: 8 },
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice },
  ],
  reconciliation_drift: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice },
    { kind: "wait", ms: 1500 },
    // Operator clears local position outside flow → drift; here we just trigger monitor.
    { kind: "monitor" },
  ],
  tsl_activation: ({ symbol, basePrice }) => [
    { kind: "inject", action: "ENTER-LONG", strategy_code: "EL1", price: basePrice },
    { kind: "wait", ms: 1500 },
    { kind: "tick", price: basePrice * 1.015 },
    { kind: "monitor" }, // activates TSL (default activation 1%)
    { kind: "tick", price: basePrice * 1.025 },
    { kind: "monitor" }, // moves high-water
    { kind: "tick", price: basePrice * 1.018 },
    { kind: "monitor" }, // triggers TSL exit
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callFn(path: string, body: unknown): Promise<unknown> {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${path}`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

async function appendStep(sb: SupabaseClient, runId: string, entry: Record<string, unknown>) {
  const { data } = await sb.from("scenario_runs").select("steps").eq("id", runId).maybeSingle();
  const steps = (data?.steps as unknown[] ?? []).concat([{ ...entry, at: new Date().toISOString() }]);
  await sb.from("scenario_runs").update({ steps }).eq("id", runId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = serviceClient();
  const body = await req.json().catch(() => ({}));
  const preset = String(body.preset ?? "");
  const symbol = String(body.symbol ?? "BTCUSDT").toUpperCase();
  const basePrice = Number(body.base_price ?? 100);
  const builder = PRESETS[preset];
  if (!builder) {
    return new Response(JSON.stringify({ ok: false, error: "unknown_preset", presets: Object.keys(PRESETS) }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: run } = await sb.from("scenario_runs").insert({
    preset, symbol, status: "running", steps: [],
  }).select("id").single();
  const runId = run!.id;

  const steps = builder({ symbol, basePrice });

  // Run in background — return runId immediately.
  (async () => {
    try {
      for (const s of steps) {
        if (s.kind === "wait") {
          await sleep(s.ms);
          await appendStep(sb, runId, { kind: "wait", ms: s.ms });
        } else if (s.kind === "tick") {
          await sb.from("paper_market_prices").upsert({
            symbol, price: s.price, source: "scenario",
            received_at: new Date().toISOString(),
          });
          await appendStep(sb, runId, { kind: "tick", price: s.price });
        } else if (s.kind === "inject") {
          const r = await callFn("sim-inject", {
            action: s.action, symbol, strategy: body.strategy ?? "sim",
            tag: body.tag ?? "", strategy_code: s.strategy_code,
            price: s.price, duplicate: s.duplicate,
          });
          await appendStep(sb, runId, { kind: "inject", action: s.action, result: r });
          await sleep(800); // give dispatcher a moment
        } else if (s.kind === "monitor") {
          const r = await callFn("protection-monitor", {});
          await appendStep(sb, runId, { kind: "monitor", result: r });
        } else if (s.kind === "lock") {
          await sb.rpc("acquire_execution_lock", {
            _symbol: s.symbol, _kind: "manual", _owner_id: `scenario:${runId}`,
            _job_id: null, _signal_id: null, _ttl_seconds: s.ttl, _allow_preempt: true,
          });
          await appendStep(sb, runId, { kind: "lock", symbol: s.symbol, ttl: s.ttl });
        }
      }
      await sb.from("scenario_runs").update({
        status: "completed", finished_at: new Date().toISOString(),
      }).eq("id", runId);
    } catch (e) {
      await appendStep(sb, runId, { kind: "error", message: (e as Error).message });
      await sb.from("scenario_runs").update({
        status: "failed", finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }
  })();

  return new Response(JSON.stringify({ ok: true, run_id: runId, preset, steps: steps.length }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
