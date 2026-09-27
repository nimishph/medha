/**
 * Smoke-drive medha-arj (.1-.4) against a real repo, the same way try-todo-list.ts smoke-drives
 * the read/write planes: real file entities, real evidence from git history, real store I/O — not
 * just in-memory unit-test fixtures.
 *
 * Exercises:
 *  1. medha-arj.1 — `define` episodes + foldDefinitions, and that stripping them never changes
 *     the entity states a live store actually holds (fold-purity, against a populated store).
 *  2. medha-arj.2 — `decision` episodes + foldDecisionTree building a parent-linked forest with
 *     real, store-assigned seqs.
 *  3. medha-arj.3 — SignalEpisode.caseId: two real branches on the same file diverge in trust
 *     while the file's own aggregate keeps accruing every tagged signal too.
 *  4. medha-arj.4 — KindSpec.decisionPolicy.requireHumanFor rejects an agent-authored `apply`
 *     branch and accepts a human-authored one, enforced by the STORE's append() (not just the
 *     bare validateEpisodeInput call a unit test would use) — this is what caught the pre-existing
 *     bug where append()/replaceLog() ignored registered KindSpecs entirely (fixed alongside).
 *
 * Run: bun run examples/try-decision-tree.ts
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const {
  caseStatus,
  caseTrust,
  entityKeyString,
  foldDecisionTree,
  foldDefinitions,
  foldLog,
  newDecisionCaseId,
} = await import('../medha-core/src/index.ts');
const { MemoryStore } = await import('../medha-store/src/memory-store.ts');

const REPO = 'E:/AI projects/todo-list';
const T0 = 1_700_000_000_000;
const ADOPTED = { name: 'ADOPTED', value: 0.6, countsAsTrial: true, countsAsSuccess: true };
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.json']);
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
  return files;
}

function commitsTouching(path: string): number {
  try {
    const rel = path.replace(`${REPO}/`, '').replaceAll('\\', '/');
    const out = execFileSync('git', ['-C', REPO, 'log', '--oneline', '--', rel], {
      encoding: 'utf8',
    });
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return 0;
  }
}

const relPath = (p: string) => {
  const normalized = p.replaceAll('\\', '/');
  const prefix = `${REPO.replaceAll('\\', '/')}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
};

const store = new MemoryStore({
  registries: {
    kinds: [],
    kindSpecs: [{ name: 'file', decisionPolicy: { requireHumanFor: 'apply' } }],
    signalSpecs: [ADOPTED],
    anchorKinds: ['week'],
  },
});
const openResult = await store.open();
console.log(`store opened: ${openResult.status}`);

const files = sourceFiles();
const withCounts = files.map((f) => ({ path: f, id: relPath(f), commits: commitsTouching(f) }));
withCounts.sort((a, b) => b.commits - a.commits);
console.log(`\nindexed ${files.length} source files from ${REPO}`);

let tick = 0;
const at = () => T0 + tick++;
const fileKey = (id: string) => ({ namespace: 'fs', kind: 'file', id });

// --- Seed evidence from real repo facts, same as try-todo-list.ts. ---------------------------
for (const f of withCounts) {
  await store.append({ key: fileKey(f.id), at: at(), type: 'signal', spec: ADOPTED, ensure: true });
  for (let i = 1; i < f.commits; i++) {
    await store.append({ key: fileKey(f.id), at: at(), type: 'signal', spec: ADOPTED, ensure: false });
  }
}

// --- medha-arj.1: define the two hottest files. ----------------------------------------------
const hot = withCounts.slice(0, 2);
const cold = withCounts.filter((f) => f.commits === 0)[0] ?? withCounts.at(-1)!;
console.log(`\n[medha-arj.1] defining the ${hot.length} most-touched files:`);
for (const f of hot) {
  await store.append({
    key: fileKey(f.id),
    at: at(),
    type: 'define',
    definition: {
      title: f.id,
      tags: ['hot-file'],
      rationale: `touched by ${f.commits} commits — one of the most-edited files in the repo`,
    },
  });
  console.log(`  defined ${f.id} (${f.commits} commits)`);
}

// --- medha-arj.2 + .3: grow a decision tree on the hottest file, with per-branch evidence. ----
const target = hot[0]!;
const targetKey = fileKey(target.id);
console.log(`\n[medha-arj.2/.3] growing a decision tree on ${target.id}:`);

const rootId = newDecisionCaseId(targetKey);
await store.append({
  key: targetKey,
  at: at(),
  type: 'decision',
  caseId: rootId,
  condition: 'touched by more than 10 commits',
  decision: { type: 'probability', value: 0.5 },
});
console.log(`  root case ${rootId}: "touched by more than 10 commits" -> probability(0.5)`);

const goodBranch = newDecisionCaseId(targetKey);
const badBranch = newDecisionCaseId(targetKey);
await store.append({
  key: targetKey,
  at: at(),
  type: 'decision',
  caseId: goodBranch,
  parentId: rootId,
  condition: 'reviewer consistently ADOPTED this file\'s suggestions',
  decision: { type: 'probability', value: 0.5 },
});
await store.append({
  key: targetKey,
  at: at(),
  type: 'decision',
  caseId: badBranch,
  parentId: rootId,
  condition: 'reviewer consistently REJECTed this file\'s suggestions',
  decision: { type: 'probability', value: 0.5 },
});

for (let i = 0; i < 20; i++) {
  await store.append({
    key: targetKey,
    at: at(),
    type: 'signal',
    spec: ADOPTED,
    ensure: false,
    caseId: goodBranch,
  });
  await store.append({
    key: targetKey,
    at: at(),
    type: 'signal',
    spec: { name: 'REJECT_RULE', value: -1, countsAsTrial: true, countsAsSuccess: false },
    ensure: false,
    caseId: badBranch,
  });
}

const now = at();
const episodesSoFar = await store.episodes();
const tree = foldDecisionTree(episodesSoFar, targetKey);
console.log(`  decision tree for ${target.id} (${tree.length} cases):`);
for (const kase of tree) {
  const status = caseStatus(kase, now);
  const trust = caseTrust(kase, now).trust;
  const parent = kase.parentId ? ` parent=${kase.parentId}` : '';
  console.log(
    `    ${kase.id}${parent}  n=${kase.evidence.n.toString().padStart(2)} k=${kase.evidence.k.toString().padStart(2)}  status=${status.padEnd(9)} trust=${trust.toFixed(3)}  "${kase.condition}"`,
  );
}

const goodCase = tree.find((c) => c.id === goodBranch)!;
const badCase = tree.find((c) => c.id === badBranch)!;
console.log(
  `\n  divergence check: good branch ${caseStatus(goodCase, now)} vs bad branch ${caseStatus(badCase, now)} — ${
    caseStatus(goodCase, now) !== caseStatus(badCase, now) ? 'PASS (diverged)' : 'FAIL (did not diverge)'
  }`,
);

const parentEntity = (await store.get(targetKey))!;
console.log(
  `  parent aggregate for ${target.id}: n=${parentEntity.evidence.n} k=${parentEntity.evidence.k} status=${parentEntity.status}  (every tagged signal above also landed here — additive by design)`,
);

// --- medha-arj.4: decisionPolicy.requireHumanFor gates an 'apply' branch, enforced by the STORE. ---
console.log("\n[medha-arj.4] decisionPolicy.requireHumanFor: 'apply' on kind 'file':");
const gatedCaseId = newDecisionCaseId(fileKey(cold.id));
try {
  await store.append({
    key: fileKey(cold.id),
    at: at(),
    type: 'decision',
    caseId: gatedCaseId,
    condition: 'never touched — safe to auto-apply',
    decision: { type: 'apply' },
    author: 'agent:reviewer',
  });
  console.log('  FAIL: agent-authored apply branch was accepted (expected rejection)');
} catch (err) {
  const code = (err as { code?: string }).code;
  console.log(`  agent-authored apply branch rejected as expected: ${code}`);
}

await store.append({
  key: fileKey(cold.id),
  at: at(),
  type: 'decision',
  caseId: gatedCaseId,
  condition: 'never touched — safe to auto-apply',
  decision: { type: 'apply' },
  author: 'human:nimish',
});
console.log('  human-authored apply branch accepted');

// --- medha-arj.1 fold-purity, checked against the LIVE store's own rebuilt log. ---------------
console.log('\n[medha-arj.1] fold-purity against the live store:');
const fullLog = await store.episodes();
const withoutNonEvidential = fullLog.filter((e) => e.type !== 'define' && e.type !== 'decision');
const reseq = withoutNonEvidential.map((e, i) => ({ ...e, seq: i }));
const liveStates = await store.rebuild();
const strippedStates = foldLog(reseq);
const liveJson = JSON.stringify(liveStates.map((s) => [entityKeyString(s.key), s]));
const strippedJson = JSON.stringify(strippedStates.map((s) => [entityKeyString(s.key), s]));
console.log(
  `  ${fullLog.length} episodes in the live log (${fullLog.length - withoutNonEvidential.length} define/decision); states with them stripped ${
    liveJson === strippedJson ? 'MATCH (fold-purity holds)' : 'DIVERGE (fold-purity BROKEN)'
  }`,
);

const definitions = foldDefinitions(fullLog);
console.log(`\n[medha-arj.1] ${definitions.size} definitions recorded:`);
for (const [key, def] of definitions) {
  console.log(`  ${key.split('\u0000').at(-1)}: "${def.title}" — ${def.rationale}`);
}
