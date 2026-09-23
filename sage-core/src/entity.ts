import type { Anchor } from './durability.ts';
import { InvalidArgumentError } from './errors.ts';
import type { GuardState } from './guard.ts';
import { newGuard } from './guard.ts';
import { DEFAULT_THETA0 } from './thresholds.ts';

/**
 * The unified entity state, library spec §5.1.
 *
 * This replaces the legacy twin model — `ScorableEntry` (uses/wins/losses, guard, durability) and
 * `ReviewRule` + `RuleEMAState` (sample and rejection counts, EMA weight) — with one state carrying
 * both estimators. State is a fold over episodes (StorePort §7.1): any backend can rebuild it, and
 * it can be recomputed under new parameters.
 */

export type { Anchor } from './durability.ts';

/** Identifier of a thing Sage holds belief about. Ids are opaque to Sage. */
export interface EntityKey {
  /** Project / organisation identity tier. Default ''. */
  readonly namespace: string;
  /** Kind, validated by a KindRegistry. */
  readonly kind: string;
  /** Opaque, unique per (namespace, kind). */
  readonly id: string;
}

/** Wilson inputs. SKIP never touches n; REJECT_CONTEXT never touches any counter. */
export interface Evidence {
  readonly k: number;
  readonly n: number;
  /** Count of REJECT_CONTEXT signals — "right in principle, wrong here". */
  readonly contextRejects: number;
}

/** The temporal filter and the author baseline. */
export interface EmaState {
  readonly mu: number;
  readonly theta0: number;
  readonly updatedAt: number;
}

/** Five lifecycle states from the model §5.1. */
export type LifecycleStatus = 'probation' | 'active' | 'trusted' | 'quarantined' | 'retired';

/** A lifecycle override from the host (retire/quarantine/restore); `null` = none. */
export type Override = 'retired' | 'quarantined' | 'restore';

/** `updater` names a weight-updater strategy; 'ema' is the kernel default. */
export type UpdaterName = string;

export interface EntityState {
  readonly key: EntityKey;
  readonly evidence: Evidence;
  readonly ema: EmaState;
  readonly guard: GuardState;
  /** Distinct anchor values seen on successful uses, per anchor kind. */
  readonly anchors: readonly Anchor[];
  readonly status: LifecycleStatus;
  /** The last lifecycle override; persists until an explicit `restore`. */
  readonly override: Override | null;
  /**
   * When the entity was (last) retired, epoch ms. Papered on the state so retention survives
   * compaction (a baseline reproduces it); `null` when never retired or since restored.
   */
  readonly retiredAt: number | null;
  /**
   * When a human last restored it, epoch ms. The session-start sweep never re-retires an entity
   * that has had no evidence since its restore (§8 exception); stamped by the fold.
   */
  readonly restoredAt: number | null;
  readonly updater: UpdaterName;
  readonly createdAt: number;
  readonly lastSignalAt: number | null;
}

/** A fresh entity: probation, prior theta0, no evidence, no survival credit. */
export function freshState(
  key: EntityKey,
  at: number,
  init: {
    readonly theta0?: number;
    readonly guard?: GuardState;
    readonly updater?: UpdaterName;
    readonly anchor?: Anchor;
  } = {},
): EntityState {
  if (key.id.trim() === '') throw new InvalidArgumentError('key.id', 'a non-empty string', key.id);
  if (key.kind.trim() === '')
    throw new InvalidArgumentError('key.kind', 'a non-empty string', key.kind);
  const theta0 = init.theta0 ?? DEFAULT_THETA0;
  if (theta0 < 0 || theta0 > 1) {
    throw new InvalidArgumentError('init.theta0', 'a number in [0,1]', theta0);
  }
  return {
    key,
    evidence: { k: 0, n: 0, contextRejects: 0 },
    ema: { mu: theta0, theta0, updatedAt: at },
    guard: init.guard ?? newGuard('none'),
    anchors: init.anchor !== undefined ? [init.anchor] : [],
    status: 'probation',
    override: null,
    retiredAt: null,
    restoredAt: null,
    updater: init.updater ?? 'ema',
    createdAt: at,
    lastSignalAt: null,
  };
}
