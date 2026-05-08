// op-emergency-stop — JWT-protected operator action.
// Flips app_settings.emergency_stop = true. Optionally flat-closes positions.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notify } from "../_shared/telegram.ts";

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

  await sb
    .from("app_settings")
    .update({ emergency_stop: true, entries_paused: true })
    .eq("singleton", true);
  await sb.from("audit_log").insert({
    actor_user_id: u.user.id,
    action: "emergency_stop",
    target: "app_settings",
  });
  await sb.from("system_alerts").insert({
    severity: "critical",
    category: "kill_switch",
    message: `Emergency stop activated by ${u.user.email}`,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
