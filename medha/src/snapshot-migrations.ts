/**
 * Ordered migration pipeline and versioning for Medha store snapshots (§6.4, §9).
 */

import {
  CANONICAL_SIGNALS,
  type Episode,
  InvalidArgumentError,
  type KindSpec,
  MigrationPipeline,
  type MigrationResult,
  type MigrationStep,
  type SignalSpec,
  type StoreRegistries,
} from '@cntxt-labs/medha-core';
import {
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  type MedhaSnapshot,
  SNAPSHOT_FORMAT,
} from './maintenance.ts';

/**
 * Extracts the integer format version from a raw snapshot candidate.
 * Recognizes explicit formatVersion, versioned format strings (sutras.medha/vN, sutras.sage/vN),
 * and legacy/unversioned snapshots (v0).
 */
export function extractStoreSnapshotVersion(obj: Record<string, unknown>): number {
  const target =
    'snapshot' in obj &&
    obj.snapshot &&
    typeof obj.snapshot === 'object' &&
    !Array.isArray(obj.snapshot)
      ? (obj.snapshot as Record<string, unknown>)
      : obj;

  // Unrecognized foreign format strings (e.g. 'other/v9') fail with InvalidArgumentError
  if (
    typeof target.format === 'string' &&
    !target.format.startsWith('sutras.medha/') &&
    !target.format.startsWith('sutras.sage/')
  ) {
    throw new InvalidArgumentError('source.format', `'${SNAPSHOT_FORMAT}'`, target.format);
  }

  if (typeof target.formatVersion === 'number') {
    return target.formatVersion;
  }

  if (typeof target.format === 'string') {
    const match = target.format.match(/^(?:sutras\.(?:medha|sage)\/v)(\d+)$/);
    if (match?.[1]) {
      return parseInt(match[1], 10);
    }
  }

  if (typeof target.schemaVersion === 'number') {
    return target.schemaVersion;
  }
  if (typeof target.layoutVersion === 'number') {
    return target.layoutVersion;
  }
  if (typeof target.version === 'number') {
    return target.version;
  }

  // Unversioned snapshot: bare episodes array or legacy rules object
  if (
    Array.isArray(target.episodes) ||
    (typeof target.rules === 'object' && target.rules !== null)
  ) {
    return 0;
  }

  // None of the recognized version/format/legacy markers are present: this isn't a snapshot at
  // all (e.g. an arbitrary JSON object), not merely an old one. Silently treating it as an empty
  // v0 snapshot would make restore accept garbage instead of rejecting it.
  throw new InvalidArgumentError(
    'source',
    'a recognizable Medha/Sage snapshot (formatVersion, format, schemaVersion, an episodes array, or a legacy rules object)',
    target,
  );
}

function normalizeRegistries(raw: unknown): StoreRegistries {
  if (typeof raw !== 'object' || raw === null) {
    return { kinds: ['rule'], signalSpecs: [], anchorKinds: ['week'] };
  }
  const reg = raw as Record<string, unknown>;
  const kinds = Array.isArray(reg.kinds) ? (reg.kinds as string[]) : ['rule'];
  const signalSpecs = Array.isArray(reg.signalSpecs) ? (reg.signalSpecs as SignalSpec[]) : [];
  const anchorKinds = Array.isArray(reg.anchorKinds) ? (reg.anchorKinds as string[]) : ['week'];
  return {
    kinds,
    signalSpecs,
    anchorKinds,
    ...(Array.isArray(reg.kindSpecs) ? { kindSpecs: reg.kindSpecs as KindSpec[] } : {}),
  };
}

function normalizeEpisode(ep: unknown): Episode {
  if (typeof ep !== 'object' || ep === null) return ep as Episode;
  const episode = { ...(ep as Record<string, unknown>) };
  if (episode.type === 'signal' && episode.spec && typeof episode.spec === 'object') {
    const rawSpec = episode.spec as Record<string, unknown>;
    let name = String(rawSpec.name ?? 'APPLY');
    if (name === 'APPLY_RULE') {
      name = 'APPLY';
    } else if (name === 'REJECT') {
      name = 'REJECT_RULE';
    }

    const canonical = CANONICAL_SIGNALS.find((s) => s.name === name);
    let value = typeof rawSpec.value === 'number' ? rawSpec.value : undefined;
    if (value === undefined) {
      if (canonical) {
        value = canonical.value;
      } else if (typeof rawSpec.valence === 'number') {
        value = rawSpec.valence;
      } else {
        value = 1;
      }
    }
    const countsAsTrial =
      typeof rawSpec.countsAsTrial === 'boolean'
        ? rawSpec.countsAsTrial
        : canonical
          ? canonical.countsAsTrial
          : value !== 0;
    const countsAsSuccess =
      typeof rawSpec.countsAsSuccess === 'boolean'
        ? rawSpec.countsAsSuccess
        : canonical
          ? canonical.countsAsSuccess
          : value > 0;

    episode.spec = {
      ...rawSpec,
      name,
      value,
      countsAsTrial,
      countsAsSuccess,
    };
  }
  return episode as unknown as Episode;
}

/** Migration step 0 -> 1: transforms unversioned/legacy V0 document into standard MedhaSnapshot V1. */
export const migrateStoreSnapshotV0toV1: MigrationStep<Record<string, unknown>> = {
  fromVersion: 0,
  toVersion: 1,
  description: 'Migrate unversioned/legacy V0 store snapshot to MedhaSnapshot V1',
  migrate(raw) {
    const target =
      'snapshot' in raw &&
      raw.snapshot &&
      typeof raw.snapshot === 'object' &&
      !Array.isArray(raw.snapshot)
        ? (raw.snapshot as Record<string, unknown>)
        : raw;

    const episodes: Episode[] = Array.isArray(target.episodes)
      ? (target.episodes as unknown[]).map(normalizeEpisode)
      : [];

    const exportedAt =
      typeof target.exportedAt === 'number'
        ? target.exportedAt
        : typeof target.asOf === 'number'
          ? target.asOf
          : typeof target.last_state_update === 'number'
            ? target.last_state_update
            : Date.now();

    const registries: StoreRegistries = normalizeRegistries(target.registries);

    const meta: Record<string, string> =
      typeof target.meta === 'object' && target.meta !== null && !Array.isArray(target.meta)
        ? (target.meta as Record<string, string>)
        : {};

    return {
      format: SNAPSHOT_FORMAT,
      formatVersion: 1,
      exportedAt,
      registries,
      episodes,
      meta,
    };
  },
};

export const storeSnapshotPipeline = new MigrationPipeline<MedhaSnapshot>(
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  [migrateStoreSnapshotV0toV1],
);

/**
 * Validates and migrates an arbitrary snapshot object into a compliant MedhaSnapshot V1.
 */
export function migrateStoreSnapshot(raw: unknown): MigrationResult<MedhaSnapshot> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidArgumentError('snapshot', 'a valid JSON object', raw);
  }

  const root = raw as Record<string, unknown>;
  const unwrapped =
    'snapshot' in root &&
    root.snapshot &&
    typeof root.snapshot === 'object' &&
    !Array.isArray(root.snapshot)
      ? (root.snapshot as Record<string, unknown>)
      : root;

  const result = storeSnapshotPipeline.migrate(unwrapped, extractStoreSnapshotVersion);

  const doc = result.doc as Record<string, unknown>;
  const needsNormalization =
    doc.format !== SNAPSHOT_FORMAT || doc.formatVersion !== CURRENT_SNAPSHOT_FORMAT_VERSION;

  const normalized: MedhaSnapshot = {
    format: SNAPSHOT_FORMAT,
    formatVersion: CURRENT_SNAPSHOT_FORMAT_VERSION,
    exportedAt:
      typeof doc.exportedAt === 'number' && Number.isFinite(doc.exportedAt)
        ? doc.exportedAt
        : Date.now(),
    registries: normalizeRegistries(doc.registries),
    episodes: Array.isArray(doc.episodes) ? (doc.episodes as unknown[]).map(normalizeEpisode) : [],
    meta:
      typeof doc.meta === 'object' && doc.meta !== null && !Array.isArray(doc.meta)
        ? (doc.meta as Record<string, string>)
        : {},
  };

  return {
    doc: normalized,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    migrated: result.migrated || needsNormalization,
    steps:
      needsNormalization && !result.migrated
        ? ['Normalize format to sutras.medha/v1']
        : result.steps,
  };
}
