import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function TopBrandBar() {
  const { data: settings } = useQuery({
    queryKey: ["mobile", "app_settings"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("*").maybeSingle();
      return data;
    },
    refetchInterval: 10_000,
  });

  const mode: "live" | "paper" | "testnet" = settings?.live_enabled
    ? "live"
    : settings?.paper_mode_enabled
    ? "paper"
    : "testnet";

  const tone =
    mode === "live"
      ? "border-danger/50 bg-danger/15 text-danger"
      : mode === "paper"
      ? "border-warning/50 bg-warning/15 text-warning"
      : "border-success/40 bg-success/10 text-success";

  return (
    <header className="flex items-center justify-between px-4 pb-2 pt-3">
      <div>
        <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Pulse
        </div>
        <div className="text-base font-semibold tracking-tight">TV → Bybit</div>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${tone}`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            mode === "live" ? "bg-danger animate-pulse" : mode === "paper" ? "bg-warning" : "bg-success"
          }`}
        />
        {mode}
      </span>
    </header>
  );
}
