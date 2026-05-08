// ingest-webhook
// TradingView posts here. Validates secret=<TRADINGVIEW_WEBHOOK_SECRET> in payload,
// stores raw_alerts row, parses + normalizes, inserts into signals (deduped),
// returns 200 fast. Phase 2 fills in the parser → DB insert path.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { parseAlert } from "../_shared/parser.ts";
import { normalizeSymbol } from "../_shared/normalize.ts";
import { resolveStrategyCode, actionFor } from "../_shared/strategy-map.ts";
import { buildDedupeKey } from "../_shared/dedupe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = serviceClient();
  const ip = req.headers.get("x-forwarded-for") ?? "";
  const headers = Object.fromEntries(req.headers);
  const bodyText = await req.text();

  // Authenticate via secret= field (works in JSON or key=value alerts).
  const expected = Deno.env.get("TRADINGVIEW_WEBHOOK_SECRET");
  let providedSecret: string | undefined;
  try {
    const j = JSON.parse(bodyText);
    providedSecret = typeof j?.secret === "string" ? j.secret : undefined;
  } catch {
    const m = bodyText.match(/(?:^|\n)\s*secret\s*=\s*([^\n\r]+)/);
    providedSecret = m?.[1]?.trim();
  }
  const authOk = !!expected && providedSecret === expected;

  if (!authOk) {
    await sb.from("raw_alerts").insert({
      transport: "webhook",
      remote_ip: ip,
      headers,
      body_text: bodyText,
      auth_status: providedSecret ? "bad_secret" : "malformed",
    });
    await sb.from("system_alerts").insert({
      severity: "warning",
      category: "ingest_auth",
      message: "Webhook rejected: missing or invalid secret",
      context: { ip },
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const parsed = parseAlert(bodyText);
  if (!parsed) {
    await sb.from("raw_alerts").insert({
      transport: "webhook",
      remote_ip: ip,
      headers,
      body_text: bodyText,
      auth_status: "malformed",
    });
    return new Response("Bad payload", { status: 400 });
  }

  const symbol = normalizeSymbol(parsed.symbol);
  const strategy = parsed.strategy ?? "";
  const tag = parsed.tag ?? "";
  const mapping = resolveStrategyCode(parsed.strategy_code);
  const action = parsed.type === "stats" ? "HEALTH" : (mapping ? actionFor(mapping) : null);
  const portion = mapping?.portion ?? "full";

  // Dedupe window from app_settings
  const { data: settings } = await sb
    .from("app_settings")
    .select("dedupe_window_seconds")
    .maybeSingle();
  const windowSeconds = settings?.dedupe_window_seconds ?? 20;

  const dedupeKey = buildDedupeKey({
    symbol: symbol ?? "?",
    action: action ?? "?",
    strategy,
    tag,
    portion,
    barTime: parsed.bar_time,
    receivedAtMs: Date.now(),
    windowSeconds,
  });

  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const initialTrail = [
    { step: "parser_pass", outcome: "pass", at: nowIso },
    { step: "normalized_symbol", outcome: "info",
      metrics: { raw: parsed.symbol ?? null, normalized: symbol }, at: nowIso },
    { step: "dedupe_pass", outcome: "pass", at: nowIso },
  ];

  const { data: signal, error: insertErr } = await sb
    .from("signals")
    .insert({
      transport: "webhook",
      type: parsed.type,
      action,
      symbol,
      strategy,
      tag,
      strategy_code: parsed.strategy_code ?? null,
      entry_reason: mapping?.entryReason ?? null,
      exit_reason: mapping?.exitReason ?? null,
      portion,
      bar_time: parsed.bar_time ?? null,
      payload: parsed.raw,
      dedupe_key: dedupeKey,
      status: "queued",
      request_id: requestId,
      decision_trail: initialTrail,
    })
    .select("id")
    .maybeSingle();

  // dedupe collision = unique violation; treat as benign
  const dedupeHit = !!insertErr && (insertErr.code === "23505");

  await sb.from("raw_alerts").insert({
    transport: "webhook",
    remote_ip: ip,
    headers,
    body_text: bodyText,
    auth_status: "ok",
    signal_id: signal?.id ?? null,
  });

  // Fire-and-forget dispatcher trigger (sub-second latency, doesn't block ACK).
  if (signal?.id) {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/process-signal`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ signal_id: signal.id }),
      signal: ctrl.signal,
    }).catch(() => { /* swallow; cron is the safety net */ }).finally(() => clearTimeout(t));
  }

  return new Response(
    JSON.stringify({ ok: true, signal_id: signal?.id ?? null, dedupe: dedupeHit }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
