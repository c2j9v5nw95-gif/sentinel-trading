import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Layers, Bell } from "lucide-react";

const TABS = [
  { to: "/m/pulse", label: "Pulse", icon: Activity },
  { to: "/m/positions", label: "Positions", icon: Layers },
  { to: "/m/alerts", label: "Alerts", icon: Bell },
] as const;

export function BottomTabBar() {
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-card/90 backdrop-blur-xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex w-full max-w-[480px] items-stretch">
        {TABS.map((t) => {
          const active = path.startsWith(t.to);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                active ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <Icon
                className={`h-5 w-5 transition-transform ${
                  active ? "scale-110 text-primary" : ""
                }`}
                strokeWidth={active ? 2.4 : 2}
              />
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
