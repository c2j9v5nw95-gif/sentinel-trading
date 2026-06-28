import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// One-shot helper to send the password reset email to the operator account.
// Public GET endpoint: ?email=foo@bar.com — Supabase returnerer alltid OK
// uavhengig av om kontoen finnes, så dette lekker ikke eksistens.
export const Route = createFileRoute("/api/public/send-password-reset")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const email = url.searchParams.get("email");
        if (!email) {
          return new Response(JSON.stringify({ error: "missing email" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }

        const origin = url.origin;
        const redirectTo = `${origin}/reset-password`;

        const supabase = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            auth: {
              storage: undefined,
              persistSession: false,
              autoRefreshToken: false,
            },
          },
        );

        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo,
        });

        if (error) {
          return new Response(
            JSON.stringify({ ok: false, error: error.message }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ ok: true, sent_to: email, redirect_to: redirectTo }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});
