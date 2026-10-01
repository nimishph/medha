import type { Medha } from '@cntxt-labs/medha';
import {
  type Decision,
  type LifecycleStatus,
  MedhaError,
  toMedhaError,
} from '@cntxt-labs/medha-core';
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
import { parseTimestamp, resolveAuthor } from './write.ts';

/**
 * An MCP server over a project's evidential memory engine.
 * Exposes 13 tools:
 * hints (batch), list_entities, show_entity, record_signal, report_guard,
 * record_decision, propose, drift, simulate, status, retract_episode,
 * remove_episode, pack_context.
 */
export function createMcpServer(engine: Medha, environment: Environment): McpServer {
  const server = new McpServer({ name: 'medha', version: VERSION });

  // Tool annotations (GitHub #8) let a client tell reads from writes, and ask before the one hard
  // delete. Every tool acts only on the local store, so none is open-world. Writes other than
  // remove_episode append to the log, so they are not destructive, and none is idempotent: repeating
  // a signal or a proposal is a second piece of evidence.
  const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
  const APPEND = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;
  const DESTRUCTIVE = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  } as const;

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
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
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
      annotations: APPEND,
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
        caseId: z
          .string()
          .optional()
          .describe(
            'Decision branch (case) id to attribute this signal to, so the branch learns too and ' +
              'not just the rule as a whole. Read the ids off the `decisionTree` in show_entity. ' +
              'Must name a branch the entity already has: a typo is an error, never a silent no-op.',
          ),
        author: z.string().optional().describe('Author or agent identity recording the signal.'),
        at: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Historical timestamp (ISO 8601 or epoch ms) for backfilling evidence.'),
        note: z.string().optional().describe('Rationale or note attached to this signal.'),
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ namespace, kind, id, signal, updater, ensure, caseId, author, at, note, compact }) =>
      respond(async () => {
        const effectiveNow = parseTimestamp(at, environment.now());
        const resolvedAuthor = resolveAuthor(author, environment.env);
        const outcome = await engine.record(
          { namespace: namespace ?? '', kind: kind ?? 'rule', id },
          signal,
          { now: effectiveNow },
          {
            ...(updater === undefined ? {} : { updater }),
            ensure: ensure === true,
            ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }),
            ...(note === undefined ? {} : { note }),
            ...(caseId === undefined ? {} : { caseId }),
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
          ...(caseId === undefined ? {} : { caseId }),
        };
      }, compact === true),
  );

  // 5. report_guard
  server.registerTool(
    'report_guard',
    {
      description:
        'Record a guard evaluation result (harness passed/failed, review verdict, etc.).',
      annotations: APPEND,
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        ok: z.boolean().describe('Whether the guard passed.'),
        guardKind: z.string().describe('Guard kind, e.g. harness, review, audit.'),
        details: z.record(z.string(), z.unknown()).optional().describe('Optional guard details.'),
        author: z
          .string()
          .optional()
          .describe('Author or agent identity reporting the guard result.'),
        at: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Historical timestamp (ISO 8601 or epoch ms) for backfilling guard report.'),
        note: z.string().optional().describe('Rationale or note attached to this guard outcome.'),
      },
    },
    ({ namespace, kind: entityKind, id, ok, guardKind, details, author, at, note }) =>
      respond(() => {
        const effectiveNow = parseTimestamp(at, environment.now());
        const resolvedAuthor = resolveAuthor(author, environment.env);
        return engine.reportGuard(
          { namespace: namespace ?? '', kind: entityKind ?? 'rule', id },
          {
            ok,
            kind: guardKind,
            at: effectiveNow,
            ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }),
            ...(details === undefined ? {} : { details }),
            ...(note === undefined ? {} : { note }),
          },
          { now: effectiveNow },
        );
      }),
  );

  // 6. record_decision
  server.registerTool(
    'record_decision',
    {
      description:
        "Grow or edit one branch of an entity's decision tree: a free-text `condition` and a " +
        'decision (apply / ignore / probability). Omit `caseId` to create a new branch; pass the ' +
        "caseId from show_entity's decisionTree to edit that branch in place. Medha does not " +
        'evaluate conditions: you pick the branch that fits, then report outcomes against it via ' +
        "record_signal's caseId. Omitting `parentId` when editing keeps the branch where it is; " +
        'pass `detach: true` to move it to the top level. A `parentId` naming no branch of this ' +
        'entity is an error, not a new root.',
      annotations: APPEND,
      inputSchema: {
        namespace: z.string().optional().describe('Entity namespace. Default: empty string.'),
        kind: z.string().optional().describe('Entity kind. Default: rule.'),
        id: z.string().describe('Entity id.'),
        condition: z.string().describe('Free-text condition this branch covers.'),
        decision: z
          .union([
            z.object({ type: z.literal('apply') }),
            z.object({ type: z.literal('ignore') }),
            z.object({ type: z.literal('probability'), value: z.number().min(0).max(1) }),
          ])
          .describe('What to do under this condition: apply, ignore, or probability(p) in [0,1].'),
        caseId: z
          .string()
          .optional()
          .describe('Existing branch id to edit in place. Omit to create a new branch.'),
        parentId: z
          .string()
          .optional()
          .describe(
            'Existing branch id to nest under. Omit on edit to keep the current parent; omit on ' +
              'create to make a top-level branch.',
          ),
        detach: z
          .boolean()
          .optional()
          .describe('Move this branch to the top level. Cannot be combined with parentId.'),
        author: z
          .string()
          .optional()
          .describe(
            "Author or agent identity writing this branch. If the kind's " +
              'decisionPolicy.requireHumanFor gates this decision type, a human must run this ' +
              "command: 'human:' is a label you set yourself, and passing it is not verification.",
          ),
        at: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Historical timestamp (ISO 8601 or epoch ms) for backfilling.'),
      },
    },
    ({ namespace, kind, id, condition, decision, caseId, parentId, detach, author, at }) =>
      respond(async () => {
        const effectiveNow = parseTimestamp(at, environment.now());
        const resolvedAuthor = resolveAuthor(author, environment.env);
        const key = { namespace: namespace ?? '', kind: kind ?? 'rule', id };
        const outcome = await engine.decision(
          key,
          {
            condition,
            decision: decision as Decision,
            ...(caseId === undefined ? {} : { caseId }),
            ...(parentId === undefined ? {} : { parentId }),
            ...(detach === true ? { detach: true } : {}),
          },
          { now: effectiveNow },
          { ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }) },
        );
        // Return the whole tree, not just the branch: the caller needs the parent's id to keep
        // nesting, and the sibling ids to branch further.
        const detail = await engine.show(key, { now: effectiveNow });
        return {
          caseId: outcome.caseId,
          condition,
          decision,
          decisionTree: detail.decisionTree ?? [],
        };
      }),
  );

  // 7. propose
  server.registerTool(
    'propose',
    {
      description: 'Submit a candidate entity proposal for evidential promotion/mining.',
      annotations: APPEND,
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
        author: z.string().optional().describe('Author or agent identity submitting the proposal.'),
        at: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Historical timestamp (ISO 8601 or epoch ms) for backfilling proposal.'),
        note: z.string().optional().describe('Rationale or note attached to this proposal.'),
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ namespace, kind, id, source, evidenceRefs, anchor, text, author, at, note, compact }) =>
      respond(async () => {
        const effectiveNow = parseTimestamp(at, environment.now());
        const resolvedAuthor = resolveAuthor(author, environment.env);
        const outcome = await engine.propose(
          {
            key: { namespace: namespace ?? '', kind: kind ?? 'rule', id },
            ...(text === undefined ? {} : { description: text }),
            provenance: source,
            ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
            ...(anchor === undefined ? {} : { anchor }),
            at: effectiveNow,
            ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }),
            ...(note === undefined ? {} : { note }),
          },
          { now: effectiveNow },
          {
            ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }),
          },
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

  // 8. drift
  server.registerTool(
    'drift',
    {
      description:
        'List entities currently experiencing weight drift, ordered by most-drifted first.',
      annotations: READ_ONLY,
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

  // 9. simulate
  server.registerTool(
    'simulate',
    {
      description:
        'Simulate the trust delta a signal would produce on an entity without persisting anything.',
      annotations: READ_ONLY,
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

  // 10. status
  server.registerTool(
    'status',
    {
      description:
        'Engine health report: preflight integrity, distribution by lifecycle status, drift count.',
      annotations: READ_ONLY,
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

  // 11. retract_episode
  server.registerTool(
    'retract_episode',
    {
      description:
        'Retract an erroneous episode by its sequence number, appending a masking retract episode.',
      annotations: APPEND,
      inputSchema: {
        seq: z.number().int().nonnegative().describe('Sequence number of the episode to retract.'),
        reason: z.string().describe('Reason for retracting the episode.'),
        author: z.string().optional().describe('Author or agent identity retracting the episode.'),
        at: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Historical timestamp (ISO 8601 or epoch ms).'),
        compact: z
          .boolean()
          .optional()
          .describe('If true, return one-line hints and unindented JSON (fewer tokens).'),
      },
    },
    ({ seq, reason, author, at, compact }) =>
      respond(async () => {
        const effectiveNow = parseTimestamp(at, environment.now());
        const resolvedAuthor = resolveAuthor(author, environment.env);
        const outcome = await engine.retract(
          seq,
          reason,
          { now: effectiveNow },
          { ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }) },
        );
        return {
          retractedSeq: seq,
          reason,
          episode: outcome.episode,
          hint: compact === true ? compactHint(outcome.hint) : outcome.hint,
        };
      }, compact === true),
  );

  // 12. remove_episode
  server.registerTool(
    'remove_episode',
    {
      description:
        'Hard-delete an episode from the store log and resequence the rest. Destructive: the ' +
        'evidence is gone from the log. Prefer retract_episode, which keeps the history. The ' +
        'author, reason and removed episode are kept in the store audit trail.',
      annotations: DESTRUCTIVE,
      inputSchema: {
        seq: z.number().int().nonnegative().describe('Sequence number of the episode to remove.'),
        author: z.string().min(1).describe('Author or agent identity removing the episode.'),
        reason: z.string().min(1).describe('Why this episode is being removed.'),
      },
    },
    ({ seq, author, reason }) =>
      respond(() => engine.removeEpisode(seq, { author, reason, now: environment.now() })),
  );

  // 13. pack_context
  server.registerTool(
    'pack_context',
    {
      description:
        'Pack active and probation entities (rules, tools) into an evidential context window within a token budget.',
      annotations: READ_ONLY,
      inputSchema: {
        budget: z.number().int().nonnegative().describe('Maximum token budget (e.g. 2000).'),
        kind: z.string().optional().describe('Filter by entity kind (default: rule).'),
        namespace: z.string().optional().describe('Filter by entity namespace.'),
        explorationRatio: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Proportion of budget for exploring probation entities (default: 0.15).'),
        seed: z.number().int().optional().describe('Seed for deterministic exploration sampling.'),
        format: z
          .enum(['markdown', 'compact', 'json'])
          .optional()
          .describe('Output format (default: markdown).'),
      },
    },
    ({ budget, kind, namespace, explorationRatio, seed, format }) =>
      respond(async () => {
        const effectiveNow = environment.now();
        const outcome = await engine.pack(
          {
            budget,
            kind: kind ?? 'rule',
            ...(namespace === undefined ? {} : { namespace }),
            ...(explorationRatio === undefined ? {} : { explorationRatio }),
            ...(seed === undefined ? {} : { seed }),
          },
          { now: effectiveNow, ...(seed === undefined ? {} : { seed }) },
        );
        const resolvedFormat = format ?? 'markdown';
        if (resolvedFormat === 'json') {
          return outcome;
        }
        const { renderPack } = await import('./pack.ts');
        const text = renderPack({
          home: '',
          budget,
          outcome,
          format: resolvedFormat,
        });
        return {
          budget,
          totalCost: outcome.totalCost,
          utilization: outcome.utilization,
          selectedCount: outcome.selected.length,
          contextText: text,
          outcome,
        };
      }),
  );

  server.tool(
    'primer',
    'Get concise, token-frugal guidance on Medha concepts, architecture, signals, guards, decisions, drift, config, or sync.',
    {
      topic: z
        .string()
        .optional()
        .describe(
          'Topic to view: overview, mental-model, signals, guards, decisions, drift, config, sync. If omitted, returns an overview and topic index.',
        ),
    },
    READ_ONLY,
    async ({ topic }) =>
      respond(async () => {
        const { getPrimer } = await import('./primer.ts');
        return getPrimer(topic);
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
