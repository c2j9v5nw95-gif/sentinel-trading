import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const fn =
      mode === "sign_in"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin },
          });
    const { error } = await fn;
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    nav({ to: "/" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold tracking-tight">
          Operator {mode === "sign_in" ? "sign in" : "sign up"}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          TradingView → Bybit control system
        </p>

        <label className="mt-5 block text-xs font-medium text-muted-foreground">
          Email
        </label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />

        <label className="mt-3 block text-xs font-medium text-muted-foreground">
          Password
        </label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />

        {err && (
          <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {err}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {busy ? "..." : mode === "sign_in" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => setMode(mode === "sign_in" ? "sign_up" : "sign_in")}
          className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          {mode === "sign_in"
            ? "Need an operator account? Sign up"
            : "Have an account? Sign in"}
        </button>

        {mode === "sign_in" && (
          <Link
            to="/forgot-password"
            className="mt-2 block text-center text-xs text-muted-foreground hover:text-foreground"
          >
            Glemt passord?
          </Link>
        )}
      </form>
    </div>
  );
}
