import type { EntityKey } from '@cntxt-labs/medha-core';
import { MedhaError } from '@cntxt-labs/medha-core';
import type { InitReport } from './init.ts';
import type {
  MaintainBackupReport,
  MaintainCompactReport,
  MaintainPreflightReport,
  MaintainRestoreReport,
} from './maintain.ts';
import type {
  DriftResult,
  ExplainReport,
  ListReport,
  ParamsReport,
  ShowReport,
  SimulateResult,
  StatusReport,
} from './read.ts';
import type { UpdaterForkReport, UpdaterListReport, UpdaterShowReport } from './updater.ts';

/**
 * Machine output: JSON with a replacer that makes every engine value round-trippable. `compact`
 * drops the indentation for token-sensitive callers.
 */
export function toJson(value: unknown, compact = false): string {
  return `${JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (item instanceof MedhaError) {
        return item.toJSON();
      }
      if (item instanceof Map) {
        return Object.fromEntries(item);
      }
      if (item instanceof Set) {
        return [...item];
      }
      if (typeof item === 'number' && !Number.isFinite(item)) {
        return String(item);
      }
      return item;
    },
    compact ? undefined : 2,
  )}\n`;
}

/** Human output for a successful init: home, backend, store, config, and the preflight gate. */
export function renderInit(report: InitReport): string {
  const p = report.preflight;
  const lastSweep = p.lastSweep === null ? 'not yet' : new Date(p.lastSweep).toISOString();
  const lines = [
    `medha: initialized engine home at ${report.home}`,
    `  backend:    ${report.backend}`,
    report.path === null ? `  store:      ephemeral (memory)` : `  store:      ${report.path}`,
    ...(report.config === null
      ? []
      : [`  config:     ${report.config} (layout v${report.layoutVersion})`]),
    `  preflight:  ${p.status} — ${p.episodeCount} episodes, ${p.entityCount} entities, integrity ${p.integrity}`,
    `  last sweep: ${lastSweep}`,
    ...(report.backup === null ? [] : [`  backup:     ${report.backup}`]),
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// read-plane renderers
// ---------------------------------------------------------------------------------------------

export function keyLabel(key: EntityKey): string {
  return key.namespace === '' ? `${key.kind}/${key.id}` : `${key.namespace}/${key.kind}/${key.id}`;
}

function fixed(value: number): string {
  return value.toFixed(3);
}

export function renderList(report: ListReport): string {
  const { page } = report;
  const lines = [
    `medha: ${page.total} entities (limit ${page.limit.applied}, source ${page.limit.source})${
      page.limit.reached ? ', truncated' : ''
    }`,
  ];
  if (page.items.length > 0) {
    lines.push('  TRUST  STATUS     DRIFT  KEY');
    const unregistered = new Set(report.unregisteredKinds ?? []);
    for (const hint of page.items) {
      const isUnregistered = unregistered.has(hint.key.kind);
      lines.push(
        `  ${fixed(hint.trustScore)}  ${hint.status.padEnd(10)} ${
          hint.temporal.isDrifting ? 'yes   ' : 'no    '
        } ${keyLabel(hint.key)}${isUnregistered ? '  [unregistered kind]' : ''}`,
      );
    }
    if (unregistered.size > 0) {
      lines.push(
        `  warning: found ${unregistered.size} unregistered ${
          unregistered.size === 1 ? 'kind' : 'kinds'
        } (${[...unregistered].join(', ')}). Data is safe; run 'medha maintain preflight' for guidance.`,
      );
    }
  }
  if (page.nextCursor !== null) {
    lines.push(`  next page: --cursor ${page.nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderShow(report: ShowReport): string {
  const { detail } = report;
  const h = detail.hint;
  const lines = [
    `medha: ${keyLabel(report.key)} ${detail.known ? '(known)' : '(unknown — probation prior)'}`,
    `  status:   ${h.status}`,
    `  trust:    ${fixed(h.trustScore)}  (wilson ${fixed(h.components.wilson)}, guard ${fixed(
      h.components.guard,
    )}, recency ${fixed(h.components.recency)}, durability ${fixed(
      h.components.durability,
    )}, ceiling ${fixed(h.components.ceiling)})`,
    `  evidence: ${h.evidence.successes}/${h.evidence.totalTrials} successes, wilson lower bound ${fixed(
      h.evidence.lowerBound,
    )}`,
    `  temporal: ema ${fixed(h.temporal.emaWeight)}, drift ${h.temporal.isDrifting ? 'yes' : 'no'} (delta ${fixed(
      h.temporal.driftDelta,
    )})`,
    `  clears:   trusted ${h.clearsThreshold.trusted ? 'yes' : 'no'}, active ${
      h.clearsThreshold.active ? 'yes' : 'no'
    }`,
  ];
  if (h.lastNote !== undefined) {
    lines.push(`  last note: ${h.lastNote}`);
  }
  if (detail.recentEpisodes.length > 0) {
    lines.push('  recent episodes:');
    for (const episode of detail.recentEpisodes) {
      const noteStr =
        'note' in episode && typeof episode.note === 'string' ? ` — "${episode.note}"` : '';
      lines.push(
        `    #${episode.seq} ${episode.type} at ${new Date(episode.at).toISOString()}${noteStr}`,
      );
    }
  }
  if (detail.provenance.length > 0) {
    lines.push('  provenance:');
    for (const provenance of detail.provenance) {
      lines.push(`    ${provenance}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderStatus(report: StatusReport): string {
  const p = report.preflight;
  const lastSweep = p.lastSweep === null ? 'not yet' : new Date(p.lastSweep).toISOString();
  const byStatus = Object.entries(report.byStatus)
    .map(([status, count]) => `${status} ${count}`)
    .join(', ');
  const lines = [
    `medha: status for ${report.home}`,
    report.path === null ? `  store:      ephemeral (memory)` : `  store:      ${report.path}`,
    `  preflight:  ${p.status} — ${p.episodeCount} episodes, ${p.entityCount} entities, integrity ${p.integrity}`,
    `  last sweep: ${lastSweep}`,
    `  by status:  ${byStatus}`,
    `  drifting:   ${report.drifting}`,
    `  registries: ${p.registries.kinds} kinds, ${p.registries.signals} signals, ${p.registries.anchors} anchors`,
    '  params:     read-only canonical defaults — run `medha params` to see them',
  ];
  return `${lines.join('\n')}\n`;
}

export function renderDrift(report: DriftResult): string {
  const { report: drift } = report;
  const lines = [`medha: ${drift.count} entities drifting (limit applied ${drift.limitApplied})`];
  for (const entry of drift.drifting) {
    lines.push(`  ${fixed(entry.delta)}  ${entry.hint.status.padEnd(10)} ${keyLabel(entry.key)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderParams(report: ParamsReport): string {
  const lines = [
    `medha: canonical model parameters (read-only)`,
    `  note: ${report.note}`,
    `  NAME                          VALUE      SOURCE`,
  ];
  for (const param of report.params) {
    const value = typeof param.value === 'number' ? fixed(param.value) : param.value;
    lines.push(`  ${param.name.padEnd(28)} ${value.padStart(8)}   ${param.source}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderSimulate(report: SimulateResult): string {
  const { delta } = report;
  const lines = [
    `medha: simulate ${report.signal} on ${keyLabel(delta.key)}`,
    `  trust:    ${fixed(delta.before.trustScore)} -> ${fixed(delta.after.trustScore)} (delta ${fixed(
      delta.deltaTrust,
    )})`,
    `  status:   ${delta.before.status} -> ${delta.after.status}${
      delta.statusChanged ? ' (changed)' : ''
    }`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderExplainThreshold(report: ExplainReport): string {
  const lines = [
    `medha: thresholds for ${keyLabel(report.key)} (${report.known ? 'known' : 'probation prior'})`,
    `  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}`,
  ];
  for (const gate of report.gates) {
    lines.push(`  ${gate.name}: ${gate.met ? 'MET' : 'not met'}`);
    for (const condition of gate.conditions) {
      lines.push(`    ${condition.met ? 'ok    ' : 'no    '} ${condition.label}`);
    }
  }
  lines.push(`  note: ${report.note}`);
  return `${lines.join('\n')}\n`;
}

export function renderMaintainPreflight(report: MaintainPreflightReport): string {
  const p = report.preflight;
  if (p.status === 'corrupt') {
    const src = p.location?.source ?? 'unknown';
    return (
      `medha: store at ${src} is corrupt — preflight exits 1\n` +
      `  hint: restore the last snapshot or inspect the store log\n`
    );
  }
  const lastSweep = p.lastSweep === null ? 'not yet' : new Date(p.lastSweep).toISOString();
  const lines = [
    `medha: preflight for ${report.home}`,
    `  status:     ${p.status}`,
    `  episodes:   ${p.episodeCount}`,
    `  entities:   ${p.entityCount}`,
    `  integrity:  ${p.integrity}`,
    `  registries: ${p.registries.kinds} kinds, ${p.registries.signals} signals, ${p.registries.anchors} anchors`,
    `  last sweep: ${lastSweep}`,
  ];
  if (report.unregisteredKinds && report.unregisteredKinds.length > 0) {
    for (const { kind, count } of report.unregisteredKinds) {
      lines.push(
        `  warning:    Found ${count} ${count === 1 ? 'entity' : 'entities'} with unregistered kind '${kind}'. Data is safe. Restore '${kind}' to registries or run 'medha maintain prune --kind ${kind}'.`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderMaintainCompact(report: MaintainCompactReport): string {
  const c = report.report;
  const range = c.compacted === null ? 'none' : `${c.compacted.from}..${c.compacted.to}`;
  const lines = [
    `medha: compaction for ${report.home}`,
    `  folded range:        ${range}`,
    `  baselines written:   ${c.baselinesWritten}`,
    `  remaining episodes:  ${c.remainingEpisodes}`,
    `  entities affected:   ${c.entities}`,
    `  older than (days):   ${c.olderThanDays}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderMaintainBackup(report: MaintainBackupReport): string {
  const snap = report.snapshot;
  const lines = [
    `medha: backup for ${report.home}`,
    `  written to:   ${report.path}`,
    `  format:       ${snap.format}`,
    `  episodes:     ${snap.episodes.length}`,
    `  as of:        ${new Date(report.asOf).toISOString()}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderMaintainRestore(report: MaintainRestoreReport): string {
  const lines = [
    `medha: restore for ${report.home}`,
    `  source:     ${report.path}`,
    `  episodes:   ${report.restored.from} -> ${report.restored.to}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderUpdaterList(report: UpdaterListReport): string {
  const lines = [`updaters (${report.updaters.length}):`];
  for (const u of report.updaters) {
    lines.push(`  ${u.name.padEnd(22)} [${u.source}]`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderUpdaterShow(report: UpdaterShowReport): string {
  const lines = [
    `updater:     ${report.name}`,
    `source:      ${report.source}`,
    `description: ${report.description}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderUpdaterFork(report: UpdaterForkReport): string {
  const lines = [
    `scaffolded custom updater from '${report.name}'`,
    `  path: ${report.path}`,
    `  load: import and pass via SageOptions { updaters: new UpdaterRegistry({ project: { ... } }) }`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderSyncStatus(status: {
  readonly state: string;
  readonly localCount: number;
  readonly remoteCount?: number | undefined;
  readonly ref?: string | undefined;
  readonly message?: string | undefined;
}): string {
  const lines: string[] = [
    `Sync Status: ${status.state.toUpperCase()}`,
    `  Local entities:  ${status.localCount}`,
  ];
  if (status.remoteCount !== undefined) {
    lines.push(`  Remote entities: ${status.remoteCount}`);
  }
  if (status.ref) {
    lines.push(`  Target ref/file: ${status.ref}`);
  }
  if (status.message) {
    lines.push(`  Note:            ${status.message}`);
  }
  return lines.join('\n');
}

export function renderSyncPull(result: {
  readonly ok: boolean;
  readonly updated: boolean;
  readonly pulledCount: number;
  readonly localTotal: number;
  readonly error?: string | undefined;
}): string {
  if (!result.ok) {
    return `Sync pull failed: ${result.error || 'unknown error'}`;
  }
  return [
    'Sync pull completed successfully.',
    `  Pulled:       ${result.pulledCount}`,
    `  Total local:  ${result.localTotal}`,
    `  Updated:      ${result.updated ? 'yes' : 'no'}`,
  ].join('\n');
}

export function renderSyncPush(result: {
  readonly ok: boolean;
  readonly pushedCount: number;
  readonly commit?: string | undefined;
  readonly error?: string | undefined;
}): string {
  if (!result.ok) {
    return `Sync push failed: ${result.error || 'unknown error'}`;
  }
  const lines = ['Sync push completed successfully.', `  Pushed entities: ${result.pushedCount}`];
  if (result.commit) {
    lines.push(`  Commit SHA:      ${result.commit}`);
  }
  return lines.join('\n');
}
