import { createFileRoute } from "@tanstack/react-router";
import { LiveStatusStrip } from "@/components/mobile/pulse/LiveStatusStrip";
import { TodayHero } from "@/components/mobile/pulse/TodayHero";
import { OpenPositionsStack } from "@/components/mobile/pulse/OpenPositionsStack";
import { NeedsAttentionList } from "@/components/mobile/pulse/NeedsAttentionList";

export const Route = createFileRoute("/m/pulse")({
  component: PulsePage,
});

function PulsePage() {
  return (
    <div className="flex flex-col gap-5">
      <LiveStatusStrip />
      <TodayHero />
      <NeedsAttentionList />
      <OpenPositionsStack />
    </div>
  );
}
