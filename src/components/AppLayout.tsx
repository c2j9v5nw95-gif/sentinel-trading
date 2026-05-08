import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { StatusBar } from "./StatusBar";

const NAV: { to: string; label: string }[] = [
  { to: "/", label: "Overview" },
  { to: "/positions", label: "Positions" },
  { to: "/signals", label: "Signals" },
  { to: "/strategies", label: "Strategies" },
  { to: "/symbols", label: "Symbols" },
  { to: "/alerts", label: "Alerts" },
  { to: "/audit", label: "Audit" },
  { to: "/simulator", label: "Simulator" },
  { to: "/settings", label: "Settings" },
];

export function AppLayout() {
  const loc = useLocation();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/40">
        <div className="px-4 py-5">
          <div className="text-sm font-semibold tracking-wide text-foreground">
            TV → Bybit Control
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">Operator console</div>
        </div>
        <nav className="flex-1 px-2 pb-4">
          {NAV.map((item) => {
            const active =
              item.to === "/"
                ? loc.pathname === "/"
                : loc.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border px-4 py-3 text-[10px] uppercase tracking-wider text-muted-foreground">
          Phase 1 · Foundation
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <StatusBar />
        <div className="flex-1 overflow-auto px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
