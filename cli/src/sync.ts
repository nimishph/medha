/**
 * CLI runner for medha sync commands (§9.1).
 */

import * as readline from 'node:readline/promises';
import {
  FileSyncAdapter,
  GitRefSyncAdapter,
  type PullResult,
  type PushResult,
  type StorePort,
  type StoreRegistries,
  type SyncPort,
  type SyncStatus,
} from '@cntxt-labs/medha';
import type { Environment } from './environment.ts';
import { SyncRegistryMismatchError } from './errors.ts';
import { type MedhaConfigV1, registryDiff, writeConfig } from './layout.ts';
import { openHome } from './open.ts';

export interface SyncCliOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly ref?: string | undefined;
  readonly remote?: string | undefined;
  readonly file?: string | undefined;
  readonly autoImportRegistries?: boolean | undefined;
}

export function createSyncAdapter(
  store: StorePort,
  options: SyncCliOptions,
  rootDir: string,
): SyncPort {
  if (options.file) {
    return new FileSyncAdapter({ store, filePath: options.file });
  }

  return new GitRefSyncAdapter({
    store,
    rootDir,
    ref: options.ref,
    remote: options.remote,
  });
}

export async function resolveSyncAdapter(
  options: SyncCliOptions,
  environment: Environment,
): Promise<{ readonly adapter: SyncPort; readonly close: () => Promise<void> }> {
  const rootDir = options.dir ?? environment.cwd;
  const opened = openHome(rootDir, options.home);
  await opened.store.open();

  return {
    adapter: createSyncAdapter(opened.store, options, rootDir),
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
  const rootDir = options.dir ?? environment.cwd;
  let opened = openHome(rootDir, options.home);
  await opened.store.open();
  let adapter = createSyncAdapter(opened.store, options, rootDir);

  try {
    if (adapter.peek) {
      const incoming = await adapter.peek({ now: environment.now() });
      if (incoming?.registries) {
        const diff = registryDiff(opened.config.registries, incoming.registries);
        const hasMissing =
          diff.kinds.added.length > 0 ||
          diff.signals.added.length > 0 ||
          diff.anchors.added.length > 0;

        if (hasMissing) {
          let shouldImport = options.autoImportRegistries === true;
          if (!shouldImport && process.stdin.isTTY && environment.isTTY) {
            const addedParts: string[] = [];
            if (diff.kinds.added.length > 0) {
              addedParts.push(
                `${diff.kinds.added.length} custom kinds (${diff.kinds.added.join(', ')})`,
              );
            }
            if (diff.signals.added.length > 0) {
              addedParts.push(
                `${diff.signals.added.length} custom signals (${diff.signals.added.join(', ')})`,
              );
            }
            if (diff.anchors.added.length > 0) {
              addedParts.push(
                `${diff.anchors.added.length} custom anchors (${diff.anchors.added.join(', ')})`,
              );
            }
            const promptMsg = `Incoming sync contains ${addedParts.join(' and ')}. Import into local config.json? [Y/n] `;
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await rl.question(promptMsg);
              shouldImport = answer.trim() === '' || answer.trim().toLowerCase().startsWith('y');
            } catch {
              shouldImport = false;
            } finally {
              rl.close();
            }
          }

          if (!shouldImport) {
            throw new SyncRegistryMismatchError(diff);
          }

          // Merge registries into config.json
          const incomingRegs = incoming.registries;
          const mergedKinds = Array.from(
            new Set([...opened.config.registries.kinds, ...diff.kinds.added]),
          ).sort();
          const mergedAnchors = Array.from(
            new Set([...opened.config.registries.anchorKinds, ...diff.anchors.added]),
          ).sort();

          const existingKindSpecs = opened.config.registries.kindSpecs ?? [];
          const incomingKindSpecs = incomingRegs.kindSpecs ?? [];
          const kindSpecMap = new Map(existingKindSpecs.map((s) => [s.name, s]));
          for (const spec of incomingKindSpecs) {
            if (!kindSpecMap.has(spec.name)) {
              kindSpecMap.set(spec.name, spec);
            }
          }
          const mergedKindSpecs = [...kindSpecMap.values()];

          const existingSignalSpecs = opened.config.registries.signalSpecs;
          const existingSignalNames = new Set(existingSignalSpecs.map((s) => s.name));
          const incomingSignalSpecs = incomingRegs.signalSpecs ?? [];
          const addedSignalSpecs = incomingSignalSpecs.filter(
            (s) => !existingSignalNames.has(s.name),
          );
          const mergedSignalSpecs = [...existingSignalSpecs, ...addedSignalSpecs];

          const updatedRegistries: StoreRegistries = {
            kinds: mergedKinds,
            ...(mergedKindSpecs.length > 0 ? { kindSpecs: mergedKindSpecs } : {}),
            signalSpecs: mergedSignalSpecs,
            anchorKinds: mergedAnchors,
          };

          const updatedConfig: MedhaConfigV1 = {
            ...opened.config,
            registries: updatedRegistries,
          };
          writeConfig(opened.home, updatedConfig);

          // Close previous store and reopen with new config
          await opened.store.close();
          opened = openHome(rootDir, options.home);
          await opened.store.open();
          adapter = createSyncAdapter(opened.store, options, rootDir);
        }
      }
    }

    const res = await adapter.pull({ now: environment.now() });
    if (!res.ok) {
      environment.exitCode = 1;
    }
    return res;
  } finally {
    await opened.store.close();
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
