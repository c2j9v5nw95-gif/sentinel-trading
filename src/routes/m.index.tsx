import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/m/")({
  component: () => <Navigate to="/m/pulse" />,
});
