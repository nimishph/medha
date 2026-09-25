/**
 * Smoke-drive the Medha engine against a real repo.
 *
 * This is NOT a miner: Loom-ujs3.9 owns propose/mine. Here evidence is seeded from real repo
 * facts — one entity per source file, APPLY count = commits that touched the file — so we can
 * exercise the read plane (§6.1), write plane (§6.2) and the exploration helper (§6.3) on a
 * directory-shaped entity set. Every call is deterministic under an injected {now, seed}.
 *
 * Run: bun run examples/try-todo-list.ts
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { MemoryStore } = await import('../medha-store/src/memory-store.ts');
const { Medha } = await import('../medha/src/engine.ts');

const REPO = 'E:/AI projects/todo-list';
const T0 = 1_700_000_000_000;
const ADOPTED = { name: 'ADOPTED', value: 0.6, countsAsTrial: true, countsAsSuccess: true };
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.json']);
const ROOT_FILES = ['package.json', 'vite.config.ts', 'tsconfig.json', 'index.html'];
const SKIP = ['.git', 'node_modules', 'dist', '.sutra', '.vscode', 'sutra-win32-x64', '.code-lens'];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (EXTS.has(join(entry).includes('.') ? entry.slice(entry.lastIndexOf('.')) : '')) files.push(full);
    }
  };
  walk(`${REPO}/src`);
  for (const file of ROOT_FILES) if (statSync(`${REPO}/${file}`).isFile()) files.push(`${REPO}/${file}`);
  return files;
}

function commitsTouching(path: string): number {
  try {
    const rel = path.replace(`${REPO}/`, '').replaceAll('\\', '/');
    const out = execFileSync('git', ['-C', REPO, 'log', '--oneline', '--', rel], { encoding: 'utf8' });
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return 0;
  }
}

function relPath(path: string): string {
  return path.replace(`${REPO}/`, '').replaceAll('\\', '/');
}

const store = new MemoryStore({ registries: { kinds: ['file'], signalSpecs: [ADOPTED], anchorKinds: ['week'] } });
const medha = new Medha({ store });

const files = sourceFiles();
console.log(`indexing ${files.length} source files from ${REPO}\n`);

let tick = 0;
const at = () => T0 + tick++;
const fileKey = (path: string) => ({ namespace: 'fs', kind: 'file', id: relPath(path) });
const keys = files.map(fileKey);

// Materialise every file at zero evidence... then APPLY once per commit that touched it. Precision is
// an honest smoke plot: heavily-edited modules get more history-derived evidence.
const applies = new Map<string, number>();
for (const file of files) {
  await medha.record(fileKey(file), 'SKIP', { now: at() }, { ensure: true });
  const count = commitsTouching(file);
  applies.set(relPath(file), count);
  for (let i = 0; i < count; i++) await medha.record(fileKey(file), 'ADOPTED', { now: at() });
}

const ctx = { now: at(), seed: 42 };

const hints = await medha.hints(keys, ctx);
console.log('read plane — batch hints:');
for (const [keyString, hint] of hints) {
  const id = keyString.split('\u0000').at(-1);
  console.log(
    `  ${hint.status.padEnd(9)} trust=${hint.trustScore.toFixed(3).padStart(6)}  n=${hint.evidence.totalTrials.toString().padStart(2)}  k=${hint.evidence.successes.toString().padStart(2)}  ${id}  (git commits: ${applies.get(id!) ?? 0})`,
  );
}

const candidates = await medha.explore(keys, { slots: 5, seed: 42 }, ctx);
console.log(`\nexploration helper — ${candidates.length} admitted (seed 42, slots 5):`);
for (const c of candidates) {
  console.log(`  ${c.hint.status.padEnd(9)} u=${c.uncertainty.toFixed(4)}  ${c.admittedBy.padEnd(9)}  ${c.key.id}`);
}
// determinism: same input + seed ⇒ same picks
const again = await medha.explore(keys, { slots: 5, seed: 42 }, ctx);
console.log(`  deterministic: ${JSON.stringify(again.map((c) => c.key.id)) === JSON.stringify(candidates.map((c) => c.key.id)) ? 'yes' : 'NO'}`);

const drift = await medha.drift(ctx, { limit: 3 });
console.log(`\ndrift report — ${drift.count} drifting, showing ${drift.limitApplied}:`);
for (const entry of drift.drifting) console.log(`  Δ=${entry.delta.toFixed(4)}  ${entry.hint.status}  ${entry.key.id}`);

const page = await medha.list({}, ctx, { limit: 5 });
console.log(`\nlist — top 5 by trust (${page.total} entities):`);
for (const hint of page.items) console.log(`  ${hint.trustScore.toFixed(3)}  ${hint.status.padEnd(9)}  ${hint.key.id}`);

const simTarget = [...hints.values()].find((h) => h.status === 'probation')!;
const sim = await medha.simulate(simTarget.key, 'ADOPTED', ctx);
console.log(`\nsimulate (pure, persists nothing) — one more ADOPTED on ${simTarget.key.id}:`);
console.log(`  trust ${sim.before.trustScore} → ${sim.after.trustScore}  (Δ=${sim.deltaTrust})  statusChanged=${sim.statusChanged}`);

const topId = [...hints.values()].sort((a, b) => b.trustScore - a.trustScore)[0].key;
const detail = await medha.show(topId, ctx, { recent: 3 });
console.log(`\nshow ${topId.id} — known=${detail.known}, recent ${detail.recentEpisodes.length} episode(s), provenance ${detail.provenance.length}`);
for (const e of detail.recentEpisodes) {
  console.log(`  #${e.seq} ${e.type} ${e.type === 'signal' ? e.spec.name : ''}${'weight' in e && e.weight !== undefined ? ` weight=${e.weight}` : ''}`);
}

const events = (await store.episodes()).length;
const states = (await store.list()).length;
console.log(`\nwrite plane — ${events} episodes appended (the log is the source of truth), ${states} entities in the index.`);