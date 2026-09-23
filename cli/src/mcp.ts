import type { Sage } from '@cntxt-labs/medha';
import { type LifecycleStatus, MedhaError, toMedhaError } from '@cntxt-labs/medha-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { pageAll } from './read.ts';
import { toJson } from './render.ts';
import { VERSION } from './version.ts';

/**
 * An MCP server over a project's evidential memory engine.
 * Exposes 9 tools matching SAGE-LIBRARY-SPEC.md §9.2:
 * hints (batch), list_entities, show_entity, record_signal, report_guard,
 * propose, drift, simulate, status.
 */
export function createMcpServer(engine: Sage, environment: Environment): McpServer {
  const server = new McpServer({ name: 'medha', version: VERSION });

  const respond = async (run: () => Promise<unknown>) => {
    try {
      const value = await run();
      return { content: [{ type: 'text' as const, text: toJson(value) }] };
    } catch (failure) {
      const error =
        failure instanceof MedhaError ? failure : toMedhaError(failure, 'answer a tool call');
      return {
        isError: true,
        content: [{ type: 'text' as const, text: toJson({ error }) }],
      };
    }
  };

  // 1. hints (batch)
  server.registerTool(
    'hints',
    {
      description: 'Batch fetch hints for entity keys. Unknown entities receive probation priors.',
      inputSchema: {
        keys: z
          .array(
            z.object({
              namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
              kind: z.string().optional().describe('Entity kind. Default: rule.'),
              id: z.string().describe('Entity id.'),
            }),
          )
          .describe('Entity keys to query.'),
      },
    },
    ({ keys }) =>
      respond(() =>
        engine.hints(
          keys.map((k) => ({
            namespace: k.namespace ?? '',
            kind: k.kind ?? 'rule',
            id: k.id,
          })),
          { now: environment.now() },
        ),
      ),
  );

  // 2. list_entities
  server.registerTool(
    'list_entities',
    {
      description:
        'List entities with trust, lifecycle status, and drift flags, filtered and paginated.',
      inputSchema: {
        kind: z.string().optional().describe('Filter by entity kind.'),
        status: z
          .enum(['probation', 'active', 'trusted', 'quarantined', 'retired'])
          .optional()
          .describe('Filter by lifecycle status.'),
        namespace: z.string().optional().describe('Filter by entity namespace.'),
        drifting: z.boolean().optional().describe('Filter to only drifting entities.'),
        limit: z.number().int().positive().optional().describe('Page limit.'),
        cursor: z.string().optional().describe('Pagination cursor.'),
      },
    },
    ({ kind, status, namespace, drifting, limit, cursor }) =>
      respond(() =>
        engine.list(
          {
            ...(kind === undefined ? {} : { kind }),
            ...(status === undefined ? {} : { status: status as LifecycleStatus }),
            ...(namespace === undefined ? {} : { namespace }),
            ...(drifting === true ? { drifting: true } : {}),
          },
          { now: environment.now() },
          {
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        ),
      ),
  );

  // 3. show_entity
  server.registerTool(
    'show_entity',
    {
      description:
        'Show entity details: trust, components, temporal state, recent episodes, and provenance.',
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        recent: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of recent episodes to include.'),
      },
    },
    ({ namespace, kind, id, recent }) =>
      respond(() =>
        engine.show(
          { namespace: namespace ?? '', kind: kind ?? 'rule', id },
          { now: environment.now() },
          recent === undefined ? {} : { recent },
        ),
      ),
  );

  // 4. record_signal
  server.registerTool(
    'record_signal',
    {
      description:
        'Record an evidential signal (APPLY, REJECT_RULE, etc.) on an entity, updating its weight.',
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        signal: z.string().describe('Signal name to record (e.g. APPLY, REJECT_RULE, SKIP).'),
        updater: z.string().optional().describe('Weight updater name to use.'),
        ensure: z
          .boolean()
          .optional()
          .describe('If true, materialize the entity if it does not exist.'),
      },
    },
    ({ namespace, kind, id, signal, updater, ensure }) =>
      respond(() =>
        engine.record(
          { namespace: namespace ?? '', kind: kind ?? 'rule', id },
          signal,
          { now: environment.now() },
          {
            ...(updater === undefined ? {} : { updater }),
            ensure: ensure === true,
          },
        ),
      ),
  );

  // 5. report_guard
  server.registerTool(
    'report_guard',
    {
      description:
        'Record a guard evaluation result (harness passed/failed, review verdict, etc.).',
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        ok: z.boolean().describe('Whether the guard passed.'),
        guardKind: z.string().describe('Guard kind, e.g. harness, review, audit.'),
        details: z.record(z.string(), z.unknown()).optional().describe('Optional guard details.'),
      },
    },
    ({ namespace, kind: entityKind, id, ok, guardKind, details }) =>
      respond(() =>
        engine.reportGuard(
          { namespace: namespace ?? '', kind: entityKind ?? 'rule', id },
          {
            ok,
            kind: guardKind,
            ...(details === undefined ? {} : { details }),
          },
          { now: environment.now() },
        ),
      ),
  );

  // 6. propose
  server.registerTool(
    'propose',
    {
      description: 'Submit a candidate entity proposal for evidential promotion/mining.',
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        source: z.string().describe('Source of proposal (e.g. miner name or file path).'),
        evidenceRefs: z
          .array(z.string())
          .optional()
          .describe('Evidence references (e.g. commit SHAs, file paths).'),
        anchor: z
          .union([
            z.string().transform((val) => ({ kind: 'week', value: val })),
            z.object({ kind: z.string(), value: z.string() }),
          ])
          .optional()
          .describe('Optional anchor (string value or { kind, value }).'),
        text: z.string().optional().describe('Optional text content of the proposal.'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata.'),
      },
    },
    ({ namespace, kind, id, source, evidenceRefs, anchor, text, metadata }) =>
      respond(() =>
        engine.propose(
          {
            key: { namespace: namespace ?? '', kind: kind ?? 'rule', id },
            ...(text === undefined ? {} : { text }),
            provenance: source,
            ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
            ...(anchor === undefined ? {} : { anchor }),
            ...(metadata === undefined ? {} : { metadata }),
          },
          { now: environment.now() },
        ),
      ),
  );

  // 7. drift
  server.registerTool(
    'drift',
    {
      description:
        'List entities currently experiencing weight drift, ordered by most-drifted first.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Cap on number of drifting entities.'),
      },
    },
    ({ limit }) =>
      respond(() => engine.drift({ now: environment.now() }, limit === undefined ? {} : { limit })),
  );

  // 8. simulate
  server.registerTool(
    'simulate',
    {
      description:
        'Simulate the trust delta a signal would produce on an entity without persisting anything.',
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        signal: z.string().describe('Signal name to simulate.'),
      },
    },
    ({ namespace, kind, id, signal }) =>
      respond(() =>
        engine.simulate({ namespace: namespace ?? '', kind: kind ?? 'rule', id }, signal, {
          now: environment.now(),
        }),
      ),
  );

  // 9. status
  server.registerTool(
    'status',
    {
      description:
        'Engine health report: preflight integrity, distribution by lifecycle status, drift count.',
      inputSchema: {},
    },
    () =>
      respond(async () => {
        const now = environment.now();
        const preflight = await engine.preflight({ now });
        const all = await pageAll(engine, now);
        const byStatus: Record<string, number> = {
          probation: 0,
          active: 0,
          trusted: 0,
          quarantined: 0,
          retired: 0,
        };
        let driftingCount = 0;
        for (const hint of all) {
          byStatus[hint.status] = (byStatus[hint.status] ?? 0) + 1;
          if (hint.temporal.isDrifting) driftingCount += 1;
        }
        return {
          preflight,
          byStatus,
          driftingCount,
          totalEntities: all.length,
        };
      }),
  );

  return server;
}

export interface ServeMcpOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
}

/**
 * Serve the project engine over stdio until the client goes away.
 */
export async function serveMcp(
  options: ServeMcpOptions,
  environment: Environment,
  transport: Transport = new StdioServerTransport(),
): Promise<void> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  const server = createMcpServer(opened.engine, environment);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  if (transport instanceof StdioServerTransport) {
    const handleClose = () => {
      void server.close();
    };
    process.stdin.once('close', handleClose);
    process.stdin.once('end', handleClose);
  }
  await server.connect(transport);
  environment.stderr(`medha mcp: serving ${opened.home}\n`);
  await closed;
  await opened.engine.close();
}
