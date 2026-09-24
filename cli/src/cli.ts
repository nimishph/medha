import { MedhaError, toMedhaError } from '@cntxt-labs/medha-core';
import { type CommandDef, renderUsage, runCommand } from 'citty';
import { commands } from './commands.ts';
import { bindEnvironment, type Environment } from './environment.ts';
import { toJson } from './render.ts';
import { VERSION } from './version.ts';

let helpText: string | undefined;

async function help(): Promise<string> {
  helpText ??= await renderUsage(commands);
  return helpText;
}

/**
 * Walk `medha <command> [<sub>...]` down the command tree, so `--help` renders the usage of the
 * deepest command named, not the whole CLI. Stops at the first token that is not a subcommand.
 */
async function resolveUsageTarget(
  argv: readonly string[],
): Promise<{ cmd: CommandDef; parent: CommandDef | undefined }> {
  let cmd: CommandDef = commands as CommandDef;
  let parent: CommandDef | undefined;
  for (const token of argv) {
    if (token.startsWith('-')) continue;
    const subs = (await (typeof cmd.subCommands === 'function'
      ? cmd.subCommands()
      : cmd.subCommands)) as Record<string, unknown> | undefined;
    const next = subs?.[token];
    if (next === undefined) break;
    parent = cmd;
    cmd = (await (typeof next === 'function' ? (next as () => unknown)() : next)) as CommandDef;
  }
  return { cmd, parent };
}

/**
 * The `medha` entrypoint: version/help shortcuts, then a citty dispatch with the environment bound
 * for the (data-dropping) subcommand runners. Returns the exit code — 0 healthy, 1 operational
 * failure, 2 usage (an unknown command, an invalid option value, or a bogus argument). citty 0.2.x
 * parses unknown flags leniently, so typos in option names surface as picked-up positionals, not
 * errors; value-level mistakes (wrong --store, --path with memory) still exit 2.
 */
export async function runCli(argv: readonly string[], environment: Environment): Promise<number> {
  const command = argv[0];
  if (command === '--version' || command === '-v' || command === 'version') {
    environment.stdout(`medha ${VERSION}\n`);
    return 0;
  }
  if (command === undefined) {
    environment.stderr(await help());
    return 2;
  }
  if (command === 'help') {
    const subArgs = argv.slice(1);
    if (subArgs.length === 0) {
      environment.stdout(await help());
      return 0;
    }
    const { cmd, parent } = await resolveUsageTarget(subArgs);
    environment.stdout(await renderUsage(cmd, parent));
    return 0;
  }
  if (command === '--help' || command === '-h') {
    environment.stdout(await help());
    return 0;
  }

  // citty's runCommand does not intercept --help, so without this `medha init --help` would run init.
  if (argv.includes('--help') || argv.includes('-h')) {
    const { cmd, parent } = await resolveUsageTarget(argv);
    environment.stdout(await renderUsage(cmd, parent));
    return 0;
  }

  const json = argv.includes('--json');
  bindEnvironment(environment);
  try {
    await runCommand(commands, { rawArgs: [...argv] });
    return environment.exitCode;
  } catch (failure) {
    const error =
      failure instanceof MedhaError ? failure : toMedhaError(failure, `medha ${command}`);
    if (json) {
      environment.stderr(toJson(error));
    } else {
      environment.stderr(`error: ${error.message}\n`);
      if (error.hint !== undefined) {
        environment.stderr(`hint: ${error.hint}\n`);
      }
      environment.stderr(`(${error.code})\n`);
    }
    return usageExitCode(failure);
  }
}

/** Exit-code taxonomy: unknown flags/args and invalid argument values are usage (2), the rest fail (1). */
function usageExitCode(failure: unknown): number {
  if (failure instanceof Error && failure.name === 'CLIError') {
    return 2;
  }
  if (failure instanceof MedhaError && failure.code === 'CORE_INVALID_ARGUMENT') {
    return 2;
  }
  return 1;
}
