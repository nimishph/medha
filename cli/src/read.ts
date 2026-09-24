/**
 * The read-plane CLI (spec §9.1 `list/show/status/drift/params/simulate/explain-threshold`):
 * every command reopens the configured engine home and reads it WITHOUT mutating anything (the
 * session-start sweep is never run from here — reads open lazily and leave the log byte-identical).
 *
 * Each runner returns a report object; the citty layer renders it human-readable or as JSON. Keys
 * arrive as `{ namespace, kind, id }` with `kind` defaulting to the built-in `rule` and namespace
 * to `''` (legacy `rules` parity — every lib entity kind works, the default is just ergonomics).
 */

import {
  DEFAULT_FOLD_DAYS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SWEEP_INTERVAL_MS,
  type DriftReport,
  type EntityDetail,
  type HintDelta,
  type ListFilter,
  type PreflightReport,
  type Sage,
} from '@cntxt-labs/medha';
import {
  ACTIVE_THRESHOLD,
  DEFAULT_EMA_ALPHA,
  DEFAULT_THETA0,
  DRIFT_THRESHOLD,
  DURABILITY_GAIN,
  DURABILITY_MAX,
  type EntityKey,
  type EvidentialHint,
  InvalidArgumentError,
  type LifecycleStatus,
  MIN_SAMPLES_FOR_DRIFT,
  MIN_USES_FOR_TRUSTED,
  type Page,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  RETIRED_TRUST_THRESHOLD,
  SKIP_SIGNAL,
  TRUSTED_THRESHOLD,
  UNGUARDED_TRUST_CEILING,
  WILSON_Z,
} from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import type { Backend } from './layout.ts';
import { openHome } from './open.ts';

export const LIFECYCLE_STATUSES: readonly LifecycleStatus[] = [
  'probation',
  'active',
  'trusted',
  'quarantined',
  'retired',
];

/** Parse a CLI `--limit`/`--recent`/… value; anything invalid is a usage error (exit 2). */
export function positiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentError(name, 'a positive integer', raw);
  }
  return value;
}

type KeyFlags = { readonly id?: string; readonly kind?: string; readonly namespace?: string };

/** Build a valid `EntityKey` from flags; `--kind`/`--namespace` default for legacy `rules` parity. */
export function keyFromFlags(args: KeyFlags): EntityKey {
  if (args.id === undefined || args.id === '') {
    throw new InvalidArgumentError('--id', 'a non-empty entity id', args.id);
  }
  return {
    namespace: args.namespace ?? '',
    kind: args.kind ?? 'rule',
    id: args.id,
  };
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

export interface ListOptions {
  readonly dir?: string;
  readonly home?: string | undefined;
  readonly kind?: string;
  readonly status?: string;
  readonly namespace?: string;
  readonly drifting?: boolean;
  readonly limit?: string;
  readonly cursor?: string;
}

export interface ListReport {
  readonly home: string;
  readonly asOf: number;
  readonly filter: ListFilter;
  readonly page: Page<EvidentialHint>;
}

export async function runList(options: ListOptions, environment: Environment): Promise<ListReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const filter: ListFilter = {
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.status === undefined ? {} : { status: requireStatus(options.status) }),
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      ...(options.drifting === undefined ? {} : { drifting: options.drifting }),
    };
    const request =
      options.limit === undefined
        ? { ...(options.cursor === undefined ? {} : { cursor: options.cursor }) }
        : {
            limit: positiveInt('--limit', options.limit),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          };
    const page = await opened.engine.list(filter, { now }, request);
    return { home: opened.home, asOf: now, filter, page };
  } finally {
    await opened.engine.close();
  }
}

function requireStatus(raw: string): LifecycleStatus {
  if ((LIFECYCLE_STATUSES as readonly string[]).includes(raw)) {
    return raw as LifecycleStatus;
  }
  throw new InvalidArgumentError('--status', LIFECYCLE_STATUSES.join(' | '), raw);
}

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

export interface ShowOptions {
  readonly dir?: string;
  readonly home?: string | undefined;
  readonly namespace?: string;
  readonly kind?: string;
  readonly id?: string;
  readonly recent?: string;
}

export interface ShowReport {
  readonly home: string;
  readonly asOf: number;
  readonly key: EntityKey;
  readonly detail: EntityDetail;
}

export async function runShow(options: ShowOptions, environment: Environment): Promise<ShowReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const key = keyFromFlags(options);
    const detail = await opened.engine.show(
      key,
      { now },
      options.recent === undefined ? {} : { recent: positiveInt('--recent', options.recent) },
    );
    return { home: opened.home, asOf: now, key, detail };
  } finally {
    await opened.engine.close();
  }
}

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

export interface StatusOptions {
  readonly dir?: string;
  readonly home?: string | undefined;
}

export interface StatusReport {
  readonly home: string;
  readonly asOf: number;
  readonly backend: Backend;
  readonly path: string | null;
  readonly preflight: PreflightReport;
  readonly byStatus: Readonly<Record<LifecycleStatus, number>>;
  readonly drifting: number;
  readonly params: ParamsReport;
}

export async function runStatus(
  options: StatusOptions,
  environment: Environment,
): Promise<StatusReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const [preflight, all] = await Promise.all([
      opened.engine.preflight({ now }),
      pageAll(opened.engine, now),
    ]);
    const byStatus = Object.fromEntries(
      LIFECYCLE_STATUSES.map((status) => [
        status,
        all.filter((hint) => hint.status === status).length,
      ]),
    ) as Record<LifecycleStatus, number>;
    const drifting = all.filter((hint) => hint.temporal.isDrifting).length;
    return {
      home: opened.home,
      asOf: now,
      backend: opened.config.backend,
      path: opened.config.path,
      preflight,
      byStatus,
      drifting,
      params: paramsReport(now),
    };
  } finally {
    await opened.engine.close();
  }
}

/** Every hint in the store, paged to completion. */
export async function pageAll(engine: Sage, now: number): Promise<readonly EvidentialHint[]> {
  const hints: EvidentialHint[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await engine.list({}, { now }, cursor === undefined ? {} : { cursor });
    hints.push(...page.items);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return hints;
}

// ---------------------------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------------------------

export interface DriftOptions {
  readonly dir?: string;
  readonly home?: string | undefined;
  readonly limit?: string;
}

export interface DriftResult {
  readonly home: string;
  readonly report: DriftReport;
}

export async function runDrift(
  options: DriftOptions,
  environment: Environment,
): Promise<DriftResult> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const report = await opened.engine.drift(
      { now },
      options.limit === undefined ? {} : { limit: positiveInt('--limit', options.limit) },
    );
    return { home: opened.home, report };
  } finally {
    await opened.engine.close();
  }
}

// ---------------------------------------------------------------------------------------------
// params (read-only)
// ---------------------------------------------------------------------------------------------

export interface ParamEntry {
  readonly name: string;
  readonly value: number | string;
  readonly unit?: string;
  readonly source: string;
  readonly doc: string;
}

export interface ParamsReport {
  readonly asOf: number;
  /** Why this is a report and not a config: the lean engine has no mutable params store. */
  readonly note: string;
  readonly params: readonly ParamEntry[];
}

const SOURCE_EMA = 'medha-core: ema.ts';
const SOURCE_SWEEP = 'medha: maintenance.ts';
const SOURCE_THRESHOLDS = 'medha-core: thresholds.ts';

/** The canonical parameter catalog, read from the constants the kernel actually uses. */
export function paramsReport(asOf: number): ParamsReport {
  return {
    asOf,
    note: 'read-only: model parameters are canonical constants in medha-core — the lean engine has no mutable params store',
    params: [
      {
        name: 'WILSON_Z',
        value: WILSON_Z,
        source: SOURCE_THRESHOLDS,
        doc: 'Normal quantile, 95% confidence',
      },
      {
        name: 'TRUSTED_THRESHOLD',
        value: TRUSTED_THRESHOLD,
        source: SOURCE_THRESHOLDS,
        doc: 'Trust at/above this may become trusted (with guard 1.0 and enough uses)',
      },
      {
        name: 'MIN_USES_FOR_TRUSTED',
        value: MIN_USES_FOR_TRUSTED,
        source: SOURCE_THRESHOLDS,
        doc: 'Minimum trials before trusted is reachable',
      },
      {
        name: 'ACTIVE_THRESHOLD',
        value: ACTIVE_THRESHOLD,
        source: SOURCE_THRESHOLDS,
        doc: 'Trust at/above this may become active',
      },
      {
        name: 'RETIRED_TRUST_THRESHOLD',
        value: RETIRED_TRUST_THRESHOLD,
        source: SOURCE_THRESHOLDS,
        doc: 'Trust below this retires an entity',
      },
      {
        name: 'UNGUARDED_TRUST_CEILING',
        value: UNGUARDED_TRUST_CEILING,
        source: SOURCE_THRESHOLDS,
        doc: 'Hard ceiling on the trust of an unguarded entity (IV)',
      },
      {
        name: 'SKIP_SIGNAL',
        value: SKIP_SIGNAL,
        source: SOURCE_THRESHOLDS,
        doc: 'Neutral skip signal value',
      },
      {
        name: 'RECENCY_HALF_LIFE_DAYS',
        value: RECENCY_HALF_LIFE_DAYS,
        source: SOURCE_THRESHOLDS,
        doc: 'Recency decay half-life in days',
      },
      {
        name: 'RECENCY_FLOOR',
        value: RECENCY_FLOOR,
        source: SOURCE_THRESHOLDS,
        doc: 'Recency retention floor',
      },
      {
        name: 'DURABILITY_GAIN',
        value: DURABILITY_GAIN,
        source: SOURCE_THRESHOLDS,
        doc: 'Durability gain per distinct anchor',
      },
      {
        name: 'DURABILITY_MAX',
        value: DURABILITY_MAX,
        source: SOURCE_THRESHOLDS,
        doc: 'Durability multiplier ceiling',
      },
      {
        name: 'DEFAULT_THETA0',
        value: DEFAULT_THETA0,
        source: SOURCE_THRESHOLDS,
        doc: 'Author-declared baseline prior for a fresh entity',
      },
      {
        name: 'DEFAULT_EMA_ALPHA',
        value: DEFAULT_EMA_ALPHA,
        source: SOURCE_EMA,
        doc: 'Default EMA smoothing parameter',
      },
      {
        name: 'MIN_SAMPLES_FOR_DRIFT',
        value: MIN_SAMPLES_FOR_DRIFT,
        source: SOURCE_EMA,
        doc: 'Minimum trials before drift is detectable',
      },
      {
        name: 'DRIFT_THRESHOLD',
        value: DRIFT_THRESHOLD,
        source: SOURCE_EMA,
        doc: '|mu - theta0| at/above this flags drift',
      },
      {
        name: 'DEFAULT_SWEEP_INTERVAL_MS',
        value: DEFAULT_SWEEP_INTERVAL_MS,
        unit: 'ms',
        source: SOURCE_SWEEP,
        doc: 'Session-start sweep cadence',
      },
      {
        name: 'DEFAULT_FOLD_DAYS',
        value: DEFAULT_FOLD_DAYS,
        unit: 'days',
        source: SOURCE_SWEEP,
        doc: 'Episodes older than this fold into baselines',
      },
      {
        name: 'DEFAULT_RETENTION_DAYS',
        value: DEFAULT_RETENTION_DAYS,
        unit: 'days',
        source: SOURCE_SWEEP,
        doc: 'Stale entities older than this are retired',
      },
    ],
  };
}

export async function runParams(environment: Environment): Promise<ParamsReport> {
  return paramsReport(environment.now());
}

// ---------------------------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------------------------

export interface SimulateOptions {
  readonly dir?: string;
  readonly home?: string | undefined;
  readonly namespace?: string;
  readonly kind?: string;
  readonly id?: string;
  readonly signal?: string;
}

export interface SimulateResult {
  readonly home: string;
  readonly signal: string;
  readonly delta: HintDelta;
}

export async function runSimulate(
  options: SimulateOptions,
  environment: Environment,
): Promise<SimulateResult> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    if (options.signal === undefined || options.signal === '') {
      throw new InvalidArgumentError('--signal', 'a registered signal name', options.signal);
    }
    const key = keyFromFlags(options);
    const delta = await opened.engine.simulate(key, options.signal, { now });
    return { home: opened.home, signal: options.signal, delta };
  } finally {
    await opened.engine.close();
  }
}

// ---------------------------------------------------------------------------------------------
// explain-threshold (the rename of `gate`, §9.1)
// ---------------------------------------------------------------------------------------------

export interface ExplainOptions {
  readonly dir?: string;
  readonly home?: string | undefined;
  readonly namespace?: string;
  readonly kind?: string;
  readonly id?: string;
}

export interface ThresholdCondition {
  readonly label: string;
  readonly met: boolean;
}

export interface ThresholdGate {
  readonly name: string;
  readonly met: boolean;
  readonly threshold: number | null;
  readonly value: number | null;
  readonly conditions: readonly ThresholdCondition[];
}

export interface ExplainReport {
  readonly home: string;
  readonly asOf: number;
  readonly key: EntityKey;
  readonly known: boolean;
  readonly hint: EvidentialHint;
  readonly gates: readonly ThresholdGate[];
  /** Medha never decides — it reports which thresholds clear and why. */
  readonly note: string;
}

export async function runExplainThreshold(
  options: ExplainOptions,
  environment: Environment,
): Promise<ExplainReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const key = keyFromFlags(options);
    const detail = await opened.engine.show(key, { now });
    const hint = detail.hint;
    const cleared = hint.clearsThreshold;
    const gates: ThresholdGate[] = [
      {
        name: 'trusted',
        met: cleared.trusted,
        threshold: TRUSTED_THRESHOLD,
        value: hint.trustScore,
        conditions: [
          {
            label: `trust ${formatNumber(hint.trustScore)} >= ${TRUSTED_THRESHOLD}`,
            met: hint.trustScore >= TRUSTED_THRESHOLD,
          },
          {
            label: `uses ${hint.evidence.totalTrials} >= ${MIN_USES_FOR_TRUSTED}`,
            met: hint.evidence.totalTrials >= MIN_USES_FOR_TRUSTED,
          },
        ],
      },
      {
        name: 'active',
        met: cleared.active,
        threshold: ACTIVE_THRESHOLD,
        value: hint.trustScore,
        conditions: [
          {
            label: `trust ${formatNumber(hint.trustScore)} >= ${ACTIVE_THRESHOLD}`,
            met: hint.trustScore >= ACTIVE_THRESHOLD,
          },
        ],
      },
      {
        name: 'drifting',
        met: hint.temporal.isDrifting,
        threshold: DRIFT_THRESHOLD,
        value: hint.temporal.driftDelta,
        conditions: [
          {
            label: `samples ${hint.evidence.totalTrials} >= ${MIN_SAMPLES_FOR_DRIFT}`,
            met: hint.evidence.totalTrials >= MIN_SAMPLES_FOR_DRIFT,
          },
          {
            label: `|mu - theta0| ${formatNumber(hint.temporal.driftDelta)} >= ${DRIFT_THRESHOLD}`,
            met: hint.temporal.driftDelta >= DRIFT_THRESHOLD,
          },
        ],
      },
    ];
    return {
      home: opened.home,
      asOf: now,
      key,
      known: detail.known,
      hint,
      gates,
      note: 'Medha reports which thresholds clear and why; it never decides for the host.',
    };
  } finally {
    await opened.engine.close();
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
