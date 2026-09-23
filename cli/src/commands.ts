import { defineCommand } from 'citty';
import { currentEnvironment } from './environment.ts';
import { type InitOptions, runInit } from './init.ts';
import { initCommandArgs } from './options.ts';
import { renderInit, toJson } from './render.ts';
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

export const commands = defineCommand({
  meta: {
    name: 'sage',
    description: 'Evidential-memory engine as a command line.',
    version: VERSION,
  },
  subCommands: {
    init: initCommand,
  },
});
