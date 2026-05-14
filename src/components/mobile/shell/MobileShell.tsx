import { Outlet } from "@tanstack/react-router";
import { BottomTabBar } from "./BottomTabBar";
import { TopBrandBar } from "./TopBrandBar";

export function MobileShell() {
  return (
    <div className="relative min-h-[100dvh] bg-background text-foreground">
      <div
        className="mx-auto flex min-h-[100dvh] w-full max-w-[480px] flex-col"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "calc(env(safe-area-inset-bottom) + 72px)",
        }}
      >
        <TopBrandBar />
        <main className="flex-1 px-4 pb-6 pt-2">
          <Outlet />
        </main>
      </div>
      <BottomTabBar />
    </div>
  );
}
