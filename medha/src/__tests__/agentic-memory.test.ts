import { describe, expect, test } from 'bun:test';
import type { TrajectoryEvidence } from '@cntxt-labs/medha-core';
import { MemoryStore, resolveRegistries } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

const NOW = 1_700_000_000_000;

describe('Agentic Evidential Memory (medha-c8z)', () => {
  describe('medha-c8z.1: Context Targets & Selective Packing', () => {
    test('selective packing filters entities by matching context targets', async () => {
      const store = new MemoryStore();
      const engine = new Medha({ store });
      await engine.open({ now: NOW });

      // Define two rules with different context targets
      const authKey = { namespace: '', kind: 'rule', id: 'jwt-auth-validation' };
      const dbKey = { namespace: '', kind: 'rule', id: 'postgres-connection-pooling' };

      await engine.define(
        authKey,
        {
          title: 'JWT Auth Validation',
          rationale: 'Always validate JWT expiration and signature',
          tags: ['security', 'auth'],
          contextTargets: {
            files: ['src/auth/**', 'src/middleware/auth.ts'],
            languages: ['typescript'],
            keywords: ['jwt', 'bearer', 'token'],
          },
        },
        { now: NOW },
      );

      await engine.define(
        dbKey,
        {
          title: 'DB Connection Pooling',
          rationale: 'Limit pool size and set idle timeout',
          tags: ['database', 'sql'],
          contextTargets: {
            files: ['src/db/**', 'src/models/*'],
            languages: ['typescript', 'sql'],
            keywords: ['pool', 'postgres', 'query'],
          },
        },
        { now: NOW },
      );

      // Record high trust for both
      for (let i = 0; i < 5; i++) {
        await engine.record(authKey, 'APPLY', { now: NOW + i * 10 }, { ensure: true });
        await engine.record(dbKey, 'APPLY', { now: NOW + i * 10 }, { ensure: true });
      }

      // 1. Pack with auth context (file + query keyword)
      const authPack = await engine.pack(
        {
          budget: 500,
          kind: 'rule',
          contextFilter: { files: ['src/auth/session.ts'], query: 'jwt bearer verification' },
        },
        { now: NOW + 100 },
      );
      expect(authPack.selected.some((h) => h.key.id === 'jwt-auth-validation')).toBe(true);
      expect(authPack.selected.some((h) => h.key.id === 'postgres-connection-pooling')).toBe(false);

      // 2. Pack with db context (only file context)
      const dbPack = await engine.pack(
        {
          budget: 500,
          kind: 'rule',
          contextFilter: { files: ['src/db/client.ts'] },
        },
        { now: NOW + 100 },
      );
      expect(dbPack.selected.some((h) => h.key.id === 'postgres-connection-pooling')).toBe(true);
      expect(dbPack.selected.some((h) => h.key.id === 'jwt-auth-validation')).toBe(false);

      // 3. hintsForContext direct query targeting auth
      const authHints = await engine.hintsForContext(
        { files: ['src/auth/jwt.ts'], query: 'token' },
        { budget: 500 },
        { now: NOW + 100 },
      );
      expect(authHints.selected.some((h) => h.key.id === 'jwt-auth-validation')).toBe(true);
      expect(authHints.selected.some((h) => h.key.id === 'postgres-connection-pooling')).toBe(
        false,
      );
    });
  });

  describe('medha-c8z.2: Automated Shadow Guarding', () => {
    test('verifies guard assertion and transitions entity status accordingly', async () => {
      const store = new MemoryStore();
      const engine = new Medha({ store });
      await engine.open({ now: NOW });

      const key = { namespace: '', kind: 'rule', id: 'lint-boundary-guard' };
      // Give initial successes
      for (let i = 0; i < 5; i++) {
        await engine.record(key, 'APPLY', { now: NOW + i * 10 }, { ensure: true });
      }

      // Assert passing guard
      await engine.reportGuard(
        key,
        { ok: true, kind: 'shadow-test', note: 'All assertions green' },
        { now: NOW + 100 },
      );
      const detailPassing = await engine.show(key, { now: NOW + 101 });
      expect(detailPassing.hint.status).toBe('trusted');

      // Assert failing guard
      await engine.reportGuard(
        key,
        { ok: false, kind: 'shadow-test', note: 'Assertion failed on boundary' },
        { now: NOW + 200 },
      );
      const detailFailing = await engine.show(key, { now: NOW + 201 });
      expect(detailFailing.hint.status).toBe('quarantined');
    });
  });

  describe('medha-c8z.3: Multi-Agent Convergence Gates', () => {
    test('enforces role diversity before promotion to active and trusted', async () => {
      // Register custom kind spec with convergence gates in store
      const store = new MemoryStore({
        registries: resolveRegistries({
          kinds: ['agentic-rule'],
          signalSpecs: [],
          anchorKinds: [],
          kindSpecs: [
            {
              name: 'agentic-rule',
              thresholds: {
                active: 0.2,
                trusted: 0.6,
                minUsesForTrusted: 5,
              },
              convergenceGates: {
                minDistinctRolesForActive: 2,
                minDistinctRolesForTrusted: 3,
                requiredRolesForTrusted: ['tester', 'reviewer'],
              },
            },
          ],
        }),
      });
      const engine = new Medha({ store });
      await engine.open({ now: NOW });

      const key = { namespace: '', kind: 'agentic-rule', id: 'no-direct-eval' };

      // 1. Initial successes from only "coder" agent
      for (let i = 0; i < 6; i++) {
        await engine.record(
          key,
          'APPLY',
          { now: NOW + i * 10 },
          { ensure: true, author: 'coder:subagent-1' },
        );
      }
      await engine.reportGuard(key, { ok: true, kind: 'test' }, { now: NOW + 70 });

      // Despite 6 successes and trust > 0.6, only 1 role ('coder') -> MUST REMAIN IN PROBATION
      let detail = await engine.show(key, { now: NOW + 80 });
      expect(detail.hint.status).toBe('probation');

      // 2. Second success from "tester" agent -> 2 distinct roles ('coder', 'tester') -> ADVANCES TO ACTIVE
      await engine.record(key, 'APPLY', { now: NOW + 90 }, { author: 'tester:bot-qa' });
      detail = await engine.show(key, { now: NOW + 100 });
      expect(detail.hint.status).toBe('active');

      // 3. Third success from "reviewer" agent -> 3 distinct roles including 'tester' & 'reviewer' -> ADVANCES TO TRUSTED
      await engine.record(key, 'APPLY', { now: NOW + 110 }, { author: 'reviewer:senior-agent' });
      detail = await engine.show(key, { now: NOW + 120 });
      expect(detail.hint.status).toBe('trusted');
    });
  });

  describe('medha-c8z.4: Negative-Evidence Radar (Pitfalls)', () => {
    test('detects high-risk pitfalls and failing guards', async () => {
      const store = new MemoryStore();
      const engine = new Medha({ store });
      await engine.open({ now: NOW });

      const failingKey = { namespace: '', kind: 'rule', id: 'broken-parser-rule' };
      for (let i = 0; i < 5; i++) {
        await engine.record(failingKey, 'APPLY', { now: NOW + i * 10 }, { ensure: true });
      }
      await engine.reportGuard(
        failingKey,
        { ok: false, kind: 'test', note: 'Syntax crash' },
        { now: NOW + 100 },
      );

      const pitfalls = await engine.detectPitfalls({ now: NOW + 150 });
      expect(pitfalls.length).toBeGreaterThanOrEqual(1);
      const found = pitfalls.find((p) => p.key.id === 'broken-parser-rule');
      expect(found).toBeDefined();
      expect(found?.status).toBe('quarantined');
      expect(found?.reason).toContain('guard failed');
    });
  });

  describe('medha-c8z.5: Autonomous Retrospective Distillation', () => {
    test('distills candidate rules from trajectory evidence', async () => {
      const store = new MemoryStore();
      const engine = new Medha({ store });
      await engine.open({ now: NOW });

      const trajectory: TrajectoryEvidence = {
        id: 'incident-sql-lock',
        title: 'Fix SQLite database lock timeout under concurrent load',
        commitSha: '7a8b9c0d1e2f',
        resolved: true,
        lessons: [
          {
            id: 'sqlite-wal-busy-timeout',
            text: 'Always enable WAL mode and set busy_timeout >= 5000ms for concurrent SQLite writers',
            kind: 'rule',
          },
        ],
      };

      const result = await engine.distillTrajectory(trajectory, { autoFile: true }, { now: NOW });
      expect(result.filedCount).toBe(1);
      expect(result.proposals.length).toBe(1);
      const p = result.proposals[0];
      expect(p).toBeDefined();
      expect(p?.key?.kind).toBe('rule');
      expect(p?.key?.id).toBe('sqlite-wal-busy-timeout');
      expect(p?.anchor?.kind).toBe('commit');
      expect(p?.anchor?.value).toBe('7a8b9c0d1e2f');
    });
  });
});
