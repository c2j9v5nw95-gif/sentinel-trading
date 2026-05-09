// ingest-webhook
// Public endpoint — TradingView posts here.
// Authenticates via `secret=<TRADINGVIEW_WEBHOOK_SECRET>` field in the alert
// payload (semicolon-separated key=value, newline-separated, or JSON).
// Stores raw_alerts row, parses + normalizes, inserts into signals (deduped),
// returns 200 fast. Repeated unauthorized attempts trigger a critical Telegram
// alert (one per 10-minute bucket, gated through the standard notify pipeline).
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { parseAlert, extractSecret, type AlertAction } from "../_shared/parser.ts";
import { normalizeSymbol } from "../_shared/normalize.ts";
import { resolveStrategyCode, actionFor } from "../_shared/strategy-map.ts";
import { buildDedupeKey } from "../_shared/dedupe.ts";
import { notify } from "../_shared/telegram.ts";

const UNAUTH_ALERT_THRESHOLD = 5;
const UNAUTH_ALERT_WINDOW_MIN = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = serviceClient();
  const ip = req.headers.get("x-forwarded-for") ?? "";
  const headers = Object.fromEntries(req.headers);
  const bodyText = await req.text();

  const expected = Deno.env.get("TRADINGVIEW_WEBHOOK_SECRET");
  let urlToken: string | undefined;
  try { urlToken = new URL(req.url).searchParams.get("token") ?? undefined; } catch { /* ignore */ }
  const providedSecret = extractSecret(bodyText);

  // Constant-time compare
  const eq = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  };

  let authMethod: "url_token" | "payload_secret" | "none" = "none";
  if (expected) {
    if (urlToken && eq(urlToken, expected)) authMethod = "url_token";
    else if (providedSecret && eq(providedSecret, expected)) authMethod = "payload_secret";
  }
  const authOk = authMethod !== "none";

  if (!authOk) {
    const status = (urlToken || providedSecret) ? "bad_secret" : "malformed";
    await sb.from("raw_alerts").insert({
      transport: "webhook",
      remote_ip: ip,
      headers,
      body_text: bodyText,
      auth_status: status,
      auth_method: urlToken ? "url_token" : (providedSecret ? "payload_secret" : "none"),
    });
    await sb.from("system_alerts").insert({
      severity: "warning",
      category: "ingest_auth",
      message: `Webhook rejected: ${status}`,
      context: { ip },
    });

    // Burst detection — if N+ failures in last window, escalate via Telegram.
    const since = new Date(Date.now() - UNAUTH_ALERT_WINDOW_MIN * 60_000).toISOString();
    const { count } = await sb
      .from("raw_alerts")
      .select("id", { count: "exact", head: true })
      .in("auth_status", ["bad_secret", "malformed"])
      .gte("created_at", since);
    if ((count ?? 0) >= UNAUTH_ALERT_THRESHOLD) {
      notify({
        severity: "critical",
        category: "dead_letter",
        reason: `Unauthorized webhook burst: ${count} attempts in ${UNAUTH_ALERT_WINDOW_MIN}m`,
        extra: { ip, last_status: status, window_minutes: UNAUTH_ALERT_WINDOW_MIN },
        raw_text: `🚨 <b>WEBHOOK ABUSE</b>\n${count} unauthorized attempts in last ${UNAUTH_ALERT_WINDOW_MIN}m\nLast IP: <code>${ip || "unknown"}</code>\nStatus: ${status}`,
      });
    }
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
      auth_method: authMethod,
    });
    return new Response("Bad payload", { status: 400 });
  }

  const symbol = normalizeSymbol(parsed.symbol);
  const mapping = resolveStrategyCode(parsed.strategy_code);

  // Action resolution — explicit `action=` takes precedence; fall back to
  // strategy-code mapping (e.g. EL1 → ENTER-LONG) for legacy alerts.
  let action: AlertAction | null = null;
  if (parsed.type === "stats") {
    action = "HEALTH";
  } else if (parsed.action) {
    action = parsed.action;
  } else if (mapping) {
    action = actionFor(mapping);
  }

  // Portion: explicit `portion=REST` overrides the strategy-code default.
  let portion: "full" | "tp1" | "rest" = mapping?.portion ?? "full";
  if (parsed.portion) {
    const p = parsed.portion.toLowerCase();
    if (p === "rest") portion = "rest";
    else if (p === "tp1") portion = "tp1";
    else if (p === "full") portion = "full";
  }

  const strategy = parsed.strategy ?? "";
  const tag = parsed.tag ?? "";

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
    { step: "parser_pass", outcome: "pass", at: nowIso,
      metrics: { action, strategy_code: parsed.strategy_code ?? null, portion } },
    { step: "normalized_symbol", outcome: "info",
      metrics: { raw: parsed.raw_ticker ?? null, normalized: symbol }, at: nowIso },
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

  const dedupeHit = !!insertErr && (insertErr.code === "23505");

  await sb.from("raw_alerts").insert({
    transport: "webhook",
    remote_ip: ip,
    headers,
    body_text: bodyText,
    auth_status: "ok",
    auth_method: authMethod,
    signal_id: signal?.id ?? null,
  });

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
    JSON.stringify({
      ok: true,
      signal_id: signal?.id ?? null,
      dedupe: dedupeHit,
      parsed: { action, symbol, strategy_code: parsed.strategy_code ?? null, portion },
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
