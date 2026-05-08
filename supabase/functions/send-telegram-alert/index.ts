// JWT-protected. Authenticated operator can trigger an alert through Telegram.
// Service-role callers (other edge functions) can also invoke it via Authorization: Bearer SERVICE_ROLE_KEY.
import { corsHeaders, serviceClient } from "../_shared/db.ts";
import { sendTelegramAlert, AlertPayload } from "../_shared/telegram.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Auth: allow service-role OR operator JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  let allowed = false;
  if (token && token === serviceKey) {
    allowed = true;
  } else if (token) {
    const supa = serviceClient();
    const { data: userRes } = await supa.auth.getUser(token);
    const uid = userRes?.user?.id;
    if (uid) {
      const { data: role } = await supa
        .from("user_roles").select("role").eq("user_id", uid).eq("role", "operator").maybeSingle();
      if (role) allowed = true;
    }
  }
  if (!allowed) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let payload: AlertPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!payload?.severity || !payload?.category) {
    return new Response(JSON.stringify({ error: "missing severity/category" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const result = await sendTelegramAlert(payload);
  return new Response(JSON.stringify(result), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
