import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPLY } from '@cntxt-labs/medha-core';
import { bindEnvironment, type Environment } from './environment.ts';
import { runInit } from './init.ts';
import { runReport } from './report.ts';
import { generateDashboardHtml, startUiServer, type UiServerHandle } from './ui.ts';

const NOW = 1_700_000_000_000;

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
          temporal: { emaWeight: 0.95, driftDelta: 0, isDrifting: false },
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

      // 5. API Pack (POST)
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
});
