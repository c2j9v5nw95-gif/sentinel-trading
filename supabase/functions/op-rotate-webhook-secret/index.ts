// op-rotate-webhook-secret
// Generates a new TradingView webhook secret, stores it in Edge Function
// secrets via the Supabase management API (Phase 2 wiring), updates
// app_settings.webhook_secret_{rotated_at,version,hint}, and returns the
// new secret to the operator exactly once. The plaintext secret is NEVER
// stored in the database.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function genSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
  if (!u.user) return new Response("Unauthorized", { status: 401 });

  const sb = serviceClient();
  const { data: roles } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", u.user.id);
  if (!roles?.some((r) => r.role === "operator")) {
    return new Response("Forbidden", { status: 403 });
  }

  const newSecret = genSecret();
  const hint = newSecret.slice(-4);

  // TODO: write newSecret to Edge Function secret TRADINGVIEW_WEBHOOK_SECRET
  // via the Supabase management API. For now, the operator copies it manually.

  const { data: existing } = await sb
    .from("app_settings")
    .select("webhook_secret_version")
    .maybeSingle();
  const version = (existing?.webhook_secret_version ?? 0) + 1;

  await sb
    .from("app_settings")
    .update({
      webhook_secret_version: version,
      webhook_secret_rotated_at: new Date().toISOString(),
      webhook_secret_hint: hint,
    })
    .eq("singleton", true);

  await sb.from("audit_log").insert({
    actor_user_id: u.user.id,
    action: "rotate_webhook_secret",
    target: "TRADINGVIEW_WEBHOOK_SECRET",
    after: { version, hint },
  });

  return new Response(
    JSON.stringify({ ok: true, secret: newSecret, version, hint, shown_once: true }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
