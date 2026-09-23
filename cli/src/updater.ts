import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { UpdaterInfo, UpdaterSource } from '@sutras/sage';
import { InvalidArgumentError } from '@sutras/sage-core';
import type { Environment } from './environment.ts';
import { UpdaterForkError, UpdaterNotFoundError } from './errors.ts';
import { openHome } from './open.ts';

export interface UpdaterCommonOptions {
  readonly dir?: string | undefined;
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
  const opened = openHome(options.dir ?? environment.cwd);
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
  const opened = openHome(options.dir ?? environment.cwd);
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
  const opened = openHome(options.dir ?? environment.cwd);
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
  return `import type { SageWeightUpdater, WeightUpdateContext, WeightUpdateOutcome } from '@sutras/sage';

/**
 * Custom weight updater scaffolded from '${baseName}'.
 *
 * LOADING / REGISTRATION:
 * Pass this updater to the Sage engine via SageOptions.updaters at host initialization:
 *
 *   import { Sage, UpdaterRegistry } from '@sutras/sage';
 *   import { ${toCamelCase(baseName)}CustomUpdater } from './${fileName}';
 *
 *   const updaters = new UpdaterRegistry({
 *     project: { '${baseName}-custom': ${toCamelCase(baseName)}CustomUpdater },
 *   });
 *   const sage = new Sage({ store, updaters });
 */
export const ${toCamelCase(baseName)}CustomUpdater: SageWeightUpdater = {
  name: '${baseName}-custom',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {
    // Current state + incoming signal:
    //   ctx.currentWeight: number (0..1)
    //   ctx.initialWeight: number
    //   ctx.sampleCount: number
    //   ctx.signal: SignalSpec (name, countsAsTrial, countsAsSuccess, weight)
    //   ctx.step?: number
    const delta = ctx.signal.countsAsSuccess ? 0.05 : -0.1;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + delta));
    return {
      newWeight,
      isDrifting: Math.abs(newWeight - ctx.initialWeight) > 0.3,
    };
  },
};
`;
}

function toCamelCase(str: string): string {
  return str.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
}
