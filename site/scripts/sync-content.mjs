/**
 * Copies the two markdown files that already ship publicly (README.md, SKILL.md) into the site as
 * pages, so the site never becomes a second, drifting copy of them.
 *
 * Both are already public: README.md is the GitHub landing page and SKILL.md is in the npm tarball
 * (see .github/workflows/release.yml). Nothing here widens the published surface.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
// Emitted at the site root so the filename is the public URL (/overview, /agent-skill). A `generated/`
// subdirectory would publish /generated/overview and leak the build layout into the site's links.
const out = new URL('../', import.meta.url);

/** Rewrite repo-relative markdown links to site routes (VitePress runs with cleanUrls). */
function rewriteLinks(markdown) {
  return markdown
    .replace(/\]\(SKILL\.md\)/g, '](/agent-skill)')
    .replace(/\]\(README\.md\)/g, '](/overview)');
}

/** Swap the file's own YAML block for VitePress frontmatter, preserving its data keys. */
function frontmatter({ title, description, body }) {
  const own = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  // The file's own top-level keys are carried through at indent 0, after a blank line so they
  // close the nested `headmatter` list rather than being read as part of it.
  const carried = own === null
    ? []
    : own[1]
        .split(/\r?\n/)
        .filter((line) => /^[A-Za-z_][\w-]*:/.test(line))
        .filter((line) => !/^(title|description|headmatter|outline|editLink):/.test(line));
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    'headmatter:',
    '  - - meta',
    `    - content: ${JSON.stringify(description)}`,
    'outline: [2, 3]',
    'editLink: false',
    // A blank line closes the nested `headmatter` list before the file's own top-level keys.
    ...(carried.length === 0 ? [] : ['', ...carried]),
    '---',
    '',
    body.replace(own?.[0] ?? '', '').trim(),
    '',
  ].join('\n');
}

const readme = await readFile(new URL('README.md', root), 'utf8');
await mkdir(out, { recursive: true });
await writeFile(
  new URL('overview.md', out),
  frontmatter({
    title: 'medha',
    description:
      'Evidential memory for the rules, recipes and tools your agents rely on: records what happened, returns trust hints, and never decides for you.',
    body: rewriteLinks(readme),
  }),
  'utf8',
);

const skill = await readFile(new URL('SKILL.md', root), 'utf8');
await writeFile(
  new URL('agent-skill.md', out),
  frontmatter({
    title: 'Agent skill (SKILL.md)',
    description:
      'The skill file to drop into .claude/skills/medha/ so an agent knows when and how to use medha.',
    body: rewriteLinks(skill),
  }),
  'utf8',
);

console.log(`wrote ${fileURLToPath(new URL('overview.md', out))}`);
console.log(`wrote ${fileURLToPath(new URL('agent-skill.md', out))}`);
