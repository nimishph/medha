import { InvalidArgumentError, type PackOutcome } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { keyLabel } from './render.ts';

export interface PackOptions {
  readonly dir?: string;
  readonly home?: string;
  readonly budget?: string | number;
  readonly kind?: string;
  readonly namespace?: string;
  readonly exploration?: string | number;
  readonly format?: string;
  readonly seed?: string | number;
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

    const outcome = await opened.engine.pack(
      {
        budget,
        kind: options.kind ?? 'rule',
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        explorationRatio,
        ...(seed === undefined ? {} : { seed }),
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
  lines.push('');
  return `${lines.join('\n')}\n`;
}
