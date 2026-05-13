import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PageHeader";
import { EquityCard } from "@/components/overview/EquityCard";
import { OverviewFilterBar } from "@/components/overview/OverviewFilterBar";
import type { RangeKey } from "@/components/overview/filters";
import { UnrealizedPnLCard } from "@/components/overview/UnrealizedPnLCard";
import { RealizedPnLTodayCard } from "@/components/overview/RealizedPnLTodayCard";
import { BridgeHealthCard } from "@/components/overview/BridgeHealthCard";
import { ActiveExposurePanel } from "@/components/overview/ActiveExposurePanel";
import { RecoveryAlertBanner } from "@/components/overview/RecoveryAlertBanner";
import { ActivePositionsTable } from "@/components/overview/ActivePositionsTable";
import { RecentClosedTradesTable } from "@/components/overview/RecentClosedTradesTable";
import { RecentExecutionEventsList } from "@/components/overview/RecentExecutionEventsList";
import { SymbolHealthPanel } from "@/components/overview/SymbolHealthPanel";

export const Route = createFileRoute("/_app/overview")({
  component: Overview,
});

function Overview() {
  const { data: settings } = useQuery({
    queryKey: ["overview", "app_settings_live"],
    queryFn: async () => {
      const { data } = await supabase
        .from("app_settings")
        .select("live_enabled")
        .maybeSingle();
      return data;
    },
    refetchInterval: 30_000,
  });

  const live = !!settings?.live_enabled;
  const source = live ? "live" : "paper";

  const [range, setRange] = useState<RangeKey>("24h");
  const [symbol, setSymbol] = useState<string | null>(null);

  const { data: latestEquity } = useQuery({
    queryKey: ["overview", "latest_equity", source],
    queryFn: async () => {
      const { data } = await supabase
        .from("balance_snapshots")
        .select("total_equity")
        .eq("source", source)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.total_equity ? Number(data.total_equity) : null;
    },
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader
        title="Overview"
        description="Mission control · read-only operator view."
        actions={<EmergencyStopButton />}
      />

      <div className="mt-2">
        <OverviewFilterBar
          range={range}
          symbol={symbol}
          onRangeChange={setRange}
          onSymbolChange={setSymbol}
        />
      </div>

      <RecoveryAlertBanner />

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <EquityCard live={live} range={range} />
        <UnrealizedPnLCard />
        <RealizedPnLTodayCard />
        <BridgeHealthCard />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <ActiveExposurePanel equity={latestEquity ?? null} />
        </div>
        <div className="lg:col-span-2">
          <ActivePositionsTable />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentClosedTradesTable range={range} symbol={symbol} />
        <RecentExecutionEventsList range={range} symbol={symbol} />
      </div>
    </>
  );
}

function EmergencyStopButton() {
  const [confirmText, setConfirmText] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground shadow hover:bg-danger/90"
      >
        EMERGENCY STOP
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-danger/40 bg-card p-6">
            <h3 className="text-lg font-semibold text-danger">Activate kill switch?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will halt all new entries immediately. Type <b>STOP</b> to confirm.
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-danger"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setOpen(false);
                  setConfirmText("");
                }}
                className="rounded-md border border-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                disabled={confirmText !== "STOP"}
                onClick={async () => {
                  setOpen(false);
                  setConfirmText("");
                }}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-semibold text-danger-foreground disabled:opacity-50"
              >
                Activate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
