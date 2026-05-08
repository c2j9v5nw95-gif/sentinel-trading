// ingest-email
// Inbound email from Postmark/SendGrid. Validates provider basic-auth
// + shared secret, extracts the alert body, runs through the same parser
// as ingest-webhook. Phase 4 wires the actual provider headers/format.
import { serviceClient, corsHeaders } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = serviceClient();

  const auth = req.headers.get("authorization") ?? "";
  const expected = Deno.env.get("EMAIL_INGEST_BASIC_AUTH");
  if (!expected || auth !== `Basic ${expected}`) {
    await sb.from("system_alerts").insert({
      severity: "warning",
      category: "ingest_auth",
      message: "Email ingest rejected: bad basic auth",
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const bodyText = await req.text();
  await sb.from("raw_alerts").insert({
    transport: "email",
    body_text: bodyText,
    auth_status: "ok",
    headers: Object.fromEntries(req.headers),
  });

  // TODO Phase 4: extract TradingView alert body from provider envelope,
  // then reuse parser + dedupe + signals insert from ingest-webhook.

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
