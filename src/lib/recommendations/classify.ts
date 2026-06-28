// Pure classification helper for the Recommendations page.
// No I/O. Decision-support only — never mutates anything.

import type { CandidateScoreResult } from '@/lib/admission/candidate-score';

export type RecommendationAction =
  | 'add_candidate'
  | 'keep_active'
  | 'watch_closely'
  | 'consider_remove'
  | 'ignore';

export type CandidateTier = 'prime' | 'strong' | 'watch' | null;

export type HealthStatus = 'open' | 'blocked' | 'stale' | 'no_data' | null;

export interface ClassifyInput {
  symbol: string;
  isActive: boolean;
  admissionStatus: string | null; // approved | watchlist | trend_candidate | rejected
  candidateScore: CandidateScoreResult | null;
  hardKills: string[];
  softFailures: string[];
  htq: number | null;
  robustness: number | null;
  calibrationConfidence: 'low' | 'medium' | 'high' | null;
  btTrust: 'trusted' | 'needs_review' | 'no_trades' | 'missing';
  btScore: number | null;
  healthStatus: HealthStatus;
  healthCapturedAt: string | null;
  healthStaleMinutes: number; // configurable threshold
}

export interface ClassifyResult {
  action: RecommendationAction;
  candidateTier: CandidateTier;
  reason: string;
  positives: string[];
  negatives: string[];
  healthStale: boolean;
  healthMissing: boolean;
}

const ACTIVE_SEVERE_HEALTH: HealthStatus[] = ['blocked'];
const ACTIVE_WARN_HEALTH: HealthStatus[] = ['stale', 'no_data'];

export function classifySymbol(input: ClassifyInput): ClassifyResult {
  const {
    isActive,
    admissionStatus,
    candidateScore,
    hardKills,
    softFailures,
    htq,
    robustness,
    calibrationConfidence,
    btTrust,
    btScore,
    healthStatus,
    healthCapturedAt,
    healthStaleMinutes,
  } = input;

  const score = candidateScore?.score ?? null;
  const tradeEligible = candidateScore?.tradeEligible ?? true;
  const hasHardKill = (hardKills?.length ?? 0) > 0;
  const hasSoft = (softFailures?.length ?? 0) > 0;

  const ageMin = healthCapturedAt
    ? (Date.now() - new Date(healthCapturedAt).getTime()) / 60000
    : null;
  const healthStale = !!ageMin && ageMin > healthStaleMinutes;
  const healthMissing = !healthCapturedAt;
  const severeHealth = !!healthStatus && ACTIVE_SEVERE_HEALTH.includes(healthStatus);
  const warnHealth = healthStale || (!!healthStatus && ACTIVE_WARN_HEALTH.includes(healthStatus));

  const positives: string[] = [];
  const negatives: string[] = [];
  if (score != null && score >= 65) positives.push(`Candidate Score ${score.toFixed(0)}`);
  if ((robustness ?? 0) >= 70) positives.push(`Robust ${robustness!.toFixed(0)}`);
  if ((htq ?? 0) >= 70) positives.push(`HTQ ${htq!.toFixed(0)}`);
  if (btTrust === 'trusted' && (btScore ?? 0) >= 70) positives.push(`BT ${btScore!.toFixed(0)}`);
  if (calibrationConfidence === 'high') positives.push('Calib high');

  if (hasHardKill) negatives.push(`Hard kill: ${hardKills.slice(0, 2).join(', ')}`);
  if (!tradeEligible) negatives.push('Not trade-eligible');
  if (score != null && score < 50) negatives.push(`Candidate ${score.toFixed(0)}`);
  if (admissionStatus === 'rejected') negatives.push('Rejected status');
  if (calibrationConfidence === 'low') negatives.push('Calib low');
  if (btTrust === 'needs_review') negatives.push('BT needs review');
  if (btTrust === 'no_trades') negatives.push('No-trades BT');
  if (hasSoft) negatives.push(`${softFailures.length} soft warn`);
  if (severeHealth) negatives.push('Health blocked');
  if (warnHealth) negatives.push(healthMissing ? 'Health missing' : 'Health stale');

  // --- Decision tree ---
  if (isActive) {
    // Red flag conditions
    if (
      hasHardKill ||
      !tradeEligible ||
      (score != null && score < 45) ||
      admissionStatus === 'rejected' ||
      severeHealth
    ) {
      return finalize('consider_remove', null, buildReason('red', input, score), positives, negatives, healthStale, healthMissing);
    }
    // Watch conditions
    if (
      (score != null && score < 65) ||
      admissionStatus === 'watchlist' ||
      admissionStatus === 'trend_candidate' ||
      calibrationConfidence === 'low' ||
      btTrust === 'needs_review' ||
      btTrust === 'no_trades' ||
      hasSoft ||
      warnHealth ||
      (htq != null && htq < 55) ||
      (robustness != null && robustness < 55)
    ) {
      return finalize('watch_closely', null, buildReason('watch', input, score), positives, negatives, healthStale, healthMissing);
    }
    // Healthy keep
    return finalize('keep_active', null, buildReason('keep', input, score), positives, negatives, healthStale, healthMissing);
  }

  // Not active — recommend as new candidate?
  if (hasHardKill || !tradeEligible) {
    return finalize('ignore', null, 'Blocked by hard kill or trade-eligibility.', positives, negatives, false, false);
  }
  if (admissionStatus === 'rejected') {
    return finalize('ignore', null, 'Admission rejected.', positives, negatives, false, false);
  }
  if (score == null || score < 50) {
    return finalize('ignore', null, `Candidate Score below 50 (${score?.toFixed(0) ?? '—'}).`, positives, negatives, false, false);
  }
  if (btTrust === 'no_trades' && (robustness ?? 0) < 60 && (htq ?? 0) < 60) {
    return finalize('ignore', null, 'No-trades backtest and weak underlying profile.', positives, negatives, false, false);
  }
  const tier: CandidateTier = score >= 80 ? 'prime' : score >= 65 ? 'strong' : 'watch';
  return finalize('add_candidate', tier, buildReason('add', input, score), positives, negatives, false, false);
}

function finalize(
  action: RecommendationAction,
  tier: CandidateTier,
  reason: string,
  positives: string[],
  negatives: string[],
  healthStale: boolean,
  healthMissing: boolean,
): ClassifyResult {
  return { action, candidateTier: tier, reason, positives, negatives, healthStale, healthMissing };
}

function buildReason(kind: 'add' | 'keep' | 'watch' | 'red', i: ClassifyInput, score: number | null): string {
  const s = score != null ? score.toFixed(0) : '—';
  switch (kind) {
    case 'add':
      return `Strong candidate: Candidate Score ${s}, ${i.admissionStatus ?? 'n/a'} status, no hard kills${i.calibrationConfidence ? `, calib ${i.calibrationConfidence}` : ''}.`;
    case 'keep':
      return `Keep active: trade eligible, Candidate Score ${s}, no hard kills, no severe health alert.`;
    case 'watch': {
      const reasons: string[] = [];
      if (score != null && score < 65) reasons.push(`Candidate Score ${s}`);
      if (i.calibrationConfidence === 'low') reasons.push('low calibration confidence');
      if (i.btTrust === 'needs_review') reasons.push('BT needs review');
      if (i.btTrust === 'no_trades') reasons.push('no-trades BT');
      if ((i.softFailures?.length ?? 0) > 0) reasons.push(`${i.softFailures.length} soft warnings`);
      if (i.admissionStatus === 'watchlist' || i.admissionStatus === 'trend_candidate') reasons.push(`status ${i.admissionStatus}`);
      return `Watch closely: ${reasons.slice(0, 4).join(', ') || 'weakened profile'}.`;
    }
    case 'red': {
      const reasons: string[] = [];
      if ((i.hardKills?.length ?? 0) > 0) reasons.push(`hard kill (${i.hardKills.slice(0, 2).join(', ')})`);
      if (i.candidateScore && !i.candidateScore.tradeEligible) reasons.push('trade-eligible=false');
      if (score != null && score < 45) reasons.push(`Candidate Score ${s}`);
      if (i.admissionStatus === 'rejected') reasons.push('rejected');
      return `Red flag: ${reasons.slice(0, 3).join(', ') || 'severe degradation'}.`;
    }
  }
}

export function actionLabel(a: RecommendationAction): string {
  switch (a) {
    case 'add_candidate': return 'Add Candidate';
    case 'keep_active': return 'Keep Active';
    case 'watch_closely': return 'Watch Closely';
    case 'consider_remove': return 'Consider Remove';
    case 'ignore': return 'Ignore';
  }
}

export function actionBadgeClass(a: RecommendationAction): string {
  switch (a) {
    case 'add_candidate': return 'bg-blue-500/20 text-blue-700';
    case 'keep_active': return 'bg-emerald-500/20 text-emerald-700';
    case 'watch_closely': return 'bg-yellow-500/20 text-yellow-700';
    case 'consider_remove': return 'bg-red-500/20 text-red-700';
    case 'ignore': return 'bg-muted text-muted-foreground';
  }
}
