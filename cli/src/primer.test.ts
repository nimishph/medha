/**
 * Unit tests and anti-drift validation for the Medha Primer (§14.4, medha-168.2).
 */

import { describe, expect, it } from 'bun:test';
import type { ArgsDef, CommandDef } from 'citty';
import { commands } from './commands.ts';
import { getPrimer, PRIMER_TOPIC_NAMES, PRIMER_TOPICS, renderPrimer } from './primer.ts';

describe('medha primer CLI & MCP Tool', () => {
  it('returns index when called with no topic or index/help', () => {
    const index = getPrimer();
    expect(index.topic).toBe('index');
    expect(index.title).toContain('Available Topics');
    expect(index.availableTopics.length).toBe(PRIMER_TOPIC_NAMES.length);
    expect(index.content).toContain('medha primer <topic>');

    const fromEmpty = getPrimer('');
    expect(fromEmpty.topic).toBe('index');

    const fromHelp = getPrimer('help');
    expect(fromHelp.topic).toBe('index');
  });

  it('retrieves every canonical topic with strict token-frugal bounds', () => {
    for (const topicName of PRIMER_TOPIC_NAMES) {
      const topic = getPrimer(topicName);
      expect(topic.topic).toBe(topicName);
      expect(topic.title.length).toBeGreaterThan(5);
      expect(topic.description.length).toBeGreaterThan(10);
      expect(topic.content).toContain('# ');

      // Token frugality constraint: max 65 lines per topic
      expect(topic.lineCount).toBeLessThanOrEqual(65);
    }
  });

  it('throws informative error for unknown topic naming valid topics', () => {
    expect(() => getPrimer('nonexistent-topic')).toThrow(
      "Invalid topic: expected one of 'overview'",
    );
  });

  it('renders with and without compact mode', () => {
    const topic = getPrimer('signals');
    const normal = renderPrimer(topic, false);
    expect(normal).toContain('*Medha Primer (signals)');

    const compact = renderPrimer(topic, true);
    expect(compact).not.toContain('*Medha Primer');
    expect(compact).toBe(topic.content);
  });

  it('guarantees zero-drift: every `medha …` example parses against the real command', async () => {
    const examples = new Set<string>();
    for (const topic of Object.values(PRIMER_TOPICS)) {
      for (const line of topic.content.split('\n')) {
        const block = /^\s*(medha .*?)(?:\s+#.*)?$/.exec(line);
        if (block?.[1]) examples.add(block[1]);
      }
      for (const span of topic.content.matchAll(/`(medha [^`]*)`/g)) {
        if (span[1]) examples.add(span[1]);
      }
    }
    expect(examples.size).toBeGreaterThan(10);
    const problems = (
      await Promise.all([...examples].map(async (ex) => checkExample(ex).then((p) => p ?? '')))
    ).filter((p) => p !== '');
    expect(problems).toEqual([]);
  });

  it('guarantees zero-drift: all core CLI subcommands are documented in primer topics', () => {
    const registeredSubcommands = Object.keys(commands.subCommands ?? {});
    expect(registeredSubcommands).toContain('primer');

    // Aggregate all primer content
    const allPrimerText = Object.values(PRIMER_TOPICS)
      .map((t) => t.content)
      .join('\n');

    // Key commands every agent must be able to discover
    const essentialCommands = [
      'init',
      'show',
      'record',
      'guard',
      'propose',
      'define',
      'drift',
      'pack',
      'sync',
      'ui',
      'issue',
      'primer',
    ];

    for (const cmd of essentialCommands) {
      expect(allPrimerText).toContain(`medha ${cmd}`);
    }
  });

  it('guarantees math consistency: primer text matches engine constants', () => {
    const guardsTopic = getPrimer('guards');
    expect(guardsTopic.content).toContain('0.85'); // Unguarded ceiling

    const driftTopic = getPrimer('drift');
    expect(driftTopic.content).toContain('1.959964'); // Wilson 95% Z

    const configTopic = getPrimer('config');
    expect(configTopic.content).toContain('sqlite');
    expect(configTopic.content).toContain('file');
    expect(configTopic.content).toContain('memory');
  });
});

type Resolvable<T> = T | (() => T | Promise<T>) | Promise<T>;
const resolve = async <T>(value: Resolvable<T> | undefined): Promise<T | undefined> =>
  typeof value === 'function' ? (value as () => T | Promise<T>)() : value;

/** Split an example like a shell would, closely enough for documentation. */
function words(example: string): string[] {
  // An optional flag written as `[--kind <kind>]` is checked as the flag it names.
  const flat = example.replace(/\[(--[^\]]*)\]/g, '$1');
  return [...flat.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0]);
}

/** Why `example` would not parse as written, or undefined when it does. */
async function checkExample(example: string): Promise<string | undefined> {
  const tokens = words(example).slice(1);
  let command: CommandDef = commands;
  let path = 'medha';
  for (;;) {
    const subs = (await resolve(command.subCommands)) as
      | Record<string, Resolvable<CommandDef>>
      | undefined;
    const head = tokens[0];
    if (subs === undefined || head === undefined) break;
    const choice = head.split('|').find((name) => name in subs);
    if (choice === undefined) {
      if (
        /^[a-z][a-z-]*$/.test(head) &&
        !Object.values((await resolve(command.args)) ?? {}).some((a) => a.type === 'positional')
      ) {
        return `${example}: '${head}' is not a subcommand of ${path}`;
      }
      break;
    }
    command = (await resolve(subs[choice])) as CommandDef;
    path += ` ${choice}`;
    tokens.shift();
  }
  const args = ((await resolve(command.args)) ?? {}) as ArgsDef;
  const known = new Map<string, ArgsDef[string]>();
  for (const [name, def] of Object.entries(args)) {
    known.set(name, def);
    const alias = (def as { alias?: string | string[] }).alias;
    for (const a of alias === undefined ? [] : [alias].flat()) known.set(a, def);
  }
  const positionals = Object.values(args).filter((a) => a.type === 'positional').length;
  let seen = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token.startsWith('--')) {
      for (const flag of token.split('|')) {
        const name = flag.replace(/^--/, '').replace(/=.*$/, '');
        const def = known.get(name) ?? known.get(name.replace(/^no-/, ''));
        if (def === undefined || def.type === 'positional') {
          return `${example}: ${path} has no --${name}`;
        }
        if (def.type !== 'boolean' && !flag.includes('=')) i += 1;
      }
      continue;
    }
    seen += 1;
    if (seen > positionals)
      return `${example}: ${path} takes ${positionals} positional(s), got '${token}'`;
  }
  return undefined;
}
