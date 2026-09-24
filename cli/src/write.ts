import {
  type EntityKey,
  type Episode,
  type EvidentialHint,
  InvalidArgumentError,
  type StoreRegistries,
  UnknownKindError,
} from '@cntxt-labs/medha-core';
import { resolveRegistries } from '@cntxt-labs/medha-store';
import type { Environment } from './environment.ts';
import { UpdaterNotFoundError } from './errors.ts';
import { openHome } from './open.ts';
import { keyFromFlags } from './read.ts';
import { keyLabel } from './render.ts';

function requireConfiguredKind(configRegistries: StoreRegistries | undefined, kind: string): void {
  const allowed = resolveRegistries(configRegistries).kinds;
  if (!allowed.includes(kind)) {
    throw new UnknownKindError(kind, allowed);
  }
}

/**
 * Write-plane commands: the CLI twins of the MCP `record_signal`, `report_guard` and `propose`
 * tools, so shell hooks can feed evidence without speaking MCP.
 */

interface WriteFlags {
  readonly dir?: string;
  readonly home?: string | undefined;
  readonly namespace?: string;
  readonly kind?: string;
  readonly id?: string;
}

export function parseTimestamp(raw: string | number | undefined, defaultNow: number): number {
  if (raw === undefined || raw === '') return defaultNow;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new InvalidArgumentError('--at', 'a finite non-negative epoch timestamp', raw);
    }
    return Math.floor(raw);
  }
  const numeric = Number(raw);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError('--at', 'a valid ISO 8601 string or epoch ms', raw);
  }
  return parsed;
}

export function resolveAuthor(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return env.MEDHA_AUTHOR || env.USER || env.USERNAME || undefined;
}

export interface RecordOptions extends WriteFlags {
  readonly signal?: string;
  readonly updater?: string;
  readonly ensure?: boolean;
  readonly author?: string;
  readonly at?: string | number;
  readonly note?: string;
}

export interface RecordReport {
  readonly home: string;
  readonly key: EntityKey;
  readonly signal: string;
  /** False when the entity is unknown and `--ensure` was not passed: nothing was written. */
  readonly recorded: boolean;
  readonly hint: EvidentialHint;
  readonly note?: string | undefined;
}

export async function runRecord(
  options: RecordOptions,
  environment: Environment,
): Promise<RecordReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    if (options.signal === undefined || options.signal === '') {
      throw new InvalidArgumentError('--signal', 'a registered signal name', options.signal);
    }
    if (options.updater !== undefined && options.updater !== '') {
      if (!opened.engine.updaters.has(options.updater)) {
        throw new UpdaterNotFoundError(
          options.updater,
          opened.engine.updaters.listUpdaters().map((u) => u.name),
        );
      }
    }
    const key = keyFromFlags(options);
    requireConfiguredKind(opened.config.registries, key.kind);
    const at = parseTimestamp(options.at, environment.now());
    const author = resolveAuthor(options.author);
    const outcome = await opened.engine.record(
      key,
      options.signal,
      { now: at },
      {
        ...(options.updater === undefined ? {} : { updater: options.updater }),
        ensure: options.ensure === true,
        ...(author === undefined ? {} : { author }),
        ...(options.note === undefined ? {} : { note: options.note }),
      },
    );
    return {
      home: opened.home,
      key,
      signal: options.signal,
      recorded: outcome.state !== undefined,
      hint: outcome.hint,
      ...(options.note === undefined ? {} : { note: options.note }),
    };
  } finally {
    await opened.engine.close();
  }
}

export interface GuardOptions extends WriteFlags {
  readonly ok?: boolean;
  readonly fail?: boolean;
  readonly guard?: string;
  readonly author?: string;
  readonly at?: string | number;
  readonly note?: string;
}

export interface GuardReport {
  readonly home: string;
  readonly key: EntityKey;
  readonly ok: boolean;
  readonly hint: EvidentialHint;
  readonly note?: string | undefined;
}

export async function runGuard(
  options: GuardOptions,
  environment: Environment,
): Promise<GuardReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const ok = options.ok === true;
    if (ok === (options.fail === true)) {
      throw new InvalidArgumentError(
        '--ok/--fail',
        'exactly one of --ok or --fail',
        'both or none',
      );
    }
    const key = keyFromFlags(options);
    requireConfiguredKind(opened.config.registries, key.kind);
    const at = parseTimestamp(options.at, environment.now());
    const author = resolveAuthor(options.author);
    const hint = await opened.engine.reportGuard(
      key,
      {
        ok,
        ...(options.guard === undefined ? {} : { kind: options.guard }),
        at,
        ...(author === undefined ? {} : { author }),
        ...(options.note === undefined ? {} : { note: options.note }),
      },
      { now: at },
    );
    return {
      home: opened.home,
      key,
      ok,
      hint,
      ...(options.note === undefined ? {} : { note: options.note }),
    };
  } finally {
    await opened.engine.close();
  }
}

export interface ProposeOptions extends WriteFlags {
  readonly source?: string;
  readonly text?: string;
  readonly evidence?: string;
  readonly author?: string;
  readonly at?: string | number;
  readonly note?: string;
}

export interface ProposeReport {
  readonly home: string;
  readonly key: EntityKey;
  readonly promoted: boolean;
  readonly promotionReason?: string | undefined;
  readonly provenances: readonly string[];
  readonly hint: EvidentialHint;
  readonly note?: string | undefined;
}

export async function runPropose(
  options: ProposeOptions,
  environment: Environment,
): Promise<ProposeReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    if (options.source === undefined || options.source.trim() === '') {
      throw new InvalidArgumentError('--source', 'a non-empty proposal source', options.source);
    }
    const key = keyFromFlags(options);
    requireConfiguredKind(opened.config.registries, key.kind);
    const at = parseTimestamp(options.at, environment.now());
    const author = resolveAuthor(options.author);
    const evidenceRefs = (options.evidence ?? '')
      .split(',')
      .map((ref) => ref.trim())
      .filter((ref) => ref !== '');
    const outcome = await opened.engine.propose(
      {
        key,
        provenance: options.source,
        ...(options.text === undefined ? {} : { text: options.text }),
        ...(evidenceRefs.length === 0 ? {} : { evidenceRefs }),
        ...(author === undefined ? {} : { author }),
        ...(options.note === undefined ? {} : { note: options.note }),
      },
      { now: at },
    );
    return {
      home: opened.home,
      key,
      promoted: outcome.promoted,
      ...(outcome.promotionReason === undefined
        ? {}
        : { promotionReason: outcome.promotionReason }),
      provenances: outcome.provenances,
      hint: outcome.hint,
      ...(options.note === undefined ? {} : { note: options.note }),
    };
  } finally {
    await opened.engine.close();
  }
}

export interface RetractOptions extends WriteFlags {
  readonly seq?: string | number;
  readonly reason?: string;
  readonly author?: string;
  readonly at?: string | number;
}

export interface RetractReport {
  readonly home: string;
  readonly targetSeq: number;
  readonly reason: string;
  readonly seq: number;
  readonly episode: Episode;
  readonly hint: EvidentialHint;
}

export async function runRetract(
  options: RetractOptions,
  environment: Environment,
): Promise<RetractReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    if (options.seq === undefined || options.seq === '') {
      throw new InvalidArgumentError('--seq', 'an episode sequence number', options.seq);
    }
    const targetSeq = Number(options.seq);
    if (!Number.isInteger(targetSeq) || targetSeq < 0) {
      throw new InvalidArgumentError('--seq', 'a non-negative integer', options.seq);
    }
    if (options.reason === undefined || options.reason.trim() === '') {
      throw new InvalidArgumentError(
        '--reason',
        'a non-empty reason for retraction',
        options.reason,
      );
    }
    const at = parseTimestamp(options.at, environment.now());
    const author = resolveAuthor(options.author);
    const outcome = await opened.engine.retract(
      targetSeq,
      options.reason,
      { now: at },
      { ...(author === undefined ? {} : { author }) },
    );
    return {
      home: opened.home,
      targetSeq,
      reason: options.reason,
      seq: outcome.episode.seq,
      episode: outcome.episode,
      hint: outcome.hint,
    };
  } finally {
    await opened.engine.close();
  }
}

export interface RemoveEpisodeOptions {
  readonly dir?: string;
  readonly home?: string;
  readonly seq?: string | number;
}

export interface RemoveEpisodeReport {
  readonly home: string;
  readonly seq: number;
  readonly removed: boolean;
  readonly remainingCount: number;
}

export async function runRemoveEpisode(
  options: RemoveEpisodeOptions,
  environment: Environment,
): Promise<RemoveEpisodeReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    if (options.seq === undefined || options.seq === '') {
      throw new InvalidArgumentError('--seq', 'an episode sequence number', options.seq);
    }
    const seq = Number(options.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      throw new InvalidArgumentError('--seq', 'a non-negative integer', options.seq);
    }
    const outcome = await opened.engine.removeEpisode(seq);
    return {
      home: opened.home,
      seq,
      removed: outcome.removed,
      remainingCount: outcome.remainingCount,
    };
  } finally {
    await opened.engine.close();
  }
}

function fixed(value: number): string {
  return value.toFixed(3);
}

export function renderRecord(report: RecordReport): string {
  const head = report.recorded
    ? `medha: recorded ${report.signal} on ${keyLabel(report.key)}`
    : `medha: NOT recorded — ${keyLabel(report.key)} is unknown (pass --ensure to create it)`;
  const lines = [
    head,
    `  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}`,
  ];
  if (report.note !== undefined) {
    lines.push(`  note:     ${report.note}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderGuard(report: GuardReport): string {
  const lines = [
    `medha: guard ${report.ok ? 'passed' : 'failed'} on ${keyLabel(report.key)}`,
    `  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}`,
  ];
  if (report.note !== undefined) {
    lines.push(`  note:     ${report.note}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderPropose(report: ProposeReport): string {
  const lines = [
    `medha: proposed ${keyLabel(report.key)} (${report.promoted ? 'promoted' : 'not promoted'})`,
  ];
  if (report.promotionReason !== undefined) lines.push(`  reason:   ${report.promotionReason}`);
  if (report.note !== undefined) lines.push(`  note:     ${report.note}`);
  lines.push(`  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}`);
  return `${lines.join('\n')}\n`;
}

export function renderRetract(report: RetractReport): string {
  return (
    `medha: retracted episode #${report.targetSeq} (recorded as #${report.seq})\n` +
    `  reason:   ${report.reason}\n` +
    `  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}\n`
  );
}

export function renderRemoveEpisode(report: RemoveEpisodeReport): string {
  return report.removed
    ? `medha: removed episode #${report.seq} from log (${report.remainingCount} episodes remaining)\n`
    : `medha: episode #${report.seq} was not found in log (${report.remainingCount} episodes remaining)\n`;
}
