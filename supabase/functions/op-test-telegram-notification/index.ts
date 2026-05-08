// Operator-only smoke test for Telegram pipeline.
import { corsHeaders, serviceClient } from "../_shared/db.ts";
import { sendTelegramAlert } from "../_shared/telegram.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supa = serviceClient();
  const { data: userRes } = await supa.auth.getUser(token);
  const uid = userRes?.user?.id;
  if (!uid) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: role } = await supa
    .from("user_roles").select("role").eq("user_id", uid).eq("role", "operator").maybeSingle();
  if (!role) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const result = await sendTelegramAlert({
    severity: "info",
    category: "test",
    bypass_dedupe: true,
    raw_text: "✅ Telegram notifications connected for TradingView → Bybit bot.",
  });

  return new Response(JSON.stringify(result), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
