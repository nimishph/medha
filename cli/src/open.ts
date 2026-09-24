import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { Medha, type MedhaWeightUpdater, UpdaterRegistry } from '@cntxt-labs/medha';
import type { StorePort } from '@cntxt-labs/medha-core';
import { HomeNotInitializedError } from './errors.ts';
import { homeFor, type MedhaConfigV1, readConfig, storeForConfig } from './layout.ts';

const require = createRequire(import.meta.url);

/**
 * `openHome` — the shared read-plane entry (spec §9.1 `list/show/…`): reopen a configured engine
 * home from its `config.json`, the single source of truth. It builds exactly the store init
 * committed to (see `storeForConfig`) and wraps it in a `Medha`, but does NOT run the session-start
 * sweep — reads open the store lazily (`ensureOpen`) and never mutate, so a read leaves the log
 * byte-identical (property `cli.read-pure`).
 *
 * Discovers and loads custom weight updaters from `<home>/updaters/*.ts` (project tier).
 */

export interface OpenedHome {
  readonly engine: Medha;
  readonly store: StorePort;
  readonly config: MedhaConfigV1;
  readonly home: string;
}

export function loadProjectUpdaters(home: string): Record<string, MedhaWeightUpdater> {
  const updatersDir = join(home, 'updaters');
  if (!existsSync(updatersDir)) {
    return {};
  }
  const result: Record<string, MedhaWeightUpdater> = {};
  try {
    const entries = readdirSync(updatersDir);
    for (const entry of entries) {
      if (entry.endsWith('.d.ts') || entry.includes('.test.') || entry.includes('.spec.')) {
        continue;
      }
      if (
        !entry.endsWith('.ts') &&
        !entry.endsWith('.js') &&
        !entry.endsWith('.mjs') &&
        !entry.endsWith('.cjs')
      ) {
        continue;
      }
      const fullPath = resolve(updatersDir, entry);
      const mod = require(fullPath);
      const candidates = [mod.default, ...Object.values(mod)];
      for (const candidate of candidates) {
        if (
          candidate &&
          typeof candidate === 'object' &&
          typeof (candidate as MedhaWeightUpdater).computeWeight === 'function'
        ) {
          const rawName = (candidate as MedhaWeightUpdater).name;
          const name =
            typeof rawName === 'string' && rawName.trim() !== ''
              ? rawName.trim()
              : basename(entry).replace(/\.[^.]+$/, '');
          result[name.toLowerCase()] = {
            ...(candidate as MedhaWeightUpdater),
            name,
          };
        }
      }
    }
  } catch (err) {
    void err;
  }
  return result;
}

export function openHome(dir: string, homeOverride?: string): OpenedHome {
  const home = homeFor(dir, homeOverride);
  const config = readConfig(home);
  if (config === null) {
    throw new HomeNotInitializedError(home);
  }
  const store = storeForConfig(config);
  const projectUpdaters = loadProjectUpdaters(home);
  const updaters = new UpdaterRegistry({ project: projectUpdaters });
  const engine = new Medha({ store, updaters });
  return { engine, store, config, home };
}
