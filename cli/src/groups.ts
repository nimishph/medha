/**
 * How `medha --help` (and the generated CLI reference) groups the top-level commands.
 *
 * The flat list had grown to two dozen entries with no hint of which to reach for first. Groups are
 * ordered the way someone meets the tool: set up, record evidence, look at the result, hand it to
 * an agent, view it, keep it healthy. The Rust binary's `--help` carries the same sections
 * (`crates/medha-cli/src/args.rs`); a test on each side keeps the two lists honest.
 *
 * A command that is registered but missing here still shows up, under "Other", so a new command is
 * never silently hidden from help; `groups.test.ts` fails instead so it gets a proper home.
 */

export interface CommandGroup {
  readonly title: string;
  readonly commands: readonly string[];
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  { title: 'Get started', commands: ['init', 'primer', 'params'] },
  {
    title: 'Record evidence',
    commands: [
      'propose',
      'record',
      'guard',
      'define',
      'decision',
      'retract',
      'remove-episode',
      'override',
    ],
  },
  {
    title: 'Look things up',
    commands: ['list', 'show', 'status', 'drift', 'hints', 'explain-threshold', 'simulate'],
  },
  { title: 'Feed an agent', commands: ['pack', 'mcp'] },
  { title: 'Dashboard and reports', commands: ['ui', 'report'] },
  {
    title: 'Maintain and share',
    commands: ['maintain', 'sweep', 'compact', 'preflight', 'updater', 'sync', 'issue'],
  },
];

export const OTHER_GROUP_TITLE = 'Other';

export interface GroupedEntry<T> {
  readonly name: string;
  readonly value: T;
}

export interface GroupedSection<T> {
  readonly title: string;
  readonly entries: readonly GroupedEntry<T>[];
}

/**
 * Lay `available` out in the order of `COMMAND_GROUPS`. Names a group lists but the CLI does not
 * register (the Rust-only `hints`, say) are skipped; names registered but ungrouped land in a
 * trailing "Other" section. Empty sections are dropped.
 */
export function groupCommands<T>(
  available: Readonly<Record<string, T>>,
  groups: readonly CommandGroup[] = COMMAND_GROUPS,
): readonly GroupedSection<T>[] {
  const placed = new Set<string>();
  const sections: GroupedSection<T>[] = [];
  for (const group of groups) {
    const entries: GroupedEntry<T>[] = [];
    for (const name of group.commands) {
      if (Object.hasOwn(available, name)) {
        entries.push({ name, value: available[name] as T });
        placed.add(name);
      }
    }
    if (entries.length > 0) sections.push({ title: group.title, entries });
  }
  const rest = Object.keys(available)
    .filter((name) => !placed.has(name))
    .map((name) => ({ name, value: available[name] as T }));
  if (rest.length > 0) sections.push({ title: OTHER_GROUP_TITLE, entries: rest });
  return sections;
}
