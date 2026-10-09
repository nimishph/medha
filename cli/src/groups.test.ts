import { describe, expect, test } from 'bun:test';
import { runCli } from './cli.ts';
import { commands } from './commands.ts';
import { bindEnvironment, type Environment } from './environment.ts';
import { COMMAND_GROUPS, groupCommands, OTHER_GROUP_TITLE } from './groups.ts';

function capture(
  stdoutIsTTY = false,
  isTTY = stdoutIsTTY,
): { env: Environment; out: () => string } {
  let out = '';
  const env: Environment = {
    cwd: process.cwd(),
    env: {},
    now: () => 0,
    isTTY,
    stdoutIsTTY,
    exitCode: 0,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      void text;
    },
  };
  bindEnvironment(env);
  return { env, out: () => out };
}

describe('medha --help groups', () => {
  test('every registered command has a home in a group', () => {
    const registered = Object.keys(commands.subCommands as Record<string, unknown>);
    const sections = groupCommands(Object.fromEntries(registered.map((name) => [name, name])));
    const other = sections.find((section) => section.title === OTHER_GROUP_TITLE);
    expect(other?.entries.map((entry) => entry.name) ?? []).toEqual([]);
  });

  test('no command is listed in two groups', () => {
    const names = COMMAND_GROUPS.flatMap((group) => group.commands);
    expect(new Set(names).size).toBe(names.length);
  });

  test('ungrouped commands are still shown, under Other, in registration order', () => {
    const sections = groupCommands({ init: 1, zebra: 2, apple: 3 });
    expect(sections.map((s) => s.title)).toEqual(['Get started', OTHER_GROUP_TITLE]);
    expect(sections[1]?.entries.map((e) => e.name)).toEqual(['zebra', 'apple']);
  });

  test('help prints sections, in order, with every command and a description', async () => {
    const { env, out } = capture();
    expect(await runCli(['--help'], env)).toBe(0);
    const text = out();
    const headings = COMMAND_GROUPS.map((g) => g.title.toUpperCase());
    const positions = headings.map((h) => text.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const name of Object.keys(commands.subCommands as Record<string, unknown>)) {
      expect(text).toMatch(new RegExp(`^  ${name}\\s{2,}\\S`, 'm'));
    }
    expect(text).toContain('medha <command> --help');
    expect(text).not.toContain('\u001b[');
  });

  test('styling is only added on a terminal', async () => {
    const { env, out } = capture(true);
    expect(await runCli(['help'], env)).toBe(0);
    expect(out()).toContain('\u001b[1mRECORD EVIDENCE');
  });

  test('help piped while stderr is a terminal stays plain: styling follows stdout', async () => {
    const { env, out } = capture(false, true);
    expect(await runCli(['--help'], env)).toBe(0);
    expect(out()).toContain('RECORD EVIDENCE');
    expect(out()).not.toContain('\u001b[');
  });

  test('a command help still renders that command alone', async () => {
    const { env, out } = capture();
    expect(await runCli(['record', '--help'], env)).toBe(0);
    expect(out()).toContain('--signal');
    expect(out()).not.toContain('GET STARTED');
  });
});
