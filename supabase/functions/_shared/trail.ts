// Decision trail — ordered, append-only narrative for a single signal.
// Surfaces in the Signals UI and is also useful for forensic debugging.
// Distinct from `risk_decisions` (canonical block log) — trail records every
// gate even when it passes or is skipped.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type TrailOutcome = "pass" | "fail" | "skip" | "info";

export interface TrailStep {
  step: string;
  outcome: TrailOutcome;
  reason?: string;
  metrics?: Record<string, unknown>;
  at: string;
}

export class Trail {
  private steps: TrailStep[] = [];
  add(step: string, outcome: TrailOutcome, reason?: string, metrics?: Record<string, unknown>) {
    this.steps.push({
      step, outcome,
      ...(reason ? { reason } : {}),
      ...(metrics ? { metrics } : {}),
      at: new Date().toISOString(),
    });
  }
  toJSON(): TrailStep[] { return this.steps.slice(); }
  get last(): TrailStep | undefined { return this.steps[this.steps.length - 1]; }
}

export async function flushTrail(
  sb: SupabaseClient, signalId: string, trail: Trail,
): Promise<void> {
  await sb.from("signals").update({ decision_trail: trail.toJSON() }).eq("id", signalId);
}
