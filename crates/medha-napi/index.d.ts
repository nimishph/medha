/* tslint:disable */
/* eslint-disable */

export interface NapiDriftReport {
  isDrifting: boolean;
  isDriftingDown: boolean;
  driftDelta: number;
  driftDownDelta: number;
  direction?: string;
}

export interface NapiTrustScoreBreakdown {
  score: number;
  wilsonLower: number;
  wilsonUpper: number;
  recency: number;
  durability: number;
  guardFactor: number;
  effectiveCeiling: number;
  isDrifting: boolean;
  driftDirection?: string;
}

export interface NapiTrustComputationResult {
  trust: number;
  status: string;
  breakdown: NapiTrustScoreBreakdown;
}

export interface NapiEvidence {
  k: number;
  n: number;
  contextRejects: number;
}

export interface NapiGuardState {
  kind: string;
  lastOk?: boolean;
  lastOkAt?: number;
}

export interface NapiEmaState {
  mu: number;
  theta0: number;
  sampleCount: number;
}

export interface NapiThresholds {
  trusted?: number;
  minUsesForTrusted?: number;
  active?: number;
  unguardedCeiling?: number;
  minUsesForRetired?: number;
  retiredTrustThreshold?: number;
}

export interface NapiRecencyConfig {
  halfLifeDays?: number;
  floor?: number;
}

export function round6(val: number): number;
export function wilsonLowerBound(successes: number, trials: number, z?: number): number;
export function wilsonUpperBound(successes: number, trials: number, z?: number): number;
export function recencyFactor(
  lastSignalAt: number | null | undefined,
  now: number,
  halfLifeDays?: number,
  floor?: number,
): number;
export function durabilityFactor(distinctAnchorCount: number, isGuarded: boolean): number;
export function guardFactor(kind: string, lastOk?: boolean | null): number;
export function emaStep(mu: number | null | undefined, signal: number, alpha?: number): number;
export function computeDrift(trials: number, mu: number, theta0: number): NapiDriftReport;
export function computeTrustAndStatus(
  evidence: NapiEvidence,
  guard: NapiGuardState,
  distinctAnchorCount: number,
  ema: NapiEmaState,
  lastSignalAt: number | null | undefined,
  now: number,
  storedStatus?: string,
  statusOverride?: string,
  thresholds?: NapiThresholds,
  recencyConfig?: NapiRecencyConfig,
): NapiTrustComputationResult;
