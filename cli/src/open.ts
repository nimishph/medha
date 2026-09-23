import { Sage } from '@cntxt-labs/medha';
import type { StorePort } from '@cntxt-labs/medha-core';
import { HomeNotInitializedError } from './errors.ts';
import { homeFor, type MedhaConfigV1, readConfig, storeForConfig } from './layout.ts';

/**
 * `openHome` — the shared read-plane entry (spec §9.1 `list/show/…`): reopen a configured engine
 * home from its `config.json`, the single source of truth. It builds exactly the store init
 * committed to (see `storeForConfig`) and wraps it in a `Sage`, but does NOT run the session-start
 * sweep — reads open the store lazily (`ensureOpen`) and never mutate, so a read leaves the log
 * byte-identical (property `cli.read-pure`).
 *
 * The memory backend is the deliberate exception: init persists nothing, so a memory home has no
 * config to reopen — reads report `CLI_NOT_INITIALIZED` with a hint naming exactly that.
 */

export interface OpenedHome {
  readonly engine: Sage;
  readonly store: StorePort;
  readonly config: MedhaConfigV1;
  readonly home: string;
}

export function openHome(dir: string, homeOverride?: string): OpenedHome {
  const home = homeFor(dir, homeOverride);
  const config = readConfig(home);
  if (config === null) {
    throw new HomeNotInitializedError(home);
  }
  const store = storeForConfig(config);
  const engine = new Sage({ store });
  return { engine, store, config, home };
}
