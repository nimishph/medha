/**
 * Medha TypeScript SDK: ergonomic client APIs for agent lifecycle, rule evaluation,
 * memory inspection, automated guard verification, and context pack generation.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  type Anchor,
  CANONICAL_SIGNALS,
  type Context,
  type ContextFilter,
  type ContextTargets,
  type EntityDefinition,
  type EntityKey,
  type EntityState,
  type EvidentialHint,
  type Gate,
  InvalidArgumentError,
  type KindSpec,
  type PackOutcome,
  type Pitfall,
  type PolicyLatchInput,
  type PolicyLatchOutcome,
  type PromotionPolicy,
  type Proposal,
  round6,
  type SignalSpec,
  type StorePort,
  type SyncPort,
  type TrajectoryEvidence,
} from '@cntxt-labs/medha-core';
import { FilePolicyStore, MemoryStore, SQLiteStore, scopeStore } from '@cntxt-labs/medha-store';
import {
  type EntityDetail,
  type ListFilter,
  Medha,
  type WritePermissionsPolicy,
} from './engine.ts';
import type { PreflightReport } from './maintenance.ts';
import type { UpdaterRegistry } from './updaters.ts';

/**
 * Options for opening or connecting a MedhaClient to an existing or custom store.
 */
export interface ClientOpenOptions {
  /** Directory containing .medha/ (or current working directory by default). */
  readonly dir?: string | undefined;
  /** Explicit path to a sqlite database or state file. */
  readonly path?: string | undefined;
  /** Custom home directory path (overriding .medha). */
  readonly home?: string | undefined;
  /** Explicit pre-configured store instance. */
  readonly store?: StorePort | undefined;
  /** Default actor/author identifier for recorded episodes. */
  readonly actor?: string | undefined;
  /** Custom clock returning milliseconds timestamp (defaults to Date.now). */
  readonly clock?: (() => number) | undefined;
  /** Custom updaters registry. */
  readonly updaters?: UpdaterRegistry | undefined;
  /** Custom promotion policy. */
  readonly promotionPolicy?: PromotionPolicy | undefined;
  /** Optional sync port. */
  readonly sync?: SyncPort | undefined;
  /** Optional permissions policy. */
  readonly permissions?: WritePermissionsPolicy | undefined;
}

/**
 * Options for initializing an ephemeral in-memory MedhaClient.
 */
export interface ClientMemoryOptions {
  /** Default actor/author identifier for recorded episodes. */
  readonly actor?: string | undefined;
  /** Custom clock returning milliseconds timestamp (defaults to Date.now). */
  readonly clock?: (() => number) | undefined;
  /** Custom updaters registry. */
  readonly updaters?: UpdaterRegistry | undefined;
  /** Custom promotion policy. */
  readonly promotionPolicy?: PromotionPolicy | undefined;
  /** Custom kinds to register. */
  readonly kinds?: readonly string[] | undefined;
  /** Custom kind specs to register. */
  readonly kindSpecs?: readonly KindSpec[] | undefined;
  /** Custom signals to register. */
  readonly signalSpecs?: readonly SignalSpec[] | undefined;
}

/**
 * Options for defining a rule or pattern in memory.
 */
export interface DefineRuleOptions {
  readonly namespace?: string | undefined;
  readonly pattern?: string | undefined;
  readonly contextTargets?: ContextTargets | undefined;
  readonly schema?: Record<string, unknown> | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly author?: string | undefined;
  /** Whether to ensure the entity exists in the store projection immediately. Default: true. */
  readonly ensure?: boolean | undefined;
}

/**
 * Options for recording a signal or evidence.
 */
export interface SignalOptions {
  readonly actor?: string | undefined;
  readonly author?: string | undefined;
  readonly note?: string | undefined;
  readonly runRef?: string | undefined;
  readonly anchors?: readonly Anchor[] | undefined;
  readonly caseId?: string | undefined;
  /** Whether to create the entity on probation if unknown. Default: true. */
  readonly ensure?: boolean | undefined;
}

/**
 * Options for retrieving packed context.
 */
export interface ClientPackOptions {
  readonly budget?: number | undefined;
  readonly kind?: string | undefined;
  readonly namespace?: string | undefined;
  readonly ids?: readonly string[] | undefined;
  readonly explorationRatio?: number | undefined;
  readonly seed?: number | undefined;
  readonly minTrust?: number | undefined;
  readonly allowQuarantined?: boolean | undefined;
  readonly allowRetired?: boolean | undefined;
}

/**
 * Options for generating an LLM prompt pack string.
 */
export interface ClientPackPromptOptions extends ClientPackOptions {
  readonly header?: string | undefined;
  readonly emptyFallback?: string | undefined;
}

/**
 * Outcome of automated guard execution.
 */
export interface VerifyGuardOutcome {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly hint: EvidentialHint;
  readonly lifted: boolean;
}

/**
 * Aggregated store and health status.
 */
export interface ClientStatusReport {
  readonly initialized: boolean;
  readonly totalEntities: number;
  readonly totalEpisodes: number;
  readonly activeCount: number;
  readonly probationCount: number;
  readonly trustedCount: number;
  readonly quarantinedCount: number;
  readonly retiredCount: number;
  readonly driftCount: number;
  readonly pitfallCount: number;
  readonly preflight: PreflightReport;
}

/**
 * Context filter for selective context-aware packing.
 */
export interface ClientContextFilter {
  readonly files?: readonly string[] | undefined;
  readonly languages?: readonly string[] | undefined;
  readonly query?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
}

/**
 * Configuration options for an AgentSession.
 */
export interface AgentSessionOptions {
  readonly runRef?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly contextFilter?: ClientContextFilter | undefined;
}

function normalizeSignalName(name: string): string {
  const upper = name.trim().toUpperCase().replace(/[- ]/g, '_');
  if (
    upper === 'RULE_APPLIED' ||
    upper === 'HINT_ACCEPTED' ||
    upper === 'APPLIED' ||
    upper === 'ACCEPT' ||
    upper === 'ACCEPTED'
  ) {
    return 'APPLY';
  }
  if (
    upper === 'RULE_REJECTED' ||
    upper === 'HINT_REJECTED' ||
    upper === 'REJECTED' ||
    upper === 'REJECT'
  ) {
    return 'REJECT_RULE';
  }
  if (upper === 'REJECT_CONTEXT') {
    return 'REJECT_CONTEXT';
  }
  if (upper === 'SKIP' || upper === 'SKIPPED') {
    return 'SKIP';
  }
  return upper;
}

/**
 * Parses a string or EntityKey into an EntityKey object.
 * Accepts:
 * - "kind:namespace/id"
 * - "kind:id" (namespace = "")
 * - "namespace/id" (kind = "rule")
 * - "id" (kind = "rule", namespace = "")
 */
export function parseEntityKey(input: EntityKey | string): EntityKey {
  if (typeof input !== 'string') {
    return input;
  }
  const raw = input.trim();
  const colonIndex = raw.indexOf(':');
  if (colonIndex !== -1) {
    const kind = raw.slice(0, colonIndex);
    const rest = raw.slice(colonIndex + 1);
    const slashIndex = rest.indexOf('/');
    if (slashIndex !== -1) {
      return {
        kind,
        namespace: rest.slice(0, slashIndex),
        id: rest.slice(slashIndex + 1),
      };
    }
    return {
      kind,
      namespace: '',
      id: rest,
    };
  }
  const slashIndex = raw.indexOf('/');
  if (slashIndex !== -1) {
    return {
      kind: 'rule',
      namespace: raw.slice(0, slashIndex),
      id: raw.slice(slashIndex + 1),
    };
  }
  return {
    kind: 'rule',
    namespace: '',
    id: raw,
  };
}

function findMedhaHome(startDir: string, override?: string | undefined): string | null {
  if (override !== undefined) {
    const resolved = resolve(startDir, override);
    return existsSync(resolved) ? resolved : null;
  }
  let curr = resolve(startDir);
  while (true) {
    const candidate = join(curr, '.medha');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = resolve(curr, '..');
    if (parent === curr) {
      break;
    }
    curr = parent;
  }
  return null;
}

function resolvePath(homeDir: string, targetPath: string): string {
  if (isAbsolute(targetPath)) {
    return targetPath;
  }
  return resolve(homeDir, targetPath);
}

/**
 * MedhaClient: The primary developer-facing TypeScript SDK client for Medha.
 */
export class MedhaClient {
  readonly engine: Medha;
  readonly defaultActor: string | undefined;
  private readonly clock: () => number;

  constructor(
    engine: Medha,
    options: {
      readonly actor?: string | undefined;
      readonly clock?: (() => number) | undefined;
    } = {},
  ) {
    this.engine = engine;
    this.defaultActor = options.actor;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Initialize an ephemeral in-memory Medha client.
   * Ideal for unit tests, transient agent memories, and evaluation scripts.
   */
  static async memory(options: ClientMemoryOptions = {}): Promise<MedhaClient> {
    const store = new MemoryStore({
      registries: {
        kinds: options.kinds ?? ['rule', 'recipe', 'tool'],
        signalSpecs: options.signalSpecs ?? CANONICAL_SIGNALS,
        anchorKinds: ['git', 'week'],
        ...(options.kindSpecs !== undefined ? { kindSpecs: options.kindSpecs } : {}),
      },
    });
    await store.open();
    const engine = new Medha({
      store,
      ...(options.updaters !== undefined ? { updaters: options.updaters } : {}),
      ...(options.promotionPolicy !== undefined
        ? { promotionPolicy: options.promotionPolicy }
        : {}),
    });
    return new MedhaClient(engine, {
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
  }

  /**
   * Connect to or open a Medha engine home.
   * Automatically discovers `.medha/config.json` starting at `dir` (or cwd),
   * or binds directly to a given database path or StorePort.
   */
  static async open(options: ClientOpenOptions = {}): Promise<MedhaClient> {
    if (options.store !== undefined) {
      const engine = new Medha({
        store: options.store,
        ...(options.updaters !== undefined ? { updaters: options.updaters } : {}),
        ...(options.promotionPolicy !== undefined
          ? { promotionPolicy: options.promotionPolicy }
          : {}),
        ...(options.sync !== undefined ? { sync: options.sync } : {}),
        ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
      });
      return new MedhaClient(engine, {
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
      });
    }

    if (
      options.path !== undefined &&
      (options.path.endsWith('.sqlite') || options.path.endsWith('.db'))
    ) {
      const store = new SQLiteStore({ path: options.path });
      await store.open();
      const engine = new Medha({
        store,
        ...(options.updaters !== undefined ? { updaters: options.updaters } : {}),
        ...(options.promotionPolicy !== undefined
          ? { promotionPolicy: options.promotionPolicy }
          : {}),
        ...(options.sync !== undefined ? { sync: options.sync } : {}),
        ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
      });
      return new MedhaClient(engine, {
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
      });
    }

    const startDir = options.dir ?? process.cwd();
    const homeDir = findMedhaHome(startDir, options.home);
    if (homeDir === null) {
      throw new InvalidArgumentError(
        'dir',
        'a directory containing a valid .medha configuration',
        startDir,
        {
          hint: "initialize one with 'medha init' or use MedhaClient.memory() for an ephemeral store",
        },
      );
    }

    const configPath = join(homeDir, 'config.json');
    if (!existsSync(configPath)) {
      throw new InvalidArgumentError(
        'configPath',
        'an existing config.json in the medha home',
        configPath,
      );
    }

    const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    const backend = rawConfig.backend ?? 'sqlite';
    let store: StorePort;

    if (backend === 'memory') {
      store = new MemoryStore(rawConfig.registries);
    } else if (backend === 'file') {
      const docPath = resolvePath(homeDir, rawConfig.path ?? 'state.jsonl');
      store = new FilePolicyStore({
        dir: homeDir,
        document: docPath,
        backup: `${docPath}.bak`,
        registries: rawConfig.registries,
      });
    } else {
      const dbPath = resolvePath(homeDir, rawConfig.path ?? 'store.sqlite');
      store = new SQLiteStore({
        path: dbPath,
        registries: rawConfig.registries,
      });
    }

    if (
      rawConfig.namespaceScope !== undefined &&
      Array.isArray(rawConfig.namespaceScope) &&
      rawConfig.namespaceScope.length > 0
    ) {
      store = scopeStore(store, rawConfig.namespaceScope);
    }

    await store.open();
    const engine = new Medha({
      store,
      ...(options.updaters !== undefined ? { updaters: options.updaters } : {}),
      ...(options.promotionPolicy !== undefined
        ? { promotionPolicy: options.promotionPolicy }
        : {}),
      ...(options.sync !== undefined ? { sync: options.sync } : {}),
      ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    });

    return new MedhaClient(engine, {
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
  }

  /**
   * Wrap an existing Medha engine instance in a client.
   */
  static fromEngine(
    engine: Medha,
    options: {
      readonly actor?: string | undefined;
      readonly clock?: (() => number) | undefined;
    } = {},
  ): MedhaClient {
    return new MedhaClient(engine, options);
  }

  /** Current time in ms according to client clock. */
  now(): number {
    return this.clock();
  }

  /** Underlying storage port. */
  get store(): StorePort {
    return this.engine.store;
  }

  /** Parse any string or EntityKey into an EntityKey. */
  parseKey(key: EntityKey | string): EntityKey {
    return parseEntityKey(key);
  }

  private context(): Context {
    return { now: this.now() };
  }

  /**
   * Define a new rule or pattern entity with metadata and context targets.
   */
  async defineRule(
    id: string,
    description: string,
    options: DefineRuleOptions = {},
  ): Promise<EntityDefinition> {
    const key = parseEntityKey({
      kind: 'rule',
      namespace: options.namespace ?? '',
      id,
    });
    const definition: EntityDefinition = {
      title: id,
      rationale: description,
      ...(options.contextTargets !== undefined ? { contextTargets: options.contextTargets } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
    };
    const author = options.author ?? this.defaultActor;
    await this.engine.define(
      key,
      definition,
      this.context(),
      author !== undefined ? { author } : {},
    );
    if (options.ensure !== false) {
      await this.engine.record(key, 'APPLY', this.context(), {
        ensure: true,
        ...(author !== undefined ? { author } : {}),
        note: 'Initial definition',
      });
    }
    return definition;
  }

  /**
   * Attach a formal definition to an entity key.
   */
  async define(
    key: EntityKey | string,
    definition: EntityDefinition,
    options: { readonly author?: string | undefined } = {},
  ): Promise<void> {
    const author = options.author ?? this.defaultActor;
    await this.engine.define(
      this.parseKey(key),
      definition,
      this.context(),
      author !== undefined ? { author } : {},
    );
  }

  /**
   * Get an entity state by key.
   */
  async get(key: EntityKey | string): Promise<EntityState | undefined> {
    return this.engine.store.get(this.parseKey(key));
  }

  /**
   * Inspect an entity's trust score, status, thresholds, and evidence breakdown.
   */
  async show(key: EntityKey | string): Promise<EntityDetail> {
    return this.engine.show(this.parseKey(key), this.context());
  }

  /**
   * List entity states in the store.
   */
  async list(): Promise<readonly EntityState[]> {
    return this.engine.store.list();
  }

  /**
   * List evidential hints matching an optional filter.
   */
  async listHints(filter: ListFilter = {}): Promise<readonly EvidentialHint[]> {
    const page = await this.engine.list(filter, this.context());
    return page.items;
  }

  /**
   * Record an empirical signal into memory.
   */
  async recordSignal(
    key: EntityKey | string,
    signal: string,
    options: SignalOptions = {},
  ): Promise<EvidentialHint> {
    const parsedKey = this.parseKey(key);
    const resolvedSignal = normalizeSignalName(signal);
    const author = options.author ?? options.actor ?? this.defaultActor;
    const res = await this.engine.record(parsedKey, resolvedSignal, this.context(), {
      ensure: options.ensure ?? true,
      ...(author !== undefined ? { author } : {}),
      ...(options.runRef !== undefined ? { runRef: options.runRef } : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
      ...(options.anchors !== undefined && options.anchors.length > 0
        ? { anchor: options.anchors[0] }
        : {}),
      ...(options.caseId !== undefined ? { caseId: options.caseId } : {}),
    });
    return res.hint;
  }

  /**
   * Record positive empirical feedback: an agent applied or followed the entity.
   */
  async recordAcceptance(
    key: EntityKey | string,
    options: SignalOptions = {},
  ): Promise<EvidentialHint> {
    return this.recordSignal(key, 'APPLY', options);
  }

  /**
   * Record negative empirical feedback: an agent or user rejected the entity.
   */
  async recordRejection(
    key: EntityKey | string,
    options: SignalOptions = {},
  ): Promise<EvidentialHint> {
    return this.recordSignal(key, 'REJECT_RULE', options);
  }

  /**
   * Record an automated test or check guard outcome into evidential memory.
   */
  async recordGuard(input: {
    readonly key: EntityKey | string;
    readonly ok: boolean;
    readonly guard?: string | undefined;
    readonly author?: string | undefined;
    readonly note?: string | undefined;
    readonly runRef?: string | undefined;
  }): Promise<EvidentialHint> {
    const parsedKey = this.parseKey(input.key);
    const author = input.author ?? this.defaultActor;
    return this.engine.reportGuard(
      parsedKey,
      {
        ok: input.ok,
        ...(input.guard !== undefined ? { kind: input.guard } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.runRef !== undefined ? { runRef: input.runRef } : {}),
      },
      this.context(),
    );
  }

  /**
   * Run a shell command to verify a guard, automatically recording the outcome into memory.
   */
  async verifyGuard(
    guardKey: EntityKey | string,
    command: string,
    options: {
      readonly cwd?: string | undefined;
      readonly author?: string | undefined;
      readonly note?: string | undefined;
      readonly guard?: string | undefined;
      readonly timeoutMs?: number | undefined;
    } = {},
  ): Promise<VerifyGuardOutcome> {
    const key = this.parseKey(guardKey);
    const guardName = options.guard ?? key.id;
    const res = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 30000,
    });
    const passed = res.status === 0;
    const author = options.author ?? this.defaultActor;
    const note =
      options.note ??
      `verify_guard: ${command} (${passed ? 'passed' : `failed exit ${res.status ?? -1}`})`;
    const hint = await this.recordGuard({
      key,
      ok: passed,
      guard: guardName,
      ...(author !== undefined ? { author } : {}),
      note,
    });
    return {
      passed,
      exitCode: res.status ?? -1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      hint,
      lifted: passed && hint.status !== 'quarantined',
    };
  }

  /**
   * Retrieve a deterministic evidential pack of entities fitting within a token budget.
   */
  async pack(options: ClientPackOptions = {}): Promise<PackOutcome> {
    return this.engine.pack(
      {
        budget: options.budget ?? 2000,
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
        ...(options.ids !== undefined ? { ids: options.ids } : {}),
        ...(options.explorationRatio !== undefined
          ? { explorationRatio: options.explorationRatio }
          : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.minTrust !== undefined ? { minTrust: options.minTrust } : {}),
        ...(options.allowQuarantined !== undefined
          ? { allowQuarantined: options.allowQuarantined }
          : {}),
        ...(options.allowRetired !== undefined ? { allowRetired: options.allowRetired } : {}),
      },
      this.context(),
    );
  }

  /**
   * Retrieve evidential context formatted as a markdown prompt section ready to inject into LLMs.
   */
  async packPrompt(options: ClientPackPromptOptions = {}): Promise<string> {
    const outcome = await this.pack(options);
    if (outcome.selected.length === 0) {
      return options.emptyFallback ?? '';
    }
    const lines: string[] = [];
    lines.push(options.header ?? '### Evidential Memory & Guiding Rules');
    lines.push('The following guiding patterns and rules have empirical backing:');
    for (const item of outcome.selected) {
      const ns = item.key.namespace.length > 0 ? `${item.key.namespace}/` : '';
      const keyStr = `${item.key.kind}:${ns}${item.key.id}`;
      const trustStr =
        item.hint !== undefined
          ? `trust: ${round6(item.hint.trustScore).toFixed(2)}, status: ${item.hint.status}`
          : '';
      lines.push(`- [${keyStr}] (${trustStr})`);
    }
    return lines.join('\n');
  }

  /**
   * Query rules and hints matching context targets (active files, languages, keywords).
   */
  async hintsForContext(
    filter: ClientContextFilter,
    options: {
      readonly budget?: number | undefined;
      readonly kind?: string | undefined;
      readonly namespace?: string | undefined;
    } = {},
  ): Promise<PackOutcome> {
    const query =
      filter.query ??
      (filter.keywords !== undefined && filter.keywords.length > 0
        ? filter.keywords.join(' ')
        : undefined);
    const contextFilter: ContextFilter = {
      ...(filter.files !== undefined ? { files: filter.files } : {}),
      ...(filter.languages !== undefined ? { languages: filter.languages } : {}),
      ...(query !== undefined ? { query } : {}),
    };
    return this.engine.hintsForContext(
      contextFilter,
      {
        ...(options.budget !== undefined ? { budget: options.budget } : {}),
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
      },
      this.context(),
    );
  }

  /**
   * Detect anti-patterns and high-failure traps via negative-evidence radar.
   */
  async detectPitfalls(
    options: {
      readonly kind?: string | undefined;
      readonly namespace?: string | undefined;
      readonly minFailures?: number | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<readonly Pitfall[]> {
    return this.engine.detectPitfalls(
      {
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
        ...(options.minFailures !== undefined ? { minFailures: options.minFailures } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
      this.context(),
    );
  }

  /**
   * Distill patterns from an execution trajectory.
   */
  async distill(
    trajectory: TrajectoryEvidence,
    options: { readonly autoFile?: boolean | undefined } = {},
  ): Promise<{ readonly proposals: readonly Proposal[]; readonly filedCount: number }> {
    return this.engine.distillTrajectory(
      trajectory,
      {
        ...(options.autoFile !== undefined ? { autoFile: options.autoFile } : {}),
      },
      this.context(),
    );
  }

  /**
   * Evaluate convergence gates for an entity.
   */
  async evaluateGates(key: EntityKey | string): Promise<readonly Gate[] | undefined> {
    const rep = await this.show(key);
    return rep.gates;
  }

  /**
   * PolicyLatch (medha-534):
   * Regulated agent compliance & human gatekeeper via decision trees and requireHumanFor.
   */
  async policyLatch(
    input: Omit<PolicyLatchInput, 'key'> & { readonly key: EntityKey | string },
    options: { readonly now?: number | undefined } = {},
  ): Promise<PolicyLatchOutcome> {
    const key = typeof input.key === 'string' ? this.parseKey(input.key) : input.key;
    const ctx =
      options.now !== undefined ? { ...this.context(), now: options.now } : this.context();
    return this.engine.policyLatch({ ...input, key }, ctx);
  }

  /**
   * Aggregate overall store status, health, and distribution.
   */
  async status(): Promise<ClientStatusReport> {
    const ctx = this.context();
    const preflight = await this.engine.preflight(ctx);
    const states = await this.engine.store.list();
    let activeCount = 0;
    let probationCount = 0;
    let trustedCount = 0;
    let quarantinedCount = 0;
    let retiredCount = 0;
    let driftCount = 0;

    for (const state of states) {
      const rep = await this.engine.show(state.key, ctx);
      switch (rep.hint.status) {
        case 'active':
          activeCount++;
          break;
        case 'probation':
          probationCount++;
          break;
        case 'trusted':
          trustedCount++;
          break;
        case 'quarantined':
          quarantinedCount++;
          break;
        case 'retired':
          retiredCount++;
          break;
      }
      if (rep.hint.temporal.isDrifting) {
        driftCount++;
      }
    }

    const pitfalls = await this.detectPitfalls();

    return {
      initialized: preflight.status === 'ok',
      totalEntities: states.length,
      totalEpisodes: preflight.episodeCount,
      activeCount,
      probationCount,
      trustedCount,
      quarantinedCount,
      retiredCount,
      driftCount,
      pitfallCount: pitfalls.length,
      preflight,
    };
  }

  /**
   * Create an agent-scoped session client.
   */
  session(agentId: string, options: AgentSessionOptions = {}): AgentSession {
    return new AgentSession(this, agentId, options);
  }
}

/**
 * AgentSession: Scoped agent workflow client.
 * Automatically attaches agent authorship, run references, and contextual tagging.
 */
export class AgentSession {
  readonly client: MedhaClient;
  readonly agentId: string;
  readonly runRef?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly defaultFilter?: ClientContextFilter | undefined;

  constructor(client: MedhaClient, agentId: string, options: AgentSessionOptions = {}) {
    this.client = client;
    this.agentId = agentId;
    this.runRef = options.runRef;
    this.tags = options.tags;
    this.defaultFilter = options.contextFilter;
  }

  /** Query hints matching active context targets. */
  async hintsForContext(filter?: ClientContextFilter | undefined): Promise<PackOutcome> {
    const effective = filter ?? this.defaultFilter ?? {};
    return this.client.hintsForContext(effective);
  }

  /** Retrieve packed context within budget. */
  async pack(options: ClientPackOptions = {}): Promise<PackOutcome> {
    return this.client.pack(options);
  }

  /** Format packed rules as LLM prompt section. */
  async packPrompt(options: ClientPackPromptOptions = {}): Promise<string> {
    return this.client.packPrompt(options);
  }

  /** Record rule acceptance. */
  async accept(key: EntityKey | string, note?: string | undefined): Promise<EvidentialHint> {
    return this.client.recordAcceptance(key, {
      actor: this.agentId,
      ...(this.runRef !== undefined ? { runRef: this.runRef } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  /** Record rule rejection. */
  async reject(key: EntityKey | string, note?: string | undefined): Promise<EvidentialHint> {
    return this.client.recordRejection(key, {
      actor: this.agentId,
      ...(this.runRef !== undefined ? { runRef: this.runRef } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  /** Record arbitrary empirical signal. */
  async recordSignal(
    key: EntityKey | string,
    signal: string,
    note?: string | undefined,
  ): Promise<EvidentialHint> {
    return this.client.recordSignal(key, signal, {
      actor: this.agentId,
      ...(this.runRef !== undefined ? { runRef: this.runRef } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  /** Record an automated guard test result. */
  async recordGuard(
    guard: string,
    passed: boolean,
    key?: EntityKey | string | undefined,
    note?: string | undefined,
  ): Promise<EvidentialHint> {
    const targetKey = key ?? { kind: 'rule', namespace: '', id: guard };
    return this.client.recordGuard({
      key: targetKey,
      ok: passed,
      guard,
      author: this.agentId,
      ...(this.runRef !== undefined ? { runRef: this.runRef } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  /** Execute a shell command to verify a guard. */
  async verifyGuard(
    guardKey: EntityKey | string,
    command: string,
    options: {
      readonly cwd?: string | undefined;
      readonly timeoutMs?: number | undefined;
      readonly note?: string | undefined;
    } = {},
  ): Promise<VerifyGuardOutcome> {
    return this.client.verifyGuard(guardKey, command, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
      author: this.agentId,
    });
  }

  /** Distill patterns from a trajectory under this agent's identity. */
  async distill(
    trajectory: TrajectoryEvidence,
  ): Promise<{ readonly proposals: readonly Proposal[]; readonly filedCount: number }> {
    return this.client.distill(trajectory, { autoFile: true });
  }

  /** Check regulated policy compliance and human gatekeeper rules under this agent's identity. */
  async policyLatch(
    input: Omit<PolicyLatchInput, 'key' | 'author'> & {
      readonly key: EntityKey | string;
      readonly author?: string | undefined;
    },
  ): Promise<PolicyLatchOutcome> {
    return this.client.policyLatch({
      ...input,
      author: input.author ?? `agent:${this.agentId}`,
    });
  }
}
