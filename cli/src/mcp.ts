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
import { compactHint, shapeHints } from './shape.ts';
import { VERSION } from './version.ts';

/**
 * An MCP server over a project's evidential memory engine.
 * Exposes 9 tools:
 * hints (batch), list_entities, show_entity, record_signal, report_guard,
 * propose, drift, simulate, status.
 */
export function createMcpServer(engine: Sage, environment: Environment): McpServer {
  const server = new McpServer({ name: 'medha', version: VERSION });

  const respond = async (run: () => Promise<unknown>, compact = false) => {
    try {
      const value = await run();
      return { content: [{ type: 'text' as const, text: toJson(value, compact) }] };
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
      description:
        'Batch fetch hints for entity keys. Returns { hints, unknown }: `unknown` lists requested keys that do not exist (treat them as probation).',
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
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ keys, compact }) =>
      respond(async () => {
        const requested = keys.map((k) => ({
          namespace: k.namespace ?? '',
          kind: k.kind ?? 'rule',
          id: k.id,
        }));
        const found = await engine.hints(requested, { now: environment.now() });
        return shapeHints(requested, found, compact === true);
      }, compact === true),
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
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ kind, status, namespace, drifting, limit, cursor, compact }) =>
      respond(async () => {
        const page = await engine.list(
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
        );
        return compact === true ? { ...page, items: page.items.map(compactHint) } : page;
      }, compact === true),
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
        'Record an evidential signal (APPLY, REJECT_RULE, etc.) on an entity, updating its weight. Returns `recorded: false` when the entity is unknown and `ensure` is not set.',
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
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ namespace, kind, id, signal, updater, ensure, compact }) =>
      respond(async () => {
        const outcome = await engine.record(
          { namespace: namespace ?? '', kind: kind ?? 'rule', id },
          signal,
          { now: environment.now() },
          {
            ...(updater === undefined ? {} : { updater }),
            ensure: ensure === true,
          },
        );
        const recorded = outcome.state !== undefined;
        return {
          recorded,
          ...(recorded
            ? {}
            : {
                note: 'entity is unknown and `ensure` was not set: nothing was recorded; the hint is a probation prior. Pass ensure: true to create it.',
              }),
          hint: compact === true ? compactHint(outcome.hint) : outcome.hint,
          ...(outcome.updater === undefined ? {} : { updater: outcome.updater }),
        };
      }, compact === true),
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
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ namespace, kind, id, source, evidenceRefs, anchor, text, metadata, compact }) =>
      respond(async () => {
        const outcome = await engine.propose(
          {
            key: { namespace: namespace ?? '', kind: kind ?? 'rule', id },
            ...(text === undefined ? {} : { text }),
            provenance: source,
            ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
            ...(anchor === undefined ? {} : { anchor }),
            ...(metadata === undefined ? {} : { metadata }),
          },
          { now: environment.now() },
        );
        return {
          hint: compact === true ? compactHint(outcome.hint) : outcome.hint,
          promoted: outcome.promoted,
          ...(outcome.promotionReason === undefined
            ? {}
            : { promotionReason: outcome.promotionReason }),
          provenances: outcome.provenances,
          episode: outcome.episode,
        };
      }, compact === true),
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
