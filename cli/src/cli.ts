import { MedhaError, toMedhaError } from '@cntxt-labs/medha-core';
import { type CommandDef, renderUsage, runCommand } from 'citty';
import { commands } from './commands.ts';
import { bindEnvironment, type Environment } from './environment.ts';
import { CliUsageError, isCliUsageFailure } from './errors.ts';
import { groupCommands } from './groups.ts';
import { toJson } from './render.ts';
import { VERSION } from './version.ts';

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === 'function' ? await (value as () => T | Promise<T>)() : await value;
}

const helpCache = new Map<boolean, string>();

/**
 * The top-level help: commands in sections (see `groups.ts`) instead of one flat list. Every
 * subcommand still gets a one-line description; `medha <command> --help` is unchanged and still
 * rendered by citty.
 */
async function help(styled: boolean): Promise<string> {
  const cached = helpCache.get(styled);
  if (cached !== undefined) return cached;

  const bold = (text: string): string => (styled ? `\u001b[1m${text}\u001b[22m` : text);
  const dim = (text: string): string => (styled ? `\u001b[2m${text}\u001b[22m` : text);

  const meta = (await resolve(commands.meta)) as { description?: string } | undefined;
  const subs = ((await resolve(commands.subCommands)) ?? {}) as Record<
    string,
    Resolvable<CommandDef>
  >;
  const described: Record<string, string> = {};
  for (const [name, node] of Object.entries(subs)) {
    const def = await resolve(node);
    const nodeMeta = (await resolve(def.meta)) as
      | { description?: string; hidden?: boolean }
      | undefined;
    if (nodeMeta?.hidden === true) continue;
    described[name] = nodeMeta?.description ?? '';
  }

  const width = Math.max(...Object.keys(described).map((name) => name.length));
  const lines = [`${meta?.description ?? ''} ${dim(`(medha v${VERSION})`)}`.trim(), ''];
  lines.push(`${bold('USAGE')}  medha <command> [OPTIONS]`, '');
  for (const section of groupCommands(described)) {
    lines.push(bold(section.title.toUpperCase()));
    for (const { name, value } of section.entries) {
      lines.push(`  ${name.padEnd(width)}  ${value}`);
    }
    lines.push('');
  }
  lines.push(`Use ${bold('medha <command> --help')} for more information about a command.`, '');

  const text = lines.join('\n');
  helpCache.set(styled, text);
  return text;
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
    environment.stderr(await help(environment.isTTY === true));
    return 2;
  }
  if (command === 'help') {
    const subArgs = argv.slice(1);
    if (subArgs.length === 0) {
      environment.stdout(await help(environment.stdoutIsTTY === true));
      return 0;
    }
    const { cmd, parent } = await resolveUsageTarget(subArgs);
    environment.stdout(await renderUsage(cmd, parent));
    return 0;
  }
  if (command === '--help' || command === '-h') {
    environment.stdout(await help(environment.stdoutIsTTY === true));
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
    /*
     * citty rejects the command line before any of our runners are reached (unknown command, or a
     * subcommand left off) and throws its own `CLIError`. That is not a `MedhaError`, so it used
     * to be wrapped as CORE_UNEXPECTED_FAILURE: a plain typo reported as an internal crash. Keep
     * citty's own message, which names the offending token, and label it as the usage error it is.
     */
    const error = isCliUsageFailure(failure)
      ? new CliUsageError(failure.message, {
          ...(failure.message === 'No command specified.'
            ? { hint: `medha help ${command} lists the subcommands.` }
            : {}),
        })
      : failure instanceof MedhaError
        ? failure
        : toMedhaError(failure, `medha ${command}`);
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
  if (isCliUsageFailure(failure)) {
    return 2;
  }
  if (failure instanceof MedhaError && failure.code === 'CORE_INVALID_ARGUMENT') {
    return 2;
  }
  return 1;
}
