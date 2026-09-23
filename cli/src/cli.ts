import { SageError, toSageError } from '@sutras/sage-core';
import { renderUsage, runCommand } from 'citty';
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
 * The `sage` entrypoint: version/help shortcuts, then a citty dispatch with the environment bound
 * for the (data-dropping) subcommand runners. Returns the exit code — 0 healthy, 1 operational
 * failure, 2 usage (an unknown command, an invalid option value, or a bogus argument). citty 0.2.x
 * parses unknown flags leniently, so typos in option names surface as picked-up positionals, not
 * errors; value-level mistakes (wrong --store, --path with memory) still exit 2.
 */
export async function runCli(argv: readonly string[], environment: Environment): Promise<number> {
  const command = argv[0];
  if (command === '--version' || command === '-v' || command === 'version') {
    environment.stdout(`sage ${VERSION}\n`);
    return 0;
  }
  if (command === undefined) {
    environment.stderr(await help());
    return 2;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    environment.stdout(await help());
    return 0;
  }

  const json = argv.includes('--json');
  bindEnvironment(environment);
  try {
    await runCommand(commands, { rawArgs: [...argv] });
    return environment.exitCode;
  } catch (failure) {
    const error = failure instanceof SageError ? failure : toSageError(failure, `sage ${command}`);
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
  if (failure instanceof SageError && failure.code === 'CORE_INVALID_ARGUMENT') {
    return 2;
  }
  return 1;
}
