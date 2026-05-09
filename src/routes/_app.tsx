import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    // getSession() reads the cached session and auto-refreshes the access
    // token if it's near expiry. getUser() would force a network round-trip
    // and 401 the moment the access token expired, kicking the user out
    // even when their refresh token is still valid.
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/login" });
  },
  component: AppLayout,
});
