import { InvalidArgumentError, type PackOutcome } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { parseIds } from './read.ts';
import { keyLabel } from './render.ts';

export interface PackOptions {
  readonly dir?: string;
  readonly home?: string;
  readonly budget?: string | number;
  readonly kind?: string;
  readonly namespace?: string;
  /** Comma-separated entity ids (gh-23). */
  readonly ids?: string;
  readonly exploration?: string | number;
  readonly format?: string;
  readonly seed?: string | number;
  /** Comma-separated file paths or globs for selective context matching (medha-c8z.1). */
  readonly files?: string;
  /** Active programming language ID (medha-c8z.1). */
  readonly language?: string;
  /** Active task query or prompt keywords (medha-c8z.1). */
  readonly query?: string;
  /** Include high-confidence negative-evidence pitfalls radar (medha-c8z.4). */
  readonly pitfalls?: boolean;
}

export interface PackReport {
  readonly home: string;
  readonly budget: number;
  readonly outcome: PackOutcome;
  readonly format: 'markdown' | 'compact' | 'json';
}

function parseNonNegativeInt(
  name: string,
  raw: string | number | undefined,
  defaultValue?: number,
): number {
  if (raw === undefined || raw === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new InvalidArgumentError(name, 'a non-negative integer', raw);
  }
  const val = Number(raw);
  if (!Number.isSafeInteger(val) || val < 0) {
    throw new InvalidArgumentError(name, 'a non-negative integer', raw);
  }
  return val;
}

function parseRatio(name: string, raw: string | number | undefined, defaultValue: number): number {
  if (raw === undefined || raw === '') return defaultValue;
  const val = Number(raw);
  if (!Number.isFinite(val) || val < 0 || val > 1) {
    throw new InvalidArgumentError(name, 'a number in [0, 1]', raw);
  }
  return val;
}

export async function runPack(options: PackOptions, environment: Environment): Promise<PackReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const budget = parseNonNegativeInt('--budget', options.budget);
    const explorationRatio = parseRatio('--exploration', options.exploration, 0.15);
    const seed =
      options.seed !== undefined && options.seed !== ''
        ? parseNonNegativeInt('--seed', options.seed)
        : undefined;

    const formatRaw = (options.format ?? 'markdown').toLowerCase();
    const format: 'markdown' | 'compact' | 'json' =
      formatRaw === 'compact' || formatRaw === 'json' ? formatRaw : 'markdown';

    const contextFilter =
      options.files !== undefined || options.language !== undefined || options.query !== undefined
        ? {
            ...(options.files !== undefined
              ? {
                  files: options.files
                    .split(',')
                    .map((f) => f.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(options.language !== undefined ? { languages: [options.language.trim()] } : {}),
            ...(options.query !== undefined ? { query: options.query.trim() } : {}),
          }
        : undefined;

    const outcome = await opened.engine.pack(
      {
        budget,
        kind: options.kind ?? 'rule',
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        ...(options.ids === undefined ? {} : { ids: parseIds(options.ids) }),
        explorationRatio,
        ...(seed === undefined ? {} : { seed }),
        ...(contextFilter === undefined ? {} : { contextFilter }),
        ...(options.pitfalls === true ? { pitfalls: true } : {}),
      },
      { now: environment.now(), ...(seed === undefined ? {} : { seed }) },
    );

    return {
      home: opened.home,
      budget,
      outcome,
      format,
    };
  } finally {
    await opened.engine.close();
  }
}

function fixed(value: number): string {
  return value.toFixed(3);
}

export function renderPack(report: PackReport): string {
  const { outcome, budget, format } = report;
  const pct = (outcome.utilization * 100).toFixed(1);

  if (format === 'compact') {
    const lines = [
      `medha: packed ${outcome.selected.length} entities (${outcome.totalCost}/${budget} tokens, ${pct}% utilization)`,
    ];
    if (outcome.selected.length > 0) {
      lines.push('  TRUST  STATUS     COST  ADMITTED   KEY');
      for (const item of outcome.selected) {
        const costStr = `${item.cost}t`.padEnd(5);
        lines.push(
          `  ${fixed(item.hint.trustScore)}  ${item.hint.status.padEnd(9)}  ${costStr}  ${item.admittedBy.padEnd(9)}  ${keyLabel(item.key)}`,
        );
      }
    }
    if (outcome.pitfalls && outcome.pitfalls.length > 0) {
      lines.push('');
      lines.push('  PITFALLS (high-confidence negative evidence):');
      for (const p of outcome.pitfalls) {
        const guardStr = p.failingGuard ? ` (guard '${p.failingGuard}' failed)` : '';
        lines.push(`  ! ${p.status.padEnd(11)} ${keyLabel(p.key)}${guardStr} — ${p.reason}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  // Markdown format (ideal for prompt ingestion and agent inspection)
  const lines = [
    `# Medha Evidential Context (${outcome.selected.length} selected, ${outcome.totalCost}/${budget} tokens, ${pct}% utilization)`,
    '',
  ];

  if (outcome.selected.length === 0) {
    lines.push('*No entities selected within budget.*');
  } else {
    for (const item of outcome.selected) {
      const tag = item.admittedBy === 'mandatory' ? ' [mandatory]' : '';
      const noteStr = item.hint.lastNote !== undefined ? `\n  > Note: ${item.hint.lastNote}` : '';
      lines.push(
        `- **${keyLabel(item.key)}**${tag} (trust: ${fixed(item.hint.trustScore)}, cost: ${item.cost}, admitted: ${item.admittedBy})${noteStr}`,
      );
    }
  }

  if (outcome.pitfalls && outcome.pitfalls.length > 0) {
    lines.push('');
    lines.push('## Known Pitfalls & Anti-Patterns (High-Confidence Traps)');
    lines.push('The following approaches have repeatedly failed; avoid them:');
    for (const p of outcome.pitfalls) {
      const noteStr = p.lastNote ? `\n  > Lesson: ${p.lastNote}` : '';
      lines.push(
        `- **${keyLabel(p.key)}** [${p.status}] (${p.trials} trials, ${p.successes} successes)${noteStr}`,
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
