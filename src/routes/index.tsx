import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      throw redirect({ to: "/m/pulse" });
    }
    throw redirect({ to: "/overview" });
  },
});
