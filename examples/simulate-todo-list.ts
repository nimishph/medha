/**
 * Medha on todo-list — evidence log + weight simulations.
 *
 * Re-derives the entity set from the real repo (one entity per source file, evidence from git
 * commit counts) and then shows:
 *  1. the actual episodes the write plane appended (the log IS the source of truth),
 *  2. rebuild-from-log == live index determinism,
 *  3. a pure sequential simulation of ADDITIONAL ADOPTED signals on the least-known entity
 *     (src/priority.ts): the EMA weight (mu) climbs toward the signal value and the status
 *     crosses probation -> active,
 *  4. one-shot what-ifs: another ADOPTED, a REJECT_RULE, on that same live state (nothing
 *     persisted).
 *
 * Run: bun run examples/simulate-todo-list.ts
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { MemoryStore } = await import('../medha-store/src/memory-store.ts');
const { Medha } = await import('../medha/src/engine.ts');
const { buildHint, entityKeyString, foldEpisode, freshState } = await import('../medha-core/src/index.ts');

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
      else if (EXTS.has(entry.slice(entry.lastIndexOf('.')))) files.push(full);
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

const relPath = (p: string) => p.replace(`${REPO}/`, '').replaceAll('\\', '/');

const store = new MemoryStore({ registries: { kinds: ['file'], signalSpecs: [ADOPTED], anchorKinds: ['week'] } });
const medha = new Medha({ store });

let tick = 0;
const at = () => T0 + tick++;
const keyOf = (p: string) => ({ namespace: 'fs', kind: 'file', id: relPath(p) });
const files = sourceFiles();

const seedLog: unknown[] = [];
for (const file of files) {
  const k = keyOf(file);
  const created = await medha.record(k, 'SKIP', { now: at() }, { ensure: true, note: 'materialised from repo scan' });
  seedLog.push(created);
  for (let i = 0; i < commitsTouching(file); i++) await medha.record(k, 'ADOPTED', { now: at() });
}

console.log('━━━ 1. what the write plane appended (episode log, source of truth) ━━━');
const episodes = await store.episodes();
console.log(`${episodes.length} episodes for ${files.length} entities.\n`);
const show = (ep: any) => ({
  type: ep.type,
  key: entityKeyString(ep.key),
  at: ep.at - T0,
  spec: ep.spec.name,
  weight: ep.spec.name === 'SKIP' ? undefined : ep.weight,
  updater: ep.updater,
  ensure: ep.ensure,
  note: ep.note,
});
console.log('first 3 episodes (the SKIP materialisations):');
for (const ep of episodes.slice(0, 3)) console.log(`  ${JSON.stringify(show(ep))}`);
console.log('\nthe last ADOPTED episodes on src/todo.ts (weight = EMA mu after the fold):');
for (const ep of episodes.filter((e) => e.spec.name === 'ADOPTED' && e.key.id.endsWith('todo.ts')))
  console.log(`  ${JSON.stringify(show(ep))}`);

console.log('\n━━━ 2. rebuild-from-log equals the live index (deterministic ─ log is truth) ━━━');
const rebuilt = await store.rebuild();
const listed = await store.list();
console.log(
  `rebuild(${rebuilt.length}) === list(${listed.length}): ${JSON.stringify(rebuilt) === JSON.stringify(listed) ? 'BYTE-IDENTICAL' : 'DIFFER'}`,
);

console.log('\n━━━ 3. pure sequential simulation: more ADOPTED signals on src/priority.ts (least-known) ━━━');
const target = keyOf(files.find((p) => p.endsWith('priority.ts') && !p.endsWith('priority.test.ts'))!);
const live = (await store.get(target))!;
console.log(`live state before simulation: mu=${live.ema.mu.toFixed(4)}  n=${live.evidence.n}  status=${
  buildHint(live, at()).status
}`);
let state = live;
console.log('  step | signal   | mu        trust     status');
console.log(`  seed | —        | ${state.ema.mu.toFixed(4)}  ${buildHint(state, at()).trustScore.toFixed(4)}  ${buildHint(state, at()).status}`);
let simSeq = 0;
while (buildHint(state, at()).status === 'probation') {
  state = foldEpisode(state, {
    type: 'signal',
    seq: 900 + simSeq++,
    key: state.key,
    at: at(),
    spec: ADOPTED,
    ensure: false,
  })!;
  const h = buildHint(state, at());
  console.log(`  ${(simSeq + 1).toString().padStart(4)} | ADOPTED | ${h.temporal.emaWeight.toFixed(4)}  ${h.trustScore.toFixed(4)}  ${h.status}`);
}
console.log(`mu climbs from the prior (${ADOPTED.value < live.ema.mu ? 'above' : 'below'}) toward the signal value (EMA α=0.1); status flips to ${buildHint(state, at()).status} once the Wilson lower bound × guard factor clears 0.25.`);

console.log('\n━━━ 4. one-shot what-ifs on the SAME live state (pure, nothing written) ━━━');
const reveal = (label: string, hint: any) =>
  console.log(`  ${label.padEnd(26)} trust ${hint.before.trustScore.toFixed(4)} → ${hint.after.trustScore.toFixed(4)}  mu ${hint.before.temporal.emaWeight.toFixed(4)} → ${hint.after.temporal.emaWeight.toFixed(4)}  ${hint.before.status} → ${hint.after.status}${hint.statusChanged ? '  (STATUS CHANGED)' : ''}`);
reveal('one more ADOPTED', await medha.simulate(target, 'ADOPTED', { now: at() }));
reveal('one REJECT_RULE', await medha.simulate(target, 'REJECT_RULE', { now: at() }));
const beforeGuard = buildHint((await store.get(target))!, at());
const afterGuard = await medha.reportGuard(target, { ok: true, kind: 'harness' }, { now: at() });
console.log(
  `  guard report OK (persisted)     trust ${beforeGuard.trustScore.toFixed(4)} → ${afterGuard.trustScore.toFixed(4)}  mu unchanged by guards  ${beforeGuard.status} → ${afterGuard.status}  (host runs guard, Medha only stores the result)`,
);
console.log('\nfinal index:', (await medha.list({}, { now: at() }, { limit: 3 })).items
  .map((h) => `${h.status}/${h.trustScore.toFixed(3)}/${h.key.id.split('/').pop()}`)
  .join('  '));