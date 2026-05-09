import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    // SSR har ingen localStorage; la klient-siden avgjøre etter hydrering.
    // Uten denne guarden bouncer hver SSR-runde (Vite-restart, hard reload,
    // deeplink) brukeren til /login fordi getSession() returnerer null på serveren.
    if (typeof window === "undefined") return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/login" });
  },
  component: AppLayout,
});
