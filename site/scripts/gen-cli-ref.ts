/**
 * Generates `site/generated/cli.md` from the live citty command tree in `cli/src/commands.ts`.
 *
 * Why generate instead of hand-writing: the command surface is the thing most likely to drift, and a
 * stale CLI reference is worse than none. `medha --help` already renders this same tree, so the docs
 * and the binary cannot disagree.
 *
 * Run with bun (`bun run scripts/gen-cli-ref.ts`) — it needs to import TypeScript sources that
 * resolve through the workspace, which node cannot do here. The rendering logic is deliberately
 * separated from that import (see `renderCommandTree`) so it can be exercised against a stub tree
 * without the workspace installed.
 */
import { mkdir, writeFile } from 'node:fs/promises';

interface ArgDef {
  type?: string;
  description?: string;
  default?: unknown;
  options?: readonly (string | number)[];
  required?: boolean;
  alias?: string | readonly string[];
  hidden?: boolean;
  valueHint?: string;
}

interface CommandNode {
  meta?: {
    name?: string;
    description?: string;
    version?: string;
    hidden?: boolean;
  };
  args?: Record<string, ArgDef> | (() => Promise<Record<string, ArgDef>>);
  subCommands?: Record<string, CommandNode> | (() => Promise<Record<string, CommandNode>>);
}

/**
 * Commands excluded from the published reference.
 *
 * `define` and `decision` ship in the binary and their help text is reachable by anyone who installs
 * it, but the decision-tree design behind them is deliberately undocumented. Keep them out until
 * that changes; move a name here-to-there (i.e. into the published set) to document it.
 */
const UNPUBLISHED = new Set<string>(['define', 'decision']);

function isHidden(node: CommandNode): boolean {
  return node.meta?.hidden === true;
}

function resolveArgs(node: CommandNode): Promise<Record<string, ArgDef>> {
  const args = node.args;
  if (args === undefined) return Promise.resolve({});
  return Promise.resolve(typeof args === 'function' ? args() : args);
}

function resolveSubCommands(node: CommandNode): Promise<Record<string, CommandNode>> {
  const subs = node.subCommands;
  if (subs === undefined) return Promise.resolve({});
  return Promise.resolve(typeof subs === 'function' ? subs() : subs);
}

function escapePipes(text: string): string {
  return escapeAngles(text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
}

/**
 * VitePress compiles each page as a Vue template, so a bare `<dir>` in a table cell is read as an
 * unclosed element and fails the build. Placeholders are text, so write them as entities.
 */
function escapeAngles(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render one argument as the form a user would actually type. */
function renderFlag(name: string, arg: ArgDef): string {
  // A positional takes no flag at all: `medha maintain backup <path>`.
  if (arg.type === 'positional') return `\`${name}\``;

  const aliases = typeof arg.alias === 'string' ? [arg.alias] : (arg.alias ?? []);
  const short = aliases.filter((a) => a.length === 1);
  const label = short.length > 0 ? `\`-${short[0]}\`, \`--${name}\`` : `\`--${name}\``;

  if (arg.type === 'boolean') {
    // citty maps `--no-x` onto the same key as `--x`, so a boolean defaulting true is negated on
    // the command line rather than passed.
    return arg.default === true ? `\`--no-${name}\`` : label;
  }

  // citty renders the placeholder as the arg name, and the enum's options for an enum
  // (`--dir=<dir>`, `--store=<sqlite|file|memory>`); mirror that so the table matches `--help`.
  const hint = arg.type === 'enum' && arg.options ? arg.options.join('\\|') : name;
  return `${label} ${escapeAngles(`<${hint}>`)}`;
}

function renderDefault(arg: ArgDef): string {
  if (arg.default === undefined) return '';
  if (typeof arg.default === 'boolean') return arg.default ? 'on' : 'off';
  if (arg.type === 'enum' && Array.isArray(arg.options)) {
    return `\`${String(arg.default)}\``;
  }
  return `\`${String(arg.default)}\``;
}

interface CommandGroup {
  readonly title: string;
  readonly commands: readonly string[];
}

async function renderCommand(
  node: CommandNode,
  path: string[],
  depth: number,
  groups?: readonly CommandGroup[],
): Promise<string[]> {
  const lines: string[] = [];
  const heading = '#'.repeat(Math.min(depth + 2, 6));
  lines.push(`${heading} \`${path.join(' ')}\``);
  lines.push('');
  if (node.meta?.description !== undefined) {
    lines.push(escapePipes(node.meta.description));
    lines.push('');
  }

  const args = await resolveArgs(node);
  const visible = Object.entries(args).filter(([, arg]) => arg.hidden !== true);
  if (visible.length > 0) {
    lines.push('| Flag | Type | Default | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const [name, arg] of visible) {
      const type =
        arg.type === 'enum' ? `enum${arg.options ? ` \\| ${arg.options.join(' \\| ')}` : ''}` : (arg.type ?? 'string');
      const req = arg.required === true ? ' (required)' : '';
      const desc = arg.description === undefined ? '' : escapePipes(arg.description);
      lines.push(`| ${renderFlag(name, arg)} | ${type} | ${renderDefault(arg) || '—'} | ${desc}${req} |`);
    }
    lines.push('');
  }

  const subs = await resolveSubCommands(node);
  const visibleSubs = Object.entries(subs).filter(
    ([name, child]) => !isHidden(child) && !(depth === 0 && UNPUBLISHED.has(name)),
  );

  if (depth === 0 && groups !== undefined) {
    // Top-level commands under a heading per group, the same sections `medha --help` prints.
    const byName = new Map(visibleSubs);
    const placed = new Set<string>();
    const sections: { title: string; names: string[] }[] = groups.map((group) => ({
      title: group.title,
      names: group.commands.filter((name) => byName.has(name)),
    }));
    for (const section of sections) for (const name of section.names) placed.add(name);
    const rest = visibleSubs.map(([name]) => name).filter((name) => !placed.has(name));
    if (rest.length > 0) sections.push({ title: 'Other', names: rest });
    for (const section of sections) {
      if (section.names.length === 0) continue;
      lines.push(`### ${section.title}`, '');
      for (const name of section.names) {
        const child = byName.get(name) as CommandNode;
        lines.push(...(await renderCommand(child, [...path, name], 2)));
      }
    }
    return lines;
  }

  for (const [name, child] of visibleSubs) {
    lines.push(...(await renderCommand(child, [...path, name], depth + 1)));
  }

  return lines;
}

/** Render the whole tree as a markdown page body. Exported for testing against a stub tree. */
export async function renderCommandTree(
  root: CommandNode,
  groups?: readonly CommandGroup[],
): Promise<string> {
  const name = root.meta?.name ?? 'medha';
  const version = root.meta?.version;
  const lines: string[] = [
    '<!-- Generated by site/scripts/gen-cli-ref.ts from cli/src/commands.ts. Do not edit. -->',
    '',
    `# ${name} command reference`,
    '',
    version === undefined
      ? 'Every command accepts `--json` for machine-readable output.'
      : `Every command accepts \`--json\` for machine-readable output. Generated against v${version}.`,
    '',
    '> This page is generated from the same command tree the binary dispatches on, so it cannot',
    '> drift from `medha --help`. For the reasoning behind each number, see',
    '> [How trust works](/guide/trust).',
    '',
  ];
  lines.push(...(await renderCommand(root, [name], 0, groups)));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const OUTPUT = new URL('../cli.md', import.meta.url);

if (import.meta.main === true) {
  // Imported dynamically so this module can be imported (and its rendering exercised) without the
  // workspace installed. bun is required: the tree is TypeScript that resolves through workspace
  // path aliases, which node cannot load.
  const { commands } = await import('../../cli/src/commands.ts');
  const { COMMAND_GROUPS } = await import('../../cli/src/groups.ts');
  const markdown = await renderCommandTree(commands as unknown as CommandNode, COMMAND_GROUPS);
  await mkdir(new URL('./', OUTPUT), { recursive: true });
  await writeFile(OUTPUT, markdown, 'utf8');
  console.log(`wrote ${OUTPUT.pathname}`);
}
