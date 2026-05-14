import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { MobileShell } from "@/components/mobile/shell/MobileShell";

export const Route = createFileRoute("/m")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/login" });
  },
  component: () => (
    <MobileShell>
      <Outlet />
    </MobileShell>
  ),
});
