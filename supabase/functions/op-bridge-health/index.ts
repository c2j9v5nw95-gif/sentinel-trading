// op-bridge-health — pings the execution bridge VPS, persists a health check
// row, and raises a critical system alert + Telegram notification on
// consecutive failures (>=2). Manual trigger from the UI; safe to call by
// scheduler.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { pingBridgeHealth, recordBridgeHealth } from "../_shared/bridge-health.ts";
import { bridgeConfigured } from "../_shared/bridge-rest.ts";
import { notify } from "../_shared/telegram.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const sb = serviceClient();
  const result = await pingBridgeHealth();
  const id = await recordBridgeHealth(sb, result);

  // Consecutive-failure detection (last 2 rows including this one).
  if (!result.ok) {
    const { data: recent } = await sb.from("bridge_health_checks")
      .select("ok").order("checked_at", { ascending: false }).limit(2);
    const allFail = (recent ?? []).length >= 2 && (recent ?? []).every((r: any) => r.ok === false);
    if (allFail) {
      await sb.from("system_alerts").insert({
        severity: "critical", category: "bridge_unreachable",
        message: `Execution bridge unreachable: ${result.error ?? "unknown"}`,
        context: result as unknown as Record<string, unknown>,
      });
      notify({
        severity: "critical", category: "bridge_unreachable",
        execution_mode: "live", symbol: null,
        reason: `Execution bridge unreachable: ${result.error ?? "unknown"}`,
        extra: { latency_ms: result.latency_ms, http_status: result.http_status },
      });
    }
  }

  return new Response(JSON.stringify({
    ok: true, configured: bridgeConfigured(), check_id: id, result,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
