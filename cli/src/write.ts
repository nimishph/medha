import { type EntityKey, type EvidentialHint, InvalidArgumentError } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { keyFromFlags } from './read.ts';
import { keyLabel } from './render.ts';

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

export interface RecordOptions extends WriteFlags {
  readonly signal?: string;
  readonly updater?: string;
  readonly ensure?: boolean;
}

export interface RecordReport {
  readonly home: string;
  readonly key: EntityKey;
  readonly signal: string;
  /** False when the entity is unknown and `--ensure` was not passed: nothing was written. */
  readonly recorded: boolean;
  readonly hint: EvidentialHint;
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
    const key = keyFromFlags(options);
    const outcome = await opened.engine.record(
      key,
      options.signal,
      { now: environment.now() },
      {
        ...(options.updater === undefined ? {} : { updater: options.updater }),
        ensure: options.ensure === true,
      },
    );
    return {
      home: opened.home,
      key,
      signal: options.signal,
      recorded: outcome.state !== undefined,
      hint: outcome.hint,
    };
  } finally {
    await opened.engine.close();
  }
}

export interface GuardOptions extends WriteFlags {
  readonly ok?: boolean;
  readonly fail?: boolean;
  readonly guard?: string;
}

export interface GuardReport {
  readonly home: string;
  readonly key: EntityKey;
  readonly ok: boolean;
  readonly hint: EvidentialHint;
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
    const hint = await opened.engine.reportGuard(
      key,
      { ok, ...(options.guard === undefined ? {} : { kind: options.guard }) },
      { now: environment.now() },
    );
    return { home: opened.home, key, ok, hint };
  } finally {
    await opened.engine.close();
  }
}

export interface ProposeOptions extends WriteFlags {
  readonly source?: string;
  readonly text?: string;
  readonly evidence?: string;
}

export interface ProposeReport {
  readonly home: string;
  readonly key: EntityKey;
  readonly promoted: boolean;
  readonly promotionReason?: string | undefined;
  readonly provenances: readonly string[];
  readonly hint: EvidentialHint;
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
      },
      { now: environment.now() },
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
  return `${head}\n  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}\n`;
}

export function renderGuard(report: GuardReport): string {
  return (
    `medha: guard ${report.ok ? 'passed' : 'failed'} on ${keyLabel(report.key)}\n` +
    `  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}\n`
  );
}

export function renderPropose(report: ProposeReport): string {
  const lines = [
    `medha: proposed ${keyLabel(report.key)} (${report.promoted ? 'promoted' : 'not promoted'})`,
  ];
  if (report.promotionReason !== undefined) lines.push(`  reason:   ${report.promotionReason}`);
  lines.push(`  trust:    ${fixed(report.hint.trustScore)}  status: ${report.hint.status}`);
  return `${lines.join('\n')}\n`;
}
