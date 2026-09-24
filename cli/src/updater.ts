import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { UpdaterInfo, UpdaterSource } from '@cntxt-labs/medha';
import { InvalidArgumentError } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { UpdaterForkError, UpdaterNotFoundError } from './errors.ts';
import { openHome } from './open.ts';

export interface UpdaterCommonOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
}

export interface UpdaterListOptions extends UpdaterCommonOptions {}

export interface UpdaterListReport {
  readonly home: string;
  readonly updaters: readonly UpdaterInfo[];
}

export async function runUpdaterList(
  options: UpdaterListOptions,
  environment: Environment,
): Promise<UpdaterListReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const updaters = opened.engine.updaters.listUpdaters();
    return { home: opened.home, updaters };
  } finally {
    await opened.engine.close();
  }
}

export interface UpdaterShowOptions extends UpdaterCommonOptions {
  readonly name?: string | undefined;
}

export interface UpdaterShowReport {
  readonly home: string;
  readonly name: string;
  readonly source: UpdaterSource;
  readonly description: string;
}

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  ema: 'Exponential Moving Average with canonical trial weighting',
  wilson: 'Wilson score interval lower bound (confidence-adjusted success rate)',
  'sliding-window': 'Sliding-window trial history (fixed recent trial memory)',
  'asymmetric-penalty': 'Asymmetric penalty (moderate gain on success, harsh penalty on rejection)',
  asymmetric: 'Asymmetric penalty (moderate gain on success, harsh penalty on rejection)',
};

export async function runUpdaterShow(
  options: UpdaterShowOptions,
  environment: Environment,
): Promise<UpdaterShowReport> {
  if (!options.name || typeof options.name !== 'string') {
    throw new InvalidArgumentError('name', 'a non-empty updater name', options.name);
  }
  const name = options.name;
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const updaters = opened.engine.updaters.listUpdaters();
    const found = updaters.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      throw new UpdaterNotFoundError(
        options.name,
        updaters.map((u) => u.name),
      );
    }
    const description =
      BUILTIN_DESCRIPTIONS[found.name.toLowerCase()] ??
      `Custom ${found.source} weight updater '${found.name}'`;
    return {
      home: opened.home,
      name: found.name,
      source: found.source,
      description,
    };
  } finally {
    await opened.engine.close();
  }
}

export interface UpdaterForkOptions extends UpdaterCommonOptions {
  readonly name?: string | undefined;
  readonly out?: string | undefined;
}

export interface UpdaterForkReport {
  readonly home: string;
  readonly name: string;
  readonly path: string;
  readonly scaffolded: boolean;
}

export async function runUpdaterFork(
  options: UpdaterForkOptions,
  environment: Environment,
): Promise<UpdaterForkReport> {
  if (!options.name || typeof options.name !== 'string') {
    throw new InvalidArgumentError('name', 'a non-empty updater name', options.name);
  }
  const name = options.name;
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const updaters = opened.engine.updaters.listUpdaters();
    const found = updaters.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      throw new UpdaterNotFoundError(
        options.name,
        updaters.map((u) => u.name),
      );
    }
    const targetPath = options.out
      ? resolve(options.out)
      : join(opened.home, 'updaters', `${found.name}-fork.ts`);
    if (existsSync(targetPath)) {
      throw new UpdaterForkError(targetPath);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    const template = generateUpdaterTemplate(found.name, basename(targetPath));
    writeFileSync(targetPath, template, 'utf8');
    return {
      home: opened.home,
      name: found.name,
      path: targetPath,
      scaffolded: true,
    };
  } finally {
    await opened.engine.close();
  }
}

function generateUpdaterTemplate(baseName: string, fileName: string): string {
  const updaterName = fileName.replace(/\.[^.]+$/, '');
  const varName = `${toCamelCase(baseName)}CustomUpdater`;

  let computeLogic = '';
  const canonical = baseName.toLowerCase();
  if (canonical === 'ema') {
    computeLogic = `    // Exponential moving average:
    const alpha = ctx.parameters && typeof (ctx.parameters as any).alpha === 'number' ? (ctx.parameters as any).alpha : 0.1;
    const signalVal = ctx.signal.countsAsSuccess ? 1 : ctx.signal.countsAsTrial ? -1 : 0;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + alpha * (signalVal - ctx.currentWeight)));
    const isDrifting = Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };`;
  } else if (canonical === 'asymmetric-penalty' || canonical === 'asymmetric') {
    computeLogic = `    // Asymmetric penalty: moderate gain on success (+0.04), harsh penalty on rejection (-0.25)
    const delta =
      ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess
        ? 0.04 * (1 - ctx.currentWeight)
        : ctx.signal.name === 'REJECT_CONTEXT'
          ? -0.05 * ctx.currentWeight
          : ctx.signal.countsAsTrial
            ? -0.25 * ctx.currentWeight
            : 0;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + delta));
    const isDrifting = ctx.sampleCount >= 10 && Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };`;
  } else if (canonical === 'sliding-window') {
    computeLogic = `    // Sliding window bounded step:
    const step = 1 / Math.max(10, Math.min(50, ctx.sampleCount + 1));
    const delta =
      ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess
        ? step * (1 - ctx.currentWeight)
        : ctx.signal.name === 'REJECT_CONTEXT'
          ? -step * 0.5 * ctx.currentWeight
          : ctx.signal.countsAsTrial
            ? -step * ctx.currentWeight
            : 0;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + delta));
    const isDrifting = ctx.sampleCount >= 10 && Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };`;
  } else {
    computeLogic = `    // Wilson-inspired / custom confidence logic:
    const countsAsSuccess = ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess;
    const totalPositive = ctx.acceptanceCount + (countsAsSuccess ? 1 : 0);
    const totalSamples = ctx.sampleCount + 1;
    const ratio = totalPositive / totalSamples;
    const newWeight = Math.max(0, Math.min(1, 0.5 * ctx.initialWeight + 0.5 * ratio));
    const isDrifting = totalSamples >= 10 && Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };`;
  }

  return `import type { MedhaWeightUpdater, WeightUpdateContext, WeightUpdateOutcome } from '@cntxt-labs/medha';

/**
 * Custom weight updater scaffolded from '${baseName}'.
 *
 * AUTOMATIC DISCOVERY:
 * When located in '<home>/updaters/${fileName}', the Medha CLI, MCP server,
 * and UI automatically discover and register this updater under the name '${updaterName}'.
 *
 * PROGRAMMATIC Usage:
 *
 *   import { Medha, UpdaterRegistry } from '@cntxt-labs/medha';
 *   import { ${varName} } from './${fileName}';
 *
 *   const updaters = new UpdaterRegistry({
 *     project: { '${updaterName}': ${varName} },
 *   });
 *   const medha = new Medha({ store, updaters });
 */
export const ${varName}: MedhaWeightUpdater = {
  name: '${updaterName}',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {
${computeLogic}
  },
};
`;
}

function toCamelCase(str: string): string {
  return str.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
}
