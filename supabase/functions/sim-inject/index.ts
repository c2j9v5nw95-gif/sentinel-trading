// sim-inject — operator endpoint to push a synthetic TradingView alert
// straight into the signals table, mirroring ingest-webhook's logic but
// bypassing the secret check. Always stamps transport='webhook' (or caller's
// choice). Optionally sets a paper_market_prices tick first so the executor
// has a price. Optionally inserts a duplicate row to exercise dedupe paths.
//
// Body:
// {
//   action: 'ENTER-LONG' | 'ENTER-SHORT' | 'EXIT-LONG' | 'EXIT-SHORT' | 'HEALTH',
//   symbol, strategy?, tag?, strategy_code?, transport?,
//   bar_time?, price?, winrate?, net_profit?, profit_factor?,
//   duplicate?: boolean,           // insert two with same dedupe_key
//   bypass_dedupe?: boolean,
//   trigger?: boolean,             // immediately call process-signal
// }
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { resolveStrategyCode, actionFor } from "../_shared/strategy-map.ts";
import { buildDedupeKey } from "../_shared/dedupe.ts";
import { normalizeSymbol } from "../_shared/normalize.ts";
import { resolveTradeTimeframe, normalizeTimeframe } from "../_shared/timeframe-resolver.ts";

const STRATEGY_CODE_FOR: Record<string, string> = {
  "ENTER-LONG": "EL1", "ENTER-SHORT": "ES1",
  "EXIT-LONG": "XL3", "EXIT-SHORT": "XS3",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = serviceClient();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "").toUpperCase();
  const symbolRaw = body.symbol ? String(body.symbol) : null;
  if (!symbolRaw) {
    return new Response(JSON.stringify({ ok: false, error: "symbol_required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const symbol = normalizeSymbol(symbolRaw) ?? symbolRaw;

  const transport = (body.transport === "email") ? "email" : "webhook";
  const isHealth = action === "HEALTH";
  const code = body.strategy_code ?? STRATEGY_CODE_FOR[action] ?? null;
  const mapping = code ? resolveStrategyCode(code) : null;
  const finalAction = isHealth ? "HEALTH" : (mapping ? actionFor(mapping) : action);
  const portion = mapping?.portion ?? "full";
  const strategy = body.strategy ?? "sim";
  const tag = body.tag ?? "";
  const barTime = body.bar_time ?? new Date().toISOString();

  // Optional price tick — keeps the executor able to fill.
  if (body.price != null && Number.isFinite(Number(body.price))) {
    await sb.from("paper_market_prices").upsert({
      symbol, price: Number(body.price), source: "simulator",
      received_at: new Date().toISOString(),
    });
  }

  const payload: Record<string, unknown> = {
    type: isHealth ? "stats" : "trade",
    symbol, strategy, tag, strategy_code: code, action: finalAction,
    barTime, simulator: true,
  };
  if (body.price != null) payload.price = Number(body.price);
  if (body.winrate != null) payload.winrate = Number(body.winrate);
  if (body.net_profit != null) payload.net_profit = Number(body.net_profit);
  if (body.profit_factor != null) payload.profit_factor = Number(body.profit_factor);
  if (body.timeframe != null) payload.timeframe = String(body.timeframe);
  if (body.interval != null) payload.interval = String(body.interval);

  const { data: settings } = await sb.from("app_settings")
    .select("dedupe_window_seconds").maybeSingle();
  const windowSec = settings?.dedupe_window_seconds ?? 20;

  const dedupeBase = buildDedupeKey({
    symbol, action: finalAction, strategy, tag, portion,
    barTime, receivedAtMs: Date.now(), windowSeconds: windowSec,
  });
  const bypass = body.bypass_dedupe === true;
  const dedupe = bypass ? `${dedupeBase}|sim=${crypto.randomUUID()}` : dedupeBase;

  // Explicit body.timeframe wins (priority 0); otherwise use the standard resolver.
  const explicitTf = normalizeTimeframe(body.timeframe);
  const tfResolved = isHealth
    ? { timeframe: null, source: "none" as const }
    : explicitTf
      ? { timeframe: explicitTf, source: "payload.timeframe" as const }
      : await resolveTradeTimeframe({ sb, symbol, strategy, payload });

  const buildTrail = () => {
    const trail: Array<Record<string, unknown>> = [
      { step: "simulator_injected", outcome: "info", at: new Date().toISOString() },
    ];
    if (!isHealth) {
      trail.push({
        step: tfResolved.timeframe ? "trade_timeframe_resolved" : "trade_timeframe_unresolved",
        outcome: "info", at: new Date().toISOString(),
        metrics: { timeframe: tfResolved.timeframe, source: tfResolved.source },
      });
    }
    return trail;
  };

  const insertRow = (dk: string) => sb.from("signals").insert({
    transport, type: payload.type, action: isHealth ? "HEALTH" : finalAction,
    symbol, strategy, tag, strategy_code: code,
    entry_reason: mapping?.entryReason ?? null,
    exit_reason: mapping?.exitReason ?? null,
    portion, bar_time: barTime, payload, dedupe_key: dk,
    status: "queued", bypass_dedupe: bypass,
    trade_timeframe: tfResolved.timeframe,
    decision_trail: buildTrail(),
  }).select("id").maybeSingle();

  const first = await insertRow(dedupe);
  let duplicateResult: { id?: string | null; deduped?: boolean } | null = null;
  if (body.duplicate === true) {
    const second = await insertRow(dedupe);
    duplicateResult = {
      id: second.data?.id ?? null,
      deduped: !!second.error && second.error.code === "23505",
    };
  }

  // Fire-and-forget dispatch for the first row, like ingest-webhook does.
  if (body.trigger !== false && first.data?.id) {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-signal`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ signal_id: first.data.id }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({
    ok: true, signal_id: first.data?.id ?? null,
    deduped: !!first.error && first.error.code === "23505",
    duplicate: duplicateResult,
    payload,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
