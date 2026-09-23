/**
 * CLI runner for medha sync commands (§9.1).
 */

import {
  FileSyncAdapter,
  GitRefSyncAdapter,
  type PullResult,
  type PushResult,
  type SyncPort,
  type SyncStatus,
} from '@cntxt-labs/medha';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';

export interface SyncCliOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly ref?: string | undefined;
  readonly remote?: string | undefined;
  readonly file?: string | undefined;
}

export async function resolveSyncAdapter(
  options: SyncCliOptions,
  environment: Environment,
): Promise<{ readonly adapter: SyncPort; readonly close: () => Promise<void> }> {
  const rootDir = options.dir ?? environment.cwd;
  const opened = openHome(rootDir, options.home);
  await opened.store.open();

  if (options.file) {
    return {
      adapter: new FileSyncAdapter({ store: opened.store, filePath: options.file }),
      close: () => opened.store.close(),
    };
  }

  return {
    adapter: new GitRefSyncAdapter({
      store: opened.store,
      rootDir,
      ref: options.ref,
      remote: options.remote,
    }),
    close: () => opened.store.close(),
  };
}

export async function runSyncStatus(
  options: SyncCliOptions,
  environment: Environment,
): Promise<SyncStatus> {
  const { adapter, close } = await resolveSyncAdapter(options, environment);
  try {
    return await adapter.status({ now: environment.now() });
  } finally {
    await close();
  }
}

export async function runSyncPull(
  options: SyncCliOptions,
  environment: Environment,
): Promise<PullResult> {
  const { adapter, close } = await resolveSyncAdapter(options, environment);
  try {
    const res = await adapter.pull({ now: environment.now() });
    if (!res.ok) {
      environment.exitCode = 1;
    }
    return res;
  } finally {
    await close();
  }
}

export async function runSyncPush(
  options: SyncCliOptions,
  environment: Environment,
): Promise<PushResult> {
  const { adapter, close } = await resolveSyncAdapter(options, environment);
  try {
    const res = await adapter.push({ now: environment.now() });
    if (!res.ok) {
      environment.exitCode = 1;
    }
    return res;
  } finally {
    await close();
  }
}
