import { InvalidArgumentError } from '@cntxt-labs/medha-core';

/**
 * What the `medha` CLI reads from and writes to, so it can be driven by a test as well as a
 * terminal. Time is never read ambiently — the clock arrives here, keeping a bootstrap run
 * deterministic for a fixed `now`.
 */

export interface Environment {
  /** The directory `--dir` falls back to — the project root the engine home lives under. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The clock the whole bootstrap uses. Replaced by tests to pin a fixed epoch. */
  readonly now: () => number;
  /** Whether stderr is an interactive terminal (reserved for progress rendering). */
  readonly isTTY?: boolean;
  /** The exit code the process should leave behind; commands raise it to fail. */
  exitCode: number;
  stdout(text: string): void;
  stderr(text: string): void;
}

let active: Environment | undefined;

/**
 * The environment of the run in flight. citty's subcommand dispatch does not forward `runCommand`'s
 * `data` (0.2.x), so `runCli` binds the current environment here before dispatching — the analogue
 * of `runMain`'s process-global model, but injectable.
 */
export function bindEnvironment(environment: Environment): void {
  active = environment;
}

export function currentEnvironment(): Environment {
  if (active === undefined) {
    throw new InvalidArgumentError(
      'environment',
      'a bound CLI environment (runCli binds one before dispatch)',
      active,
    );
  }
  return active;
}

export function processEnvironment(): Environment {
  return {
    cwd: process.cwd(),
    env: process.env,
    now: () => Date.now(),
    isTTY: process.stderr.isTTY === true,
    exitCode: 0,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}
