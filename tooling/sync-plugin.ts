/**
 * Keeps the Claude Code plugin in `plugin/` in step with its canonical sources, so the plugin can
 * never ship a stale server pin or a diverging copy of the skill.
 *
 * Generated (do not hand-edit):
 * - `plugin/.mcp.json`                    <- the registry's claude-code client, npx launcher,
 *                                            so the bundled server pin tracks the CLI version;
 * - `plugin/skills/agent/SKILL.md`        <- the root SKILL.md, frontmatter renamed for the
 *                                            plugin prefix (`/medha:agent`);
 * - `plugin/.claude-plugin/plugin.json`   <- only its `version` field; name, description and
 *                                            author stay hand-written and are preserved.
 *
 * Hand-written and never touched here: `plugin/commands/*.md`. Distribution happens through the
 * `nimishph/cntxt-labs` marketplace (and the local `cntxt-labs-dev` workspace marketplace), so the
 * repo root hosts no `.claude-plugin/` of its own.
 * `plugin/` is excluded from biome (like `site/`) because these are shipped bytes: formatting them
 * here and there would make the two disagree forever.
 *
 * Usage: `bun run plugin:sync` writes; `bun run plugin:check` exits 1 naming stale files.
 * `tooling/plugin.test.ts` calls `buildPluginFiles` directly, so `bun test` fails on drift too.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Repo-relative path -> exact file content. Pure with respect to the disk state of `plugin/`. */
export async function buildPluginFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  // The bundle's MCP server: claude-code project scope, npx launcher, current version.
  const { loadRegistry } = await import('../cli/src/integrations/registry.ts');
  const { runMcpConfigSnippet } = await import('../cli/src/integrations/mcp-config.ts');
  const snippet = runMcpConfigSnippet(loadRegistry(), 'claude-code', { launcherId: 'npx' });
  files.set('plugin/.mcp.json', snippet.text);

  // The agent skill: root SKILL.md body verbatim, `name` pointed at the plugin-prefixed segment.
  const skill = await readFile(`${root}SKILL.md`, 'utf8');
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const description = frontmatter?.[1]
    ?.split(/\r?\n/)
    .find((line) => line.startsWith('description:'));
  if (frontmatter === null || description === undefined) {
    process.stderr.write('SKILL.md must keep a frontmatter block with a description\n');
    process.exit(1);
  }
  const body = skill.slice(frontmatter[0].length);
  files.set('plugin/skills/agent/SKILL.md', `---\nname: agent\n${description}\n---\n${body}`);

  // The manifest keeps its hand-written fields; only the version tracks the CLI package.
  const manifestPath = `${root}plugin/.claude-plugin/plugin.json`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const cliPackage = JSON.parse(await readFile(`${root}cli/package.json`, 'utf8')) as {
    version: string;
  };
  manifest.version = cliPackage.version;
  files.set('plugin/.claude-plugin/plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);

  return files;
}

if (import.meta.main === true) {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const [path, content] of await buildPluginFiles()) {
    let onDisk: string | undefined;
    try {
      onDisk = await readFile(root + path, 'utf8');
    } catch {
      onDisk = undefined;
    }
    if (onDisk === content) continue;
    if (check) {
      stale.push(path);
      continue;
    }
    await mkdir(dirname(root + path), { recursive: true });
    await writeFile(root + path, content, 'utf8');
    process.stdout.write(`wrote ${path}\n`);
  }
  if (stale.length > 0) {
    process.stderr.write(`stale (run \`bun run plugin:sync\`): ${stale.join(', ')}\n`);
    process.exitCode = 1;
  } else if (check) {
    process.stdout.write('plugin files are fresh\n');
  }
}
