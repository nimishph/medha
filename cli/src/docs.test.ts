import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.ts';
import { startDocsServer } from './docs.ts';
import type { Environment } from './environment.ts';

function createMockEnv(cwd: string): { env: Environment; out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  const env: Environment = {
    cwd,
    env: {},
    now: () => 1_700_000_000_000,
    isTTY: false,
    stdoutIsTTY: false,
    exitCode: 0,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  return { env, out: () => stdout, err: () => stderr };
}

describe('medha docs (medha-168.3)', () => {
  test('boots zero-dependency local HTTP server and serves docs SPA and API endpoints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'medha-docs-test-'));
    try {
      const { env } = createMockEnv(root);
      // Initialize an engine home in root
      await runCli(['init'], env);
      await runCli(
        ['record', '--kind', 'rule', '--id', 'doc-test-rule', '--signal', 'APPLY', '--ensure'],
        env,
      );

      // Start docs server on ephemeral port (port: 0 or high port)
      const handle = await startDocsServer({ dir: root, port: 0 }, env);
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);

      // 1. Root HTML SPA
      const rootRes = await fetch(`${handle.url}/`);
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get('content-type')).toContain('text/html');
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain('Medha Docs');
      expect(rootHtml).toContain('id="search"');
      expect(rootHtml).toContain('id="telemetry-badge"');

      // 2. /api/docs catalog
      const catalogRes = await fetch(`${handle.url}/api/docs`);
      expect(catalogRes.status).toBe(200);
      const catalog = (await catalogRes.json()) as {
        guides: readonly { slug: string; title: string }[];
      };
      expect(catalog.guides.length).toBeGreaterThanOrEqual(4);
      expect(catalog.guides.some((g) => g.slug === 'overview')).toBe(true);
      expect(catalog.guides.some((g) => g.slug === 'cli')).toBe(true);

      // 3. /api/docs/:slug specific guide
      const overviewRes = await fetch(`${handle.url}/api/docs/overview`);
      expect(overviewRes.status).toBe(200);
      const overviewDoc = (await overviewRes.json()) as {
        slug: string;
        title: string;
        content: string;
      };
      expect(overviewDoc.slug).toBe('overview');
      expect(overviewDoc.content).toContain('Dual-Loop Architecture');

      // 4. /api/status local store connectivity
      const statusRes = await fetch(`${handle.url}/api/status`);
      expect(statusRes.status).toBe(200);
      const storeStatus = (await statusRes.json()) as { totalEntities: number; home: string };
      expect(storeStatus.totalEntities).toBe(1);

      // 5. /health check
      const healthRes = await fetch(`${handle.url}/health`);
      expect(healthRes.status).toBe(200);
      expect((await healthRes.json()) as { status: string }).toEqual({ status: 'ok' });

      // Clean shutdown
      await handle.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('offline fallback serves embedded guides when no docs/ directory exists', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'medha-docs-empty-'));
    try {
      const { env } = createMockEnv(emptyDir);
      const handle = await startDocsServer({ dir: emptyDir, port: 0 }, env);

      const catalogRes = await fetch(`${handle.url}/api/docs`);
      expect(catalogRes.status).toBe(200);
      const catalog = (await catalogRes.json()) as {
        guides: readonly { slug: string; title: string }[];
      };
      expect(catalog.guides.length).toBeGreaterThanOrEqual(4);
      expect(catalog.guides.some((g) => g.slug === 'overview')).toBe(true);
      expect(catalog.guides.some((g) => g.slug === 'getting-started')).toBe(true);

      await handle.close();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
