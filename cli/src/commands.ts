import { defineCommand } from 'citty';
import { currentEnvironment } from './environment.ts';
import { type InitOptions, runInit } from './init.ts';
import {
  runMaintainBackup,
  runMaintainCompact,
  runMaintainPreflight,
  runMaintainRestore,
} from './maintain.ts';
import {
  driftCommandArgs,
  explainThresholdCommandArgs,
  initCommandArgs,
  listCommandArgs,
  maintainBackupArgs,
  maintainCompactArgs,
  maintainPreflightArgs,
  maintainRestoreArgs,
  paramsCommandArgs,
  showCommandArgs,
  simulateCommandArgs,
  statusCommandArgs,
  updaterForkArgs,
  updaterListArgs,
  updaterShowArgs,
} from './options.ts';
import {
  runDrift,
  runExplainThreshold,
  runList,
  runParams,
  runShow,
  runSimulate,
  runStatus,
} from './read.ts';
import {
  renderDrift,
  renderExplainThreshold,
  renderInit,
  renderList,
  renderMaintainBackup,
  renderMaintainCompact,
  renderMaintainPreflight,
  renderMaintainRestore,
  renderParams,
  renderShow,
  renderSimulate,
  renderStatus,
  renderUpdaterFork,
  renderUpdaterList,
  renderUpdaterShow,
  toJson,
} from './render.ts';
import { runUpdaterFork, runUpdaterList, runUpdaterShow } from './updater.ts';
import { VERSION } from './version.ts';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description:
      'Scaffold the engine home (.sutra/sage/config.json + store) headlessly and gate on preflight.',
  },
  args: initCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const options: InitOptions = {
      dir: args.dir ?? environment.cwd,
      backend: (args.store ?? 'sqlite') as InitOptions['backend'],
      ...(args.path === undefined ? {} : { path: args.path }),
      ...(args.config === undefined ? {} : { config: args.config }),
      ...(args.backup === undefined ? {} : { backup: args.backup }),
      recreate: args.recreate === true,
    };
    const report = await runInit(options, environment);
    environment.stdout(args.json === true ? toJson(report) : renderInit(report));
  },
});

/** Read-plane commands report into stdout/JSON; failures surface through runCli's catch. */

export const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List entities matching kind / status / namespace / drift filters, paginated.',
  },
  args: listCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runList(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
        ...(args.drifting === true ? { drifting: true } : {}),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderList(report));
  },
});

export const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show one entity: trust, components, temporal state, and recent episodes.',
  },
  args: showCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runShow(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.recent === undefined ? {} : { recent: args.recent }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderShow(report));
  },
});

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Engine health: preflight, distribution by lifecycle status, drift count.',
  },
  args: statusCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runStatus(
      { ...(args.dir === undefined ? {} : { dir: args.dir }) },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderStatus(report));
  },
});

export const driftCommand = defineCommand({
  meta: {
    name: 'drift',
    description: 'Entities currently drifting, most-drifted first.',
  },
  args: driftCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runDrift(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderDrift(report));
  },
});

export const paramsCommand = defineCommand({
  meta: {
    name: 'params',
    description: 'Read-only report of the canonical model parameters the kernel uses.',
  },
  args: paramsCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runParams(environment);
    environment.stdout(args.json === true ? toJson(report) : renderParams(report));
  },
});

export const simulateCommand = defineCommand({
  meta: {
    name: 'simulate',
    description: 'What-if: the delta one signal would produce. Nothing is persisted.',
  },
  args: simulateCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runSimulate(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.id === undefined ? {} : { id: args.id }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderSimulate(report));
  },
});

export const explainThresholdCommand = defineCommand({
  meta: {
    name: 'explain-threshold',
    description: 'Which thresholds an entity clears and why (the rename of gate).',
  },
  args: explainThresholdCommandArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runExplainThreshold(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.id === undefined ? {} : { id: args.id }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderExplainThreshold(report));
  },
});

/** Maintenance commands (preflight, compact, backup, restore). */

export const maintainPreflightCommand = defineCommand({
  meta: {
    name: 'preflight',
    description: 'Check store integrity, episode count, and registry match. Exits 1 on corrupt.',
  },
  args: maintainPreflightArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runMaintainPreflight(
      { ...(args.dir === undefined ? {} : { dir: args.dir }) },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderMaintainPreflight(report));
  },
});

export const maintainCompactCommand = defineCommand({
  meta: {
    name: 'compact',
    description: 'Fold aged episode history into baseline snapshots and report the folded range.',
  },
  args: maintainCompactArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runMaintainCompact(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args['older-than'] === undefined ? {} : { olderThan: args['older-than'] }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderMaintainCompact(report));
  },
});

export const maintainBackupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: 'Export an atomic, portable SageSnapshot to a file.',
  },
  args: maintainBackupArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runMaintainBackup(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.path === undefined ? {} : { path: args.path }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderMaintainBackup(report));
  },
});

export const maintainRestoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: 'Replace store state headlessly with a previously exported SageSnapshot.',
  },
  args: maintainRestoreArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runMaintainRestore(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.path === undefined ? {} : { path: args.path }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderMaintainRestore(report));
  },
});

export const maintainCommand = defineCommand({
  meta: {
    name: 'maintain',
    description: 'Engine maintenance: preflight, compact, backup, and restore.',
  },
  subCommands: {
    preflight: maintainPreflightCommand,
    compact: maintainCompactCommand,
    backup: maintainBackupCommand,
    restore: maintainRestoreCommand,
  },
});

/** Weight updater commands (list, show, fork). */

export const updaterListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all registered weight updaters (project -> user -> built-in).',
  },
  args: updaterListArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runUpdaterList(
      { ...(args.dir === undefined ? {} : { dir: args.dir }) },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderUpdaterList(report));
  },
});

export const updaterShowCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Inspect a registered weight updater by name.',
  },
  args: updaterShowArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runUpdaterShow(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.name === undefined ? {} : { name: args.name }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderUpdaterShow(report));
  },
});

export const updaterForkCommand = defineCommand({
  meta: {
    name: 'fork',
    description: 'Scaffold a custom TypeScript weight updater template from a base updater.',
  },
  args: updaterForkArgs,
  async run({ args }) {
    const environment = currentEnvironment();
    const report = await runUpdaterFork(
      {
        ...(args.dir === undefined ? {} : { dir: args.dir }),
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.out === undefined ? {} : { out: args.out }),
      },
      environment,
    );
    environment.stdout(args.json === true ? toJson(report) : renderUpdaterFork(report));
  },
});

export const updaterCommand = defineCommand({
  meta: {
    name: 'updater',
    description: 'Weight updater inspection, listing, and custom updater scaffolding.',
  },
  subCommands: {
    list: updaterListCommand,
    show: updaterShowCommand,
    fork: updaterForkCommand,
  },
});

export const commands = defineCommand({
  meta: {
    name: 'sage',
    description: 'Evidential-memory engine as a command line.',
    version: VERSION,
  },
  subCommands: {
    init: initCommand,
    list: listCommand,
    show: showCommand,
    status: statusCommand,
    drift: driftCommand,
    params: paramsCommand,
    simulate: simulateCommand,
    'explain-threshold': explainThresholdCommand,
    maintain: maintainCommand,
    updater: updaterCommand,
  },
});
