import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPLY } from '@cntxt-labs/medha-core';
import { bindEnvironment, type Environment } from './environment.ts';
import { runInit } from './init.ts';
import { runReport } from './report.ts';
import { generateDashboardHtml, startUiServer, type UiServerHandle } from './ui.ts';
import { VERSION } from './version.ts';
import { runGuard, runRecord } from './write.ts';

const NOW = 1_700_000_000_000;

interface InspectJson {
  known: boolean;
  guard: { condition: string };
  hint: { evidence: { totalTrials: number } };
  thresholds: { trusted: number };
  signals: { name: string }[];
}

interface SimulateJson {
  error?: string;
  before: { evidence: { totalTrials: number } };
  after: { evidence: { totalTrials: number } };
  frames: { statusChanged: boolean; hint: { status: string }; guard: { condition: string } }[];
}

let cleanups: string[] = [];

afterEach(async () => {
  const dirs = cleanups;
  cleanups = [];
  Bun.gc(true);
  await new Promise((r) => setTimeout(r, 50));
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      void err;
    }
  }
});

function makeTestEnv(dir: string): Environment {
  const env: Environment = {
    cwd: dir,
    env: {},
    now: () => NOW,
    isTTY: false,
    exitCode: 0,
    stdout: (_text) => {
      void _text;
    },
    stderr: (_text) => {
      void _text;
    },
  };
  bindEnvironment(env);
  return env;
}

describe('medha ui dashboard & report', () => {
  test('generateDashboardHtml outputs self-contained HTML with embedded data', () => {
    const html = generateDashboardHtml({
      status: {
        asOf: NOW,
        home: '/test/home',
        backend: 'sqlite',
        path: null,
        byStatus: { active: 1, trusted: 1, probation: 0, quarantined: 0, retired: 0 },
        drifting: 0,
        preflight: {
          asOf: NOW,
          status: 'ok',
          location: null,
          episodeCount: 2,
          entityCount: 2,
          integrity: 'ok',
          danglingRetractions: [],
          lastSweep: null,
          registries: { kinds: 1, signals: 1, anchors: 1 },
        },
        params: {
          asOf: NOW,
          note: '',
          params: [],
        },
      },
      entities: [
        {
          asOf: NOW,
          key: { namespace: '', kind: 'rule', id: 'rule-1' },
          status: 'trusted',
          trustScore: 0.95,
          components: { wilson: 0.95, guard: 1.0, recency: 1.0, durability: 1.0, ceiling: 1.0 },
          evidence: { successes: 10, totalTrials: 10, lowerBound: 0.8 },
          temporal: {
            emaWeight: 0.95,
            baselineWeight: 0.5,
            driftDelta: 0,
            isDrifting: false,
            driftDirection: 'up',
          },
          clearsThreshold: { trusted: true, active: true },
          lastNote: 'Passed all tests',
        },
      ],
      episodes: [
        {
          type: 'signal',
          seq: 0,
          key: { namespace: '', kind: 'rule', id: 'rule-1' },
          at: NOW,
          spec: APPLY,
          ensure: true,
          note: 'Initial setup',
        },
      ],
      version: '0.2.0',
      home: '/test/home',
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Medha Evidential Memory Dashboard');
    expect(html).toContain('rule-1');
    expect(html).toContain('Passed all tests');
    expect(html).toContain('Initial setup');
    expect(html).toContain('v0.2.0');
  });

  test('generateDashboardHtml client script escapes untrusted note/author/id fields before innerHTML', () => {
    // The note/author/id fields only reach the DOM via the embedded client-side
    // script's innerHTML template strings (the raw JSON blob is not itself HTML).
    // Guard the source so those interpolations stay routed through escapeHtml,
    // and the id no longer breaks out of an inline onclick string literal.
    const html = generateDashboardHtml({
      status: {
        asOf: NOW,
        home: '/test/home',
        backend: 'sqlite',
        path: null,
        byStatus: { active: 1, trusted: 0, probation: 0, quarantined: 0, retired: 0 },
        drifting: 0,
        preflight: {
          asOf: NOW,
          status: 'ok',
          location: null,
          episodeCount: 1,
          entityCount: 1,
          integrity: 'ok',
          danglingRetractions: [],
          lastSweep: null,
          registries: { kinds: 1, signals: 1, anchors: 1 },
        },
        params: { asOf: NOW, note: '', params: [] },
      },
      entities: [],
      episodes: [],
      version: '0.2.0',
      home: '/test/home',
    });

    expect(html).toContain('function escapeHtml(value)');
    // Inline onclick with an interpolated id (the XSS/breakout vector) must be gone.
    expect(html).not.toContain('onclick="inspectEntity(\'');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal template-string source, not interpolating
    expect(html).toContain('data-inspect-id="${escapeHtml(e.key.id)}"');
    expect(html).toContain("addEventListener('click'");
    // Every innerHTML template that carries a note/author/status/id must escape it.
    expect(html).toContain('escapeHtml(e.lastNote)');
    expect(html).toContain('escapeHtml(item.hint.lastNote)');
    expect(html).toContain('escapeHtml(item.admittedBy)');
    expect(html).toContain('escapeHtml(ep.note)');
    expect(html).toContain('escapeHtml(ep.author)');
    expect(html).toContain('escapeHtml(ep.reason)');
    expect(html).toContain('escapeHtml(keyLabel)');
    expect(html).toContain('escapeHtml(e.status)');
  });

  test('embedded UI server handles HTTP endpoints and closes cleanly', async () => {
    // Use an ephemeral port 8499
    const testPort = 8499;

    // Initialize temporary home
    const testDir = join(
      tmpdir(),
      `medha-ui-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    cleanups.push(testDir);
    const env = makeTestEnv(testDir);
    await runInit({ dir: testDir, backend: 'sqlite', recreate: false }, env);

    const server: UiServerHandle = await startUiServer(
      { dir: testDir, port: testPort, host: '127.0.0.1' },
      env,
    );

    try {
      expect(server.url).toBe(`http://127.0.0.1:${testPort}`);

      // 1. Root HTML
      const rootRes = await fetch(`${server.url}/`);
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain('Medha Evidential Memory Dashboard');
      expect(rootRes.headers.get('access-control-allow-origin')).toBeNull();

      // API responses must not opt out of same-origin protection either.
      const apiCorsRes = await fetch(`${server.url}/api/status`);
      expect(apiCorsRes.headers.get('access-control-allow-origin')).toBeNull();

      // 2. API Status
      const statusRes = await fetch(`${server.url}/api/status`);
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        preflight: { status: string };
        backend: string;
      };
      expect(statusJson.preflight.status).toBe('ok');
      expect(statusJson.backend).toBe('sqlite');

      // 3. API Entities
      const entitiesRes = await fetch(`${server.url}/api/entities`);
      expect(entitiesRes.status).toBe(200);
      const entitiesJson = await entitiesRes.json();
      expect(Array.isArray(entitiesJson)).toBe(true);

      // 4. API Episodes
      const episodesRes = await fetch(`${server.url}/api/episodes`);
      expect(episodesRes.status).toBe(200);
      const episodesJson = await episodesRes.json();
      expect(Array.isArray(episodesJson)).toBe(true);

      // 5. API: Decision Trees
      const treesRes = await fetch(`${server.url}/api/decision-trees`);
      expect(treesRes.status).toBe(200);
      const treesJson = await treesRes.json();
      expect(typeof treesJson).toBe('object');

      // 6. API Pack (POST)
      const packRes = await fetch(`${server.url}/api/pack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget: 1000 }),
      });
      expect(packRes.status).toBe(200);
      const packJson = (await packRes.json()) as { budget: number; selected: unknown[] };
      expect(packJson.budget).toBe(1000);
      expect(Array.isArray(packJson.selected)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('generateDashboardHtml embeds and renders decision trees and decision episodes', () => {
    const html = generateDashboardHtml({
      status: {
        asOf: NOW,
        home: '/test/home',
        backend: 'sqlite',
        path: null,
        byStatus: { active: 1, trusted: 0, probation: 0, quarantined: 0, retired: 0 },
        drifting: 0,
        preflight: {
          asOf: NOW,
          status: 'ok',
          location: null,
          episodeCount: 1,
          entityCount: 1,
          integrity: 'ok',
          danglingRetractions: [],
          lastSweep: null,
          registries: { kinds: 1, signals: 1, anchors: 1 },
        },
        params: { asOf: NOW, note: '', params: [] },
      },
      entities: [
        {
          asOf: NOW,
          key: { namespace: '', kind: 'rule', id: 'rule-branch' },
          status: 'active',
          trustScore: 0.8,
          components: { wilson: 0.8, guard: 1.0, recency: 1.0, durability: 1.0, ceiling: 1.0 },
          evidence: { successes: 4, totalTrials: 5, lowerBound: 0.4 },
          temporal: {
            emaWeight: 0.8,
            baselineWeight: 0.5,
            driftDelta: 0,
            isDrifting: false,
            driftDirection: 'up',
          },
          clearsThreshold: { trusted: false, active: true },
        },
      ],
      episodes: [
        {
          type: 'decision',
          seq: 1,
          key: { namespace: '', kind: 'rule', id: 'rule-branch' },
          at: NOW,
          caseId: 'case-root',
          condition: 'env === "prod"',
          decision: { type: 'apply' },
          author: 'alice',
        },
      ],
      decisionTrees: {
        'rule-branch': [
          {
            id: 'case-root',
            condition: 'env === "prod"',
            decision: { type: 'apply' },
            evidence: { k: 4, n: 5, contextRejects: 0 },
            ema: { mu: 0.8, theta0: 0.5, updatedAt: NOW },
            status: 'active',
            trust: 0.8,
          },
        ],
      },
      version: VERSION,
      home: '/test/home',
    });

    expect(html).toContain('Decision Tree &amp; Branch Governance');
    expect(html).toContain('case-root');
    expect(html).toContain('env === \\"prod\\"');
    expect(html).toContain('renderDecisionForest');
  });

  test('runReport writes standalone HTML report to disk', async () => {
    const testDir = join(
      tmpdir(),
      `medha-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    cleanups.push(testDir);
    const env = makeTestEnv(testDir);
    await runInit({ dir: testDir, backend: 'sqlite', recreate: false }, env);

    const outPath = join(testDir, 'custom-report.html');
    const outcome = await runReport({ dir: testDir, out: outPath }, env);

    expect(outcome.path).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);

    const content = await Bun.file(outPath).text();
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('Medha Evidential Memory Dashboard');
  });

  test('inspect + simulate endpoints are namespace-aware and speak the real signal names', async () => {
    const testPort = 8497;
    const testDir = join(
      tmpdir(),
      `medha-ui-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    cleanups.push(testDir);
    const env = makeTestEnv(testDir);
    await runInit({ dir: testDir, backend: 'sqlite', recreate: false }, env);
    for (let i = 0; i < 3; i++) {
      await runRecord(
        { dir: testDir, id: 'r1', namespace: 'team', signal: 'APPLY', ensure: true },
        env,
      );
    }
    await runGuard({ dir: testDir, id: 'r1', namespace: 'team', ok: true }, env);

    const server = await startUiServer({ dir: testDir, port: testPort, host: '127.0.0.1' }, env);
    const post = (body: unknown) =>
      fetch(`${server.url}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<SimulateJson>);
    try {
      // A guard reported without a name still counts as "no check": the card must say so.
      const detail = (await (
        await fetch(`${server.url}/api/inspect?namespace=team&kind=rule&id=r1`)
      ).json()) as InspectJson;
      expect(detail.known).toBe(true);
      expect(detail.guard.condition).toBe('none');
      expect(detail.hint.evidence.totalTrials).toBe(3);
      expect(detail.thresholds.trusted).toBe(0.6);
      expect(detail.signals.map((sg: { name: string }) => sg.name)).toContain('REJECT_CONTEXT');

      // The namespace reaches the engine: the entity is found, not simulated as a fresh one.
      const single = await post({ namespace: 'team', id: 'r1', signal: 'APPLY' });
      expect(single.before.evidence.totalTrials).toBe(3);
      expect(single.after.evidence.totalTrials).toBe(4);

      // The real name of the "context unsuitable" signal works.
      const ctx = await post({ namespace: 'team', id: 'r1', signal: 'REJECT_CONTEXT' });
      expect(ctx.error).toBeUndefined();
      expect(ctx.after.evidence.totalTrials).toBe(3);

      // A path replays steps in order and flags the stage changes.
      const path = await post({
        namespace: 'team',
        id: 'r1',
        steps: [
          { type: 'guard', ok: false, kind: 'review' },
          { type: 'guard', ok: true, kind: 'review' },
          { type: 'advance', days: 30 },
        ],
      });
      const frames = path.frames;
      expect(frames).toHaveLength(4);
      expect(frames[1]?.hint.status).toBe('quarantined');
      expect(frames[1]?.statusChanged).toBe(true);
      expect(frames[2]?.guard.condition).toBe('passed');
      // Nothing was written by any of it.
      const after = (await (
        await fetch(`${server.url}/api/inspect?namespace=team&kind=rule&id=r1`)
      ).json()) as InspectJson;
      expect(after.guard.condition).toBe('none');

      const tooMany = await post({
        namespace: 'team',
        id: 'r1',
        steps: Array.from({ length: 80 }, () => ({ type: 'advance', days: 1 })),
      });
      expect(String(tooMany.error)).toContain('at most');
    } finally {
      await server.close();
    }
  });

  test('inspect page explains things in plain words', () => {
    const html = generateDashboardHtml({
      status: {
        asOf: NOW,
        home: '/h',
        backend: 'sqlite',
        path: null,
        byStatus: { active: 0, trusted: 0, probation: 0, quarantined: 0, retired: 0 },
        drifting: 0,
        preflight: {
          asOf: NOW,
          status: 'ok',
          location: null,
          episodeCount: 0,
          entityCount: 0,
          integrity: 'ok',
          danglingRetractions: [],
          lastSweep: null,
          registries: { kinds: 1, signals: 1, anchors: 1 },
        },
        params: { asOf: NOW, note: '', params: [] },
      },
      entities: [],
      episodes: [],
      version: VERSION,
      home: '/h',
    });
    for (const phrase of [
      'Why this score?',
      'Independent check',
      'What happens next?',
      'Holding it back most',
      'Show the math',
      'On trial',
      'Proven',
    ]) {
      expect(html).toContain(phrase);
    }
    // The old dropdown offered a signal the engine does not have.
    expect(html).not.toContain('CONTEXT_REJECT');
  });
});
