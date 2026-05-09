// op-bridge-public-test — operator-only verification that public Bybit market
// data (/v5/market/tickers) reaches Bybit successfully via the execution
// bridge VPS. Tries one or more symbols and returns raw retCode/retMsg plus
// result.list[0]. Read-only.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const enc = new TextEncoder();
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig); let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
async function sha256Hex(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(payload));
  const bytes = new Uint8Array(buf); let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function callBridgePublic(bridgeUrl: string, bridgeSecret: string, symbol: string) {
  const path = "/v1/bybit-call";
  const url = bridgeUrl.replace(/\/+$/, "") + path;
  const bodyObj = {
    endpoint: "/v5/market/tickers",
    method: "GET",
    query: { category: "linear", symbol },
    body: null, idempotencyKey: null,
    label: "public-test", signalId: null,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(bodyStr);
  const sigPayload = `${ts}.${nonce}.POST.${path}.${bodyHash}`;
  const signature = await hmacSha256Hex(bridgeSecret, sigPayload);
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Timestamp": ts,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": signature,
      },
      body: bodyStr,
    });
  } catch (e) {
    return { symbol, ok: false, error: `bridge_network:${(e as Error).message}`, ms: Date.now() - startedAt };
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* */ }
  const ms = Date.now() - startedAt;
  if (!res.ok || !parsed) {
    return { symbol, ok: false, http_status: res.status, raw: text.slice(0, 500), ms };
  }
  const row = parsed?.result?.list?.[0] ?? null;
  const markPrice = row ? Number(row.markPrice ?? row.lastPrice ?? NaN) : NaN;
  const markPriceMissing = !(Number.isFinite(markPrice) && markPrice > 0);
  return {
    symbol,
    ok: parsed.ok === true && parsed.ret_code === 0,
    http_status: parsed.http_status ?? res.status,
    ret_code: parsed.ret_code,
    ret_msg: parsed.ret_msg,
    ms,
    list_0: row,
    mark_price_missing: markPriceMissing,
    // Always include raw list[0] when markPrice missing for forensic logging.
    raw_list_0_when_missing: markPriceMissing ? row : undefined,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "unauthorized" }, 401);

  const sb = serviceClient();
  const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", u.user.id);
  if (!roles?.some((r) => r.role === "operator")) return json({ error: "forbidden" }, 403);

  const bridgeUrl = Deno.env.get("EXECUTION_BRIDGE_URL")?.trim();
  const bridgeSecret = Deno.env.get("EXECUTION_BRIDGE_SECRET")?.trim();
  if (!bridgeUrl || !bridgeSecret) return json({ error: "bridge_not_configured" }, 400);

  let symbols: string[] = ["LABUSDT", "PENGUUSDT"];
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (Array.isArray(body?.symbols) && body.symbols.length) {
        symbols = body.symbols.filter((s: any) => typeof s === "string");
      }
    } catch { /* ignore */ }
  }

  const results = [];
  for (const sym of symbols) {
    const r = await callBridgePublic(bridgeUrl, bridgeSecret, sym);
    if (r.mark_price_missing) {
      console.log(JSON.stringify({ evt: "public_ticker_missing_mark_price", ...r }));
    }
    results.push(r);
  }
  return json({ ok: results.every((r) => r.ok), results });
});
