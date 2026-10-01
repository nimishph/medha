/**
 * NAPI-RS native Rust bridge for @cntxt-labs/medha-core.
 * Delegates core mathematical calculations and trust computations to crates/medha-napi.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RustDriftReport {
  readonly isDrifting: boolean;
  readonly isDriftingDown: boolean;
  readonly driftDelta: number;
  readonly driftDownDelta: number;
  readonly direction?: string;
}

export interface RustTrustScoreBreakdown {
  readonly score: number;
  readonly wilsonLower: number;
  readonly wilsonUpper: number;
  readonly recency: number;
  readonly durability: number;
  readonly guardFactor: number;
  readonly effectiveCeiling: number;
  readonly isDrifting: boolean;
  readonly driftDirection?: string;
}

export interface RustTrustComputationResult {
  readonly trust: number;
  readonly status: string;
  readonly breakdown: RustTrustScoreBreakdown;
}

export interface RustEvidenceInput {
  readonly k: number;
  readonly n: number;
  readonly contextRejects: number;
}

export interface RustGuardStateInput {
  readonly kind: string;
  readonly lastOk?: boolean | null;
  readonly lastOkAt?: number | null;
}

export interface RustEmaStateInput {
  readonly mu: number;
  readonly theta0: number;
  readonly sampleCount: number;
}

export interface RustThresholdsInput {
  readonly trusted?: number;
  readonly minUsesForTrusted?: number;
  readonly active?: number;
  readonly unguardedCeiling?: number;
  readonly minUsesForRetired?: number;
  readonly retiredTrustThreshold?: number;
}

export interface RustRecencyConfigInput {
  readonly halfLifeDays?: number;
  readonly floor?: number;
}

export interface RustCoreBinding {
  round6(val: number): number;
  wilsonLowerBound(successes: number, trials: number, z?: number): number;
  wilsonUpperBound(successes: number, trials: number, z?: number): number;
  recencyFactor(
    lastSignalAt: number | null | undefined,
    now: number,
    halfLifeDays?: number,
    floor?: number,
  ): number;
  durabilityFactor(distinctAnchorCount: number, isGuarded: boolean): number;
  guardFactor(kind: string, lastOk?: boolean | null): number;
  emaStep(mu: number | null | undefined, signal: number, alpha?: number): number;
  computeDrift(trials: number, mu: number, theta0: number): RustDriftReport;
  computeTrustAndStatus(
    evidence: RustEvidenceInput,
    guard: RustGuardStateInput,
    distinctAnchorCount: number,
    ema: RustEmaStateInput,
    lastSignalAt: number | null | undefined,
    now: number,
    storedStatus?: string,
    statusOverride?: string,
    thresholds?: RustThresholdsInput,
    recencyConfig?: RustRecencyConfigInput,
  ): RustTrustComputationResult;
}

let nativeModule: RustCoreBinding | null = null;
let attempted = false;

export function loadRustCore(): RustCoreBinding | null {
  if (attempted) {
    return nativeModule;
  }
  attempted = true;

  const rootDir = join(__dirname, '..', '..');
  const candidates = [
    join(rootDir, 'crates', 'medha-napi', 'medha_napi.node'),
    join(rootDir, 'target', 'release', 'medha_napi.node'),
    join(rootDir, 'target', 'debug', 'medha_napi.node'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        nativeModule = require(candidate) as RustCoreBinding;
        return nativeModule;
      } catch (failure) {
        void failure;
      }
    }
  }

  return null;
}

export function isRustCoreAvailable(): boolean {
  return loadRustCore() !== null;
}
