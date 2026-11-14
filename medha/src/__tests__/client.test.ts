import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, MedhaClient, parseEntityKey } from '../client.ts';

describe('Medha TypeScript SDK (medha-ufo.1)', () => {
  let client: MedhaClient;

  beforeEach(async () => {
    client = await MedhaClient.memory({ actor: 'test-agent' });
  });

  test('parseEntityKey correctly parses diverse key formats', () => {
    expect(parseEntityKey('rule:security/no-eval')).toEqual({
      kind: 'rule',
      namespace: 'security',
      id: 'no-eval',
    });
    expect(parseEntityKey('rule:no-eval')).toEqual({
      kind: 'rule',
      namespace: '',
      id: 'no-eval',
    });
    expect(parseEntityKey('security/no-eval')).toEqual({
      kind: 'rule',
      namespace: 'security',
      id: 'no-eval',
    });
    expect(parseEntityKey('simple-id')).toEqual({
      kind: 'rule',
      namespace: '',
      id: 'simple-id',
    });
    expect(parseEntityKey({ kind: 'recipe', namespace: 'ci', id: 'build' })).toEqual({
      kind: 'recipe',
      namespace: 'ci',
      id: 'build',
    });
  });

  test('MedhaClient.memory initializes ephemeral client with clean state', async () => {
    expect(client).toBeDefined();
    expect(client.defaultActor).toBe('test-agent');
    const entities = await client.list();
    expect(entities).toHaveLength(0);
    const status = await client.status();
    expect(status.initialized).toBe(true);
    expect(status.totalEntities).toBe(0);
    expect(status.totalEpisodes).toBe(0);
  });

  test('defineRule registers metadata and creates entity with positive initial signal', async () => {
    const def = await client.defineRule(
      'strict-types',
      'Always specify explicit parameter and return types',
      {
        namespace: 'style',
        contextTargets: {
          languages: ['typescript'],
          keywords: ['type', 'interface'],
        },
        tags: ['convention', 'quality'],
      },
    );

    expect(def.title).toBe('strict-types');
    expect(def.rationale).toContain('explicit parameter');

    const state = await client.get('rule:style/strict-types');
    expect(state).toBeDefined();
    expect(state?.evidence.n).toBe(1);
    expect(state?.evidence.k).toBe(1);

    const report = await client.show('rule:style/strict-types');
    expect(report.hint.status).toBe('probation');
    expect(report.definition?.title).toBe('strict-types');
  });

  test('recordAcceptance and recordRejection update empirical trust scores', async () => {
    await client.defineRule('no-debugger', 'Do not leave debugger statements in code', {
      namespace: 'cleanliness',
    });

    const initial = await client.show('rule:cleanliness/no-debugger');
    const initialTrust = initial.hint.trustScore;

    // Record 3 acceptances
    for (let i = 0; i < 3; i++) {
      await client.recordAcceptance('rule:cleanliness/no-debugger', {
        note: `Applied in iteration ${i}`,
      });
    }

    const accepted = await client.show('rule:cleanliness/no-debugger');
    expect(accepted.hint.evidence.totalTrials).toBe(4);
    expect(accepted.hint.evidence.successes).toBe(4);
    expect(accepted.hint.trustScore).toBeGreaterThan(initialTrust);

    // Record 2 rejections
    for (let i = 0; i < 2; i++) {
      await client.recordRejection('rule:cleanliness/no-debugger', {
        note: `Rejected in iteration ${i}`,
      });
    }

    const rejected = await client.show('rule:cleanliness/no-debugger');
    expect(rejected.hint.evidence.totalTrials).toBe(6);
    expect(rejected.hint.evidence.successes).toBe(4);
    expect(rejected.hint.trustScore).toBeLessThan(accepted.hint.trustScore);
  });

  test('context-aware hints and prompt pack formatting', async () => {
    await client.defineRule('sql-injection', 'Use parameterized queries always', {
      namespace: 'security',
      contextTargets: {
        files: ['src/db/**/*.ts', 'src/models/**'],
        languages: ['typescript', 'sql'],
        keywords: ['query', 'select', 'database'],
      },
    });

    await client.defineRule('react-memo', 'Wrap heavy child components in memo', {
      namespace: 'ui',
      contextTargets: {
        files: ['src/components/**/*.tsx'],
        languages: ['tsx'],
        keywords: ['render', 'component'],
      },
    });

    // Query matching database context
    const dbPack = await client.hintsForContext({
      files: ['src/db/user-store.ts'],
      languages: ['typescript'],
      keywords: ['query'],
    });

    expect(dbPack.selected.length).toBeGreaterThan(0);
    const dbKeys = dbPack.selected.map((p) => p.key.id);
    expect(dbKeys).toContain('sql-injection');
    expect(dbKeys).not.toContain('react-memo');

    // Generate prompt snippet
    const promptSnippet = await client.packPrompt({ budget: 1000 });
    expect(promptSnippet).toContain('### Evidential Memory & Guiding Rules');
    expect(promptSnippet).toContain('sql-injection');
  });

  test('verifyGuard executes command and records pass/fail outcomes into memory', async () => {
    await client.defineRule('guard-check', 'Must pass sanity check', {
      namespace: 'ci',
    });

    // 1. Pass verification
    const passResult = await client.verifyGuard(
      'rule:ci/guard-check',
      'node -e "process.exit(0)"',
      { guard: 'ci' },
    );
    expect(passResult.passed).toBe(true);
    expect(passResult.exitCode).toBe(0);
    expect(passResult.hint.status).not.toBe('quarantined');

    // 2. Fail verification
    const failResult = await client.verifyGuard(
      'rule:ci/guard-check',
      'node -e "process.exit(1)"',
      { guard: 'ci' },
    );
    expect(failResult.passed).toBe(false);
    expect(failResult.exitCode).toBe(1);
    expect(failResult.hint.status).toBe('quarantined');
  });

  test('status aggregates entities, distribution, and health', async () => {
    await client.defineRule('r1', 'Rule one', { namespace: 'ns' });
    await client.defineRule('r2', 'Rule two', { namespace: 'ns' });

    const status = await client.status();
    expect(status.initialized).toBe(true);
    expect(status.totalEntities).toBe(2);
    expect(status.probationCount).toBe(2);
    expect(status.driftCount).toBe(0);
    expect(status.pitfallCount).toBe(0);
  });

  test('AgentSession maintains agent context and records scoped actions', async () => {
    await client.defineRule('format-code', 'Run formatter prior to committing', {
      namespace: 'git',
      contextTargets: { keywords: ['commit', 'git'] },
    });

    const session = client.session('agent-codex-1', {
      runRef: 'run-8821',
      contextFilter: { keywords: ['git'] },
    });

    expect(session).toBeInstanceOf(AgentSession);
    expect(session.agentId).toBe('agent-codex-1');
    expect(session.runRef).toBe('run-8821');

    // Query relevant hints
    const matched = await session.hintsForContext();
    expect(matched.selected.map((p) => p.key.id)).toContain('format-code');

    // Accept rule via session
    const hint = await session.accept('rule:git/format-code', 'Followed formatting');
    expect(hint.evidence.totalTrials).toBe(2);

    // Prompt pack via session
    const prompt = await session.packPrompt({ budget: 500 });
    expect(prompt).toContain('format-code');
  });

  describe('MedhaClient.open with disk directory', () => {
    const testDir = join(tmpdir(), `medha-sdk-test-${Date.now()}`);

    beforeEach(() => {
      mkdirSync(join(testDir, '.medha'), { recursive: true });
      const config = {
        layoutVersion: 1,
        backend: 'sqlite',
        path: 'store.sqlite',
        registries: {
          kinds: ['rule', 'recipe', 'tool'],
        },
      };
      writeFileSync(join(testDir, '.medha', 'config.json'), JSON.stringify(config, null, 2));
    });

    afterEach(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch (err) {
        void err;
      }
    });

    test('opens existing store from disk directory and performs operations', async () => {
      const diskClient = await MedhaClient.open({ dir: testDir });
      expect(diskClient).toBeDefined();

      await diskClient.defineRule('disk-rule', 'Rule stored on disk', {
        namespace: 'persistent',
      });

      const report = await diskClient.show('rule:persistent/disk-rule');
      expect(report.hint.status).toBe('probation');
      expect(report.definition?.title).toBe('disk-rule');

      const reloadedClient = await MedhaClient.open({ dir: testDir });
      const reloaded = await reloadedClient.get('rule:persistent/disk-rule');
      expect(reloaded).toBeDefined();
      expect(reloaded?.key.id).toBe('disk-rule');
    });
  });
});
