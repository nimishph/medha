/**
 * The `Sage` engine facade — read plane (§6.1), write plane (§6.2) and the reference exploration
 * helper (§6.3), over any `StorePort` backend.
 *
 * Every call takes an injected context (`{ now, seed? }`); time and randomness are never read
 * ambiently, so the same episodes + context replay byte-identically. The read plane is pure and
 * in-memory (batch operations read the index once); `simulate` never persists. The write plane
 * appends unambiguously *episodes* — the log is the source of truth — and returns the hint the
 * mutation produced. `propose`/`mine` (the MinerPort flow) land in Loom-ujs3.9, not here.
 */

import {
  type Anchor,
  buildHint,
  type Context,
  type CorruptLocation,
  convergingSourcesPolicy,
  DAY_MS,
  type EntityKey,
  type EntityState,
  type Episode,
  type EpisodeInput,
  type EvidentialHint,
  entityKeyString,
  foldEpisode,
  freshState,
  InvalidArgumentError,
  InvariantViolationError,
  KindRegistry,
  type LifecycleStatus,
  type MinerPort,
  mulberry32,
  type OpenResult,
  type Page,
  type PageRequest,
  type PromotionContext,
  type PromotionDecision,
  type PromotionPolicy,
  type Proposal,
  type ProposalEpisode,
  paginate,
  resolveProposalKey,
  round6,
  type SageError,
  SignalRegistry,
  type SignalSpec,
  type StorePort,
  sanitizeContext,
  validateSignalSpec,
  wilsonWidth,
} from '@sutras/sage-core';
import { CorruptStoreError } from '@sutras/sage-store';
import {
  type CompactionReport,
  compactPrefix,
  DEFAULT_FOLD_DAYS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SWEEP_INTERVAL_MS,
  LAST_SWEEP_META_KEY,
  type PreflightReport,
  planSweep,
  resolveSweepOption,
  type SageSnapshot,
  type SessionOpenResult,
  SNAPSHOT_FORMAT,
  type SweepActionKind,
  type SweepChange,
  type SweepOptions,
  type SweepReport,
  statesEquivalent,
} from './maintenance.ts';
import { UpdaterRegistry, type WeightUpdateContext } from './updaters.ts';

export interface SageOptions {
  readonly store: StorePort;
  readonly updaters?: UpdaterRegistry | undefined;
  readonly promotionPolicy?: PromotionPolicy | undefined;
}

/** Build every number the updaters see from the entity state + the incoming signal. */
function buildWeightContext(state: EntityState, spec: SignalSpec): WeightUpdateContext {
  const { evidence, ema } = state;
  return {
    key: state.key,
    currentWeight: ema.mu,
    initialWeight: ema.theta0,
    signal: spec,
    sampleCount: evidence.n,
    acceptanceCount: evidence.k,
    contextRejectCount: evidence.contextRejects,
    rejectRuleCount: evidence.n - evidence.k,
    parameters: { ...ema },
  };
}

function compareKeyString(a: { readonly key: EntityKey }, b: { readonly key: EntityKey }): number {
  const s1 = entityKeyString(a.key);
  const s2 = entityKeyString(b.key);
  return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
}

export class Sage {
  readonly store: StorePort;
  readonly updaters: UpdaterRegistry;
  readonly promotionPolicy: PromotionPolicy;
  /** The last `store.open()` result, retained so maintenance can report a corrupt location. */
  private openResult: OpenResult | undefined;

  constructor(options: SageOptions) {
    this.store = options.store;
    this.updaters = options.updaters ?? new UpdaterRegistry();
    this.promotionPolicy = options.promotionPolicy ?? convergingSourcesPolicy({ minSources: 2 });
  }

  // -------------------------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------------------------

  private async ensureOpen(): Promise<OpenResult> {
    if (this.openResult === undefined) this.openResult = await this.store.open();
    return this.openResult;
  }

  private assertMaintainable(location: CorruptLocation): void {
    throw new CorruptStoreError(
      location,
      `Cannot maintain corrupt store: log is unrecoverable from seq ${location.atSeq}`,
    );
  }

  private kindRegistry(): KindRegistry {
    return new KindRegistry(this.store.registries.kinds);
  }

  private signalRegistry(): SignalRegistry {
    return new SignalRegistry(this.store.registries.signalSpecs);
  }

  /** Unknown kinds fail loud, naming the registered ones (spec §5.2). */
  private requireKind(key: EntityKey): void {
    this.kindRegistry().requireKnown(key.kind);
  }

  /** Resolve `signal`: a name, or a validated spec whose (registered) name resolves. */
  private resolveSignal(signal: string | SignalSpec): SignalSpec {
    const registry = this.signalRegistry();
    if (typeof signal === 'string') return registry.resolve(signal);
    validateSignalSpec(signal);
    return registry.resolve(signal.name);
  }

  private validateKey(key: EntityKey): void {
    if (typeof key !== 'object' || key === null) {
      throw new InvalidArgumentError('key', 'an EntityKey object', key);
    }
  }

  async close(): Promise<void> {
    await this.store.close();
    this.openResult = undefined;
  }

  // -------------------------------------------------------------------------------------------
  // read plane (§6.1)
  // -------------------------------------------------------------------------------------------

  /**
   * Batch hints, pure in-memory: the entity index is read once and focused down to the requested
   * keys — no per-key I/O. Unknown keys are simply absent (probing the unknown is explore's job).
   */
  async hints(keys: readonly EntityKey[], context: Context): Promise<Map<string, EvidentialHint>> {
    sanitizeContext(context);
    await this.ensureOpen();
    for (const key of keys) this.validateKey(key);
    const kinds = new KindRegistry(this.store.registries.kinds);
    const states = await this.store.list();
    const index = new Map(states.map((state) => [entityKeyString(state.key), state]));
    const out = new Map<string, EvidentialHint>();
    for (const key of keys) {
      kinds.requireKnown(key.kind);
      const keyString = entityKeyString(key);
      const state = index.get(keyString);
      if (state !== undefined) out.set(keyString, buildHint(state, context.now));
    }
    return out;
  }

  /** By kind, status, namespace, or drift — paginated, ordered by trust desc. */
  async list(
    filter: ListFilter,
    context: Context,
    page?: PageRequest,
  ): Promise<Page<EvidentialHint>> {
    sanitizeContext(context);
    await this.ensureOpen();
    if (filter.kind !== undefined) this.kindRegistry().requireKnown(filter.kind);
    const states = await this.store.list();
    const sorted = states
      .map((state) => buildHint(state, context.now))
      .filter(
        (hint) =>
          (filter.kind === undefined || hint.key.kind === filter.kind) &&
          (filter.status === undefined || hint.status === filter.status) &&
          (filter.namespace === undefined || hint.key.namespace === filter.namespace) &&
          (filter.drifting === undefined || hint.temporal.isDrifting === filter.drifting),
      )
      .sort((a, b) => b.trustScore - a.trustScore || compareKeyString(a, b));
    return paginate(sorted, page);
  }

  /** The hint plus the entity's recent episodes and provenance (spec §5.4, §6.1). */
  async show(
    key: EntityKey,
    context: Context,
    options: { readonly recent?: number } = {},
  ): Promise<EntityDetail> {
    sanitizeContext(context);
    await this.ensureOpen();
    this.validateKey(key);
    this.requireKind(key);
    if (
      options.recent !== undefined &&
      (!Number.isSafeInteger(options.recent) || options.recent < 1)
    ) {
      throw new InvalidArgumentError('options.recent', 'a positive integer', options.recent);
    }
    const keyString = entityKeyString(key);
    const [state, log] = await Promise.all([this.store.get(key), this.store.episodes()]);
    const episodes = log.filter((episode) => entityKeyString(episode.key) === keyString);
    const recentN = options.recent ?? 10;
    const recentEpisodes = [...episodes].sort((a, b) => b.seq - a.seq).slice(0, recentN);
    const proposalEpisodes = episodes.filter(
      (episode): episode is Extract<Episode, { type: 'proposal' }> => episode.type === 'proposal',
    );
    const provenance = [...new Set(proposalEpisodes.map((episode) => episode.provenance))];
    const promoted = proposalEpisodes.some((episode) => episode.promoted === true);
    if (state === undefined) {
      // Spec §5.2: an unknown id reads back as a probation hint with the prior.
      return {
        hint: buildHint(freshState(key, context.now), context.now),
        known: false,
        recentEpisodes,
        provenance,
        promoted,
      };
    }
    return {
      hint: buildHint(state, context.now),
      known: true,
      recentEpisodes,
      provenance,
      promoted,
    };
  }

  /** Every entity currently drifting, most drifted first. */
  async drift(context: Context, options: { readonly limit?: number } = {}): Promise<DriftReport> {
    sanitizeContext(context);
    await this.ensureOpen();
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1)
    ) {
      throw new InvalidArgumentError('options.limit', 'a positive integer', options.limit);
    }
    const states = await this.store.list();
    const drifting = states
      .map((state) => buildHint(state, context.now))
      .filter((hint) => hint.temporal.isDrifting)
      .map((hint): DriftEntry => ({ key: hint.key, delta: hint.temporal.driftDelta, hint }))
      .sort((a, b) => b.delta - a.delta || compareKeyString(a, b));
    const limitApplied = options.limit ?? drifting.length;
    return {
      asOf: context.now,
      count: drifting.length,
      limitApplied,
      drifting: drifting.slice(0, limitApplied),
    };
  }

  /** What-if: the delta a signal would produce. Pure — nothing is appended. */
  async simulate(
    key: EntityKey,
    signal: string | SignalSpec,
    context: Context,
  ): Promise<HintDelta> {
    sanitizeContext(context);
    await this.ensureOpen();
    this.validateKey(key);
    this.requireKind(key);
    const spec = this.resolveSignal(signal);
    const state = await this.store.get(key);
    const base = state ?? freshState(key, context.now);
    const before = buildHint(base, context.now);
    const hypothetical: Episode = {
      type: 'signal',
      seq: 0,
      key,
      at: context.now,
      spec,
      ensure: true,
    };
    const afterState = foldEpisode(base, hypothetical) ?? base;
    const after = buildHint(afterState, context.now);
    return {
      key,
      asOf: context.now,
      before,
      after,
      deltaTrust: round6(after.trustScore - before.trustScore),
      statusChanged: after.status !== before.status,
    };
  }

  /**
   * Reference exploration helper (§6.3): reserve up to `slots` for probation entities chosen by
   * seeded sampling weighted by Wilson-interval width (the least-known tried soonest), then fill
   * the rest by merit (trust desc). Deterministic for a given seed; the host owns the policy.
   */
  async explore(
    candidates: readonly EntityKey[],
    policy: ExplorePolicy,
    context: Context,
  ): Promise<Candidate[]> {
    sanitizeContext(context);
    if (!Number.isSafeInteger(policy.slots) || policy.slots < 0) {
      throw new InvalidArgumentError('policy.slots', 'a non-negative integer', policy.slots);
    }
    const seed = policy.seed ?? context.seed;
    if (seed === undefined) {
      throw new InvalidArgumentError(
        'policy.seed',
        'a non-negative integer (or seed the context)',
        seed,
      );
    }
    await this.ensureOpen();
    for (const key of candidates) this.validateKey(key);
    if (candidates.length === 0 || policy.slots === 0) return [];

    const hints = await this.hints(candidates, context);
    const entries = candidates
      .map((key) => ({ key, hint: hints.get(entityKeyString(key)) }))
      .filter(
        (entry): entry is { readonly key: EntityKey; readonly hint: EvidentialHint } =>
          entry.hint !== undefined,
      );
    if (entries.length === 0) return [];

    const probation = entries
      .filter((entry) => entry.hint.status === 'probation')
      .sort(compareKeyString);
    const merit = entries
      .filter((entry) => entry.hint.status !== 'probation')
      .sort((a, b) => b.hint.trustScore - a.hint.trustScore || compareKeyString(a, b));

    const rng = mulberry32(seed);
    const slotsForProbation = Math.min(policy.slots, probation.length);
    const picked = pickWeighted(probation, uncertaintyOf, rng, slotsForProbation);
    const remaining = policy.slots - picked.length;

    return [
      ...picked.map(
        (entry): Candidate => ({
          ...entry,
          uncertainty: uncertaintyOf(entry),
          admittedBy: 'probation',
        }),
      ),
      ...merit.slice(0, remaining).map(
        (entry): Candidate => ({
          ...entry,
          uncertainty: uncertaintyOf(entry),
          admittedBy: 'merit',
        }),
      ),
    ];
  }

  // -------------------------------------------------------------------------------------------
  // maintenance plane (§6.4)
  // -------------------------------------------------------------------------------------------

  /**
   * The session-start sweep (§8). Cheap by design: a last-sweep marker (default once per 24 h,
   * `sweepEvery` overridable) means most opens do nothing. When it runs it folds episodes older
   * than `olderThan` days, then records every lifecycle decision (drift → quarantine, stale →
   * retire, retention → archive + purge) as an episode and reports each. A sweep that is skipped
   * says why.
   */
  async open(context: Context, options: SweepOptions = {}): Promise<SessionOpenResult> {
    sanitizeContext(context);
    const sweepEvery = resolveSweepOption(
      'sweepEvery',
      options.sweepEvery,
      DEFAULT_SWEEP_INTERVAL_MS,
    );
    const retentionDays = resolveSweepOption(
      'retentionDays',
      options.retentionDays,
      DEFAULT_RETENTION_DAYS,
    );
    const olderThanDays = resolveSweepOption('olderThan', options.olderThan, DEFAULT_FOLD_DAYS);
    const opened = await this.ensureOpen();

    if (opened.status === 'corrupt') {
      return { skipped: 'store-corrupt', asOf: context.now, location: opened.location };
    }

    const lastSweepRaw = await this.store.getMeta(LAST_SWEEP_META_KEY);
    if (lastSweepRaw !== undefined) {
      const lastSweep = Number(lastSweepRaw);
      if (Number.isFinite(lastSweep) && context.now - lastSweep < sweepEvery) {
        return {
          skipped: 'within-interval',
          asOf: context.now,
          lastSweep,
          dueAt: lastSweep + sweepEvery,
        };
      }
    }

    const compact = await this.runCompaction(context.now, olderThanDays);
    const steps = planSweep(await this.store.list(), context.now, {
      retentionMs: retentionDays * DAY_MS,
    });
    const changes: SweepChange[] = [];
    for (const step of steps) {
      const appended = await this.store.append({
        type: 'sweep',
        key: step.key,
        at: context.now,
        action: step.action,
        reason: step.reason,
      });
      changes.push({
        seq: appended.episode.seq,
        action: step.action,
        key: step.key,
        reason: step.reason,
        at: context.now,
      });
    }

    await this.store.setMeta(LAST_SWEEP_META_KEY, String(context.now));
    return this.buildSweepReport(context.now, retentionDays, olderThanDays, compact, changes);
  }

  /**
   * Explicit episode compaction: fold everything older than `olderThan` days (default 90) into
   * per-entity baselines. The report names the compacted range — the recomputability the fold
   * consumes — and the projection after compaction is verified to equal the one before.
   */
  async compact(
    context: Context,
    options: { readonly olderThan?: number } = {},
  ): Promise<CompactionReport> {
    sanitizeContext(context);
    const olderThanDays = resolveSweepOption('olderThan', options.olderThan, DEFAULT_FOLD_DAYS);
    const opened = await this.ensureOpen();
    if (opened.status === 'corrupt') {
      this.assertMaintainable(opened.location);
    }
    const cutoffAt = context.now - olderThanDays * DAY_MS;
    const log = await this.store.episodes();
    const compacted = compactPrefix(log, cutoffAt);
    const entities = (await this.store.list()).length;
    if (compacted.folded === null) {
      return {
        asOf: context.now,
        olderThanDays,
        cutoffAt,
        compacted: null,
        baselinesWritten: 0,
        remainingEpisodes: log.length,
        entities,
      };
    }

    const before = await this.store.list();
    await this.store.replaceLog(compacted.episodes);
    const after = await this.store.list();
    if (!statesEquivalent(before, after)) {
      throw new InvariantViolationError('compact', {
        context: { folded: compacted.folded, olderThanDays },
      });
    }
    return {
      asOf: context.now,
      olderThanDays,
      cutoffAt,
      compacted: compacted.folded,
      baselinesWritten: compacted.baselinesWritten,
      remainingEpisodes: compacted.episodes.length,
      entities: after.length,
    };
  }

  /**
   * Diagnostic read over the store (§9 `maintain preflight`): open status, log/entity counts,
   * fold-equivalence and the last-sweep marker. Never mutates and never throws for a bad store —
   * it reports, which is its whole job.
   */
  async preflight(context: Context): Promise<PreflightReport> {
    sanitizeContext(context);
    const opened = await this.ensureOpen();
    const status = opened.status;
    const location = opened.status === 'corrupt' ? opened.location : null;
    const episodes = await this.store.episodes();
    const list = await this.store.list();
    const rebuild = await this.store.rebuild();
    const lastSweepRaw = await this.store.getMeta(LAST_SWEEP_META_KEY);
    const lastSweep = lastSweepRaw === undefined ? null : Number(lastSweepRaw) || null;
    return {
      asOf: context.now,
      status,
      location: status === 'corrupt' ? location : null,
      episodeCount: episodes.length,
      entityCount: list.length,
      integrity: statesEquivalent(list, rebuild) ? 'ok' : 'fold-mismatch',
      lastSweep,
      registries: {
        kinds: this.store.registries.kinds.length,
        signals: this.store.registries.signalSpecs.length,
        anchors: this.store.registries.anchorKinds.length,
      },
    };
  }

  /**
   * Capture the store's source of truth as a portable, JSON-serialisable snapshot. The host owns
   * persisting it. `backup(context)` uses `context.now` only to stamp a deterministic
   * `exportedAt`; restore never reads it, so a wall-clock fallback stays fold-neutral.
   */
  async backup(context?: Context): Promise<{ readonly snapshot: SageSnapshot }> {
    if (context !== undefined) sanitizeContext(context);
    await this.ensureOpen();
    const [episodes, lastSweep] = await Promise.all([
      this.store.episodes(),
      this.store.getMeta(LAST_SWEEP_META_KEY),
    ]);
    const meta = lastSweep === undefined ? {} : { [LAST_SWEEP_META_KEY]: lastSweep };
    return {
      snapshot: {
        format: SNAPSHOT_FORMAT,
        exportedAt: context?.now ?? Date.now(),
        registries: this.store.registries,
        episodes,
        meta,
      },
    };
  }

  /**
   * Restore a snapshot: atomically replace the episode log (validated contiguous, against this
   * store's registries) and the engine meta it carries. Returns the seq range that was replaced.
   * Accept only snapshots this build wrote — `format` is checked, mismatched registries fail loud.
   */
  async restore(
    source: SageSnapshot,
  ): Promise<{ readonly restored: { from: number; to: number } }> {
    const opened = await this.ensureOpen();
    if (opened.status === 'corrupt') {
      this.assertMaintainable(opened.location);
    }
    this.validateSnapshot(source);
    const restored = await this.store.replaceLog(source.episodes);
    for (const [key, value] of Object.entries(source.meta)) {
      await this.store.setMeta(key, value);
    }
    return { restored };
  }

  private validateSnapshot(source: SageSnapshot): void {
    if (typeof source !== 'object' || source === null) {
      throw new InvalidArgumentError('source', 'a SageSnapshot', source);
    }
    if (source.format !== SNAPSHOT_FORMAT) {
      throw new InvalidArgumentError('source.format', `'${SNAPSHOT_FORMAT}'`, source.format);
    }
    if (typeof source.exportedAt !== 'number' || !Number.isFinite(source.exportedAt)) {
      throw new InvalidArgumentError('source.exportedAt', 'a finite epoch', source.exportedAt);
    }
    if (!Array.isArray(source.episodes)) {
      throw new InvalidArgumentError('source.episodes', 'an episode array', source.episodes);
    }
    if (typeof source.meta !== 'object' || source.meta === null || Array.isArray(source.meta)) {
      throw new InvalidArgumentError('source.meta', 'a record of strings', source.meta);
    }
    const registries = source.registries;
    if (
      typeof registries !== 'object' ||
      registries === null ||
      !Array.isArray(registries.kinds) ||
      !Array.isArray(registries.signalSpecs) ||
      !Array.isArray(registries.anchorKinds)
    ) {
      throw new InvalidArgumentError('source.registries', 'a StoreRegistries object', registries);
    }
  }

  /** Run one episode compaction pass; used by both `open` (self-cleaning) and `compact` (explicit). */
  private async runCompaction(now: number, olderThanDays: number): Promise<SweepReport['compact']> {
    const cutoffAt = now - olderThanDays * DAY_MS;
    const log = await this.store.episodes();
    const compacted = compactPrefix(log, cutoffAt);
    if (compacted.folded === null) {
      return { folded: null, baselinesWritten: 0, remainingEpisodes: log.length };
    }
    const before = await this.store.list();
    await this.store.replaceLog(compacted.episodes);
    const after = await this.store.list();
    if (!statesEquivalent(before, after)) {
      throw new InvariantViolationError('open', {
        context: { folded: compacted.folded, olderThanDays },
      });
    }
    return {
      folded: compacted.folded,
      baselinesWritten: compacted.baselinesWritten,
      remainingEpisodes: compacted.episodes.length,
    };
  }

  private buildSweepReport(
    asOf: number,
    retentionDays: number,
    olderThanDays: number,
    compact: SweepReport['compact'],
    changes: readonly SweepChange[],
  ): SweepReport {
    const count = (action: SweepActionKind): number =>
      changes.filter((change) => change.action === action).length;
    return {
      asOf,
      retentionDays,
      olderThanDays,
      changes,
      quarantineCount: count('quarantine'),
      retireCount: count('retire'),
      archiveCount: count('archive'),
      purgeCount: count('purge'),
      compact,
    };
  }

  // -------------------------------------------------------------------------------------------
  // write plane (§6.2)
  // -------------------------------------------------------------------------------------------

  /**
   * Record a signal. Resolves the spec, runs the entity's weight-updater (project → user →
   * built-in, EMA-safe and reported), appends a self-describing episode and returns the new hint.
   */
  async record(
    key: EntityKey,
    signal: string | SignalSpec,
    context: Context,
    options: RecordOptions = {},
  ): Promise<RecordOutcome> {
    sanitizeContext(context);
    await this.ensureOpen();
    this.validateKey(key);
    this.requireKind(key);
    const spec = this.resolveSignal(signal);
    const state = await this.store.get(key);
    const ensure = options.ensure ?? false;
    const base = state ?? (ensure ? freshState(key, context.now) : undefined);

    let updater: UpdaterUsage | undefined;
    let weightEpisode: { readonly updater?: string; readonly weight?: number } = {};
    if (base !== undefined) {
      const ctx = buildWeightContext(base, spec);
      const computed = this.updaters.computeWeightSafe(ctx, options.updater ?? base.updater);
      const usage: UpdaterUsage = {
        name: computed.updaterName,
        ...(computed.fallbackFrom === undefined ? {} : { fallbackFrom: computed.fallbackFrom }),
        ...(computed.error === undefined ? {} : { error: computed.error }),
      };
      updater = usage;
      weightEpisode = { updater: computed.updaterName, weight: computed.outcome.newWeight };
    }

    const input: EpisodeInput = {
      type: 'signal',
      key,
      at: context.now,
      spec,
      ensure,
      ...(options.anchor === undefined ? {} : { anchors: [options.anchor] }),
      ...(options.runRef === undefined ? {} : { runRef: options.runRef }),
      ...(options.note === undefined ? {} : { note: options.note }),
      ...weightEpisode,
    };

    const appended = await this.store.append(input);
    const hint = buildHint(appended.state ?? freshState(key, context.now), context.now);
    return {
      hint,
      state: appended.state,
      ...(updater === undefined ? {} : { updater }),
    };
  }

  /**
   * Record a guard report: the host runs the oracle, Sage stores the result. This changes G (and
   * hence trust/status) but executes nothing — Sage never runs the guard or the tool itself.
   */
  async reportGuard(
    key: EntityKey,
    report: GuardReportInput,
    context: Context,
  ): Promise<EvidentialHint> {
    sanitizeContext(context);
    await this.ensureOpen();
    this.validateKey(key);
    this.requireKind(key);
    if (typeof report.ok !== 'boolean') {
      throw new InvalidArgumentError('report.ok', 'a boolean', report.ok);
    }
    const at = report.at ?? context.now;
    if (!Number.isFinite(at) || at < 0) {
      throw new InvalidArgumentError('report.at', 'a finite epoch >= 0', report.at);
    }
    const state = await this.store.get(key);
    let kind: string | undefined;
    if (report.kind !== undefined) kind = report.kind;
    else if (state !== undefined) kind = state.guard.kind;
    const input: EpisodeInput = {
      type: 'guard',
      key,
      at,
      ok: report.ok,
      ensure: true,
      ...(kind === undefined ? {} : { kind }),
    };
    const appended = await this.store.append(input);
    return appended.state === undefined
      ? buildHint(freshState(key, at), context.now)
      : buildHint(appended.state, context.now);
  }

  /**
   * Record a proposal (§6.2, §7.3). Enters on probation with provenance, evaluated
   * under Sage's promotion policy. Miners never write state.
   */
  async propose(
    proposal: Proposal,
    context: Context,
    options: ProposeOptions = {},
  ): Promise<ProposeOutcome> {
    sanitizeContext(context);
    await this.ensureOpen();
    const key = resolveProposalKey(proposal);
    this.validateKey(key);
    this.requireKind(key);

    const provenance = proposal.provenance ?? options.provenance ?? 'propose';
    if (typeof provenance !== 'string' || provenance.trim() === '') {
      throw new InvalidArgumentError('provenance', 'a non-empty string', provenance);
    }

    const keyString = entityKeyString(key);
    const [currentState, log] = await Promise.all([this.store.get(key), this.store.episodes()]);
    const existingProposals = log.filter(
      (e): e is Extract<Episode, { type: 'proposal' }> =>
        e.type === 'proposal' && entityKeyString(e.key) === keyString,
    );

    const priorProvenances = new Set(existingProposals.map((e) => e.provenance));
    priorProvenances.add(provenance);
    const allProvenances = [...priorProvenances];

    const priorEvidenceRefs = new Set<string>();
    for (const p of existingProposals) {
      for (const r of p.evidenceRefs ?? []) priorEvidenceRefs.add(r);
    }
    for (const r of proposal.evidenceRefs ?? []) priorEvidenceRefs.add(r);
    const allEvidenceRefs = [...priorEvidenceRefs];

    const policy = options.promotionPolicy ?? this.promotionPolicy;
    const promotionCtx: PromotionContext = {
      proposal,
      key,
      state: currentState,
      proposalEpisodes: existingProposals,
      provenances: allProvenances,
      evidenceRefs: allEvidenceRefs,
      context,
    };

    const decisionResult = await policy(promotionCtx);
    const decision: PromotionDecision =
      typeof decisionResult === 'boolean' ? { promoted: decisionResult } : decisionResult;

    const episodeInput: EpisodeInput = {
      type: 'proposal',
      key,
      at: context.now,
      provenance,
      ...(proposal.description === undefined ? {} : { description: proposal.description }),
      ...(proposal.theta0 === undefined ? {} : { theta0: proposal.theta0 }),
      ...(proposal.evidenceRefs === undefined ? {} : { evidenceRefs: proposal.evidenceRefs }),
      ...(proposal.anchor === undefined ? {} : { anchor: proposal.anchor }),
      promoted: decision.promoted,
      ...(decision.reason === undefined ? {} : { promotionReason: decision.reason }),
    };

    const appended = await this.store.append(episodeInput);
    const state =
      appended.state ??
      freshState(key, context.now, {
        ...(proposal.theta0 === undefined ? {} : { theta0: proposal.theta0 }),
        ...(proposal.anchor === undefined ? {} : { anchor: proposal.anchor }),
      });
    const hint = buildHint(state, context.now);

    return {
      ...hint,
      hint,
      state,
      episode: appended.episode as ProposalEpisode,
      promoted: decision.promoted,
      ...(decision.reason === undefined ? {} : { promotionReason: decision.reason }),
      provenances: allProvenances,
    };
  }

  /**
   * Run a host-supplied miner over an evidence stream (§6.2, §7.3).
   * Miners never mutate state; candidate proposals are routed through `propose()`.
   */
  async mine<TEvidence = unknown>(
    evidence: AsyncIterable<TEvidence> | Iterable<TEvidence>,
    miner: MinerPort<TEvidence>,
    context: Context,
    options: MineOptions = {},
  ): Promise<readonly MinedProposal[]> {
    sanitizeContext(context);
    await this.ensureOpen();
    if (typeof miner !== 'object' || miner === null) {
      throw new InvalidArgumentError('miner', 'a MinerPort object', miner);
    }
    if (typeof miner.name !== 'string' || miner.name.trim() === '') {
      throw new InvalidArgumentError('miner.name', 'a non-empty string', miner.name);
    }
    if (typeof miner.mine !== 'function') {
      throw new InvalidArgumentError('miner.mine', 'a function', miner.mine);
    }

    const proposals = await miner.mine(evidence, context);
    if (!Array.isArray(proposals)) {
      throw new InvalidArgumentError('miner.mine return value', 'an array of proposals', proposals);
    }

    const minedProposals: MinedProposal[] = [];
    for (const proposal of proposals) {
      const outcome = await this.propose(proposal, context, {
        ...options,
        provenance: proposal.provenance ?? miner.name,
      });
      minedProposals.push({
        ...proposal,
        outcome,
      });
    }

    return minedProposals;
  }

  /** A human lifecycle override. Unknown entity → logged, no-op, `null`. */
  async override(
    key: EntityKey,
    action: OverrideAction,
    context: Context,
    reason: string,
  ): Promise<EvidentialHint | null> {
    sanitizeContext(context);
    await this.ensureOpen();
    this.validateKey(key);
    this.requireKind(key);
    let override: 'retired' | 'quarantined' | 'restore';
    switch (action) {
      case 'retire':
        override = 'retired';
        break;
      case 'quarantine':
        override = 'quarantined';
        break;
      case 'restore':
        override = 'restore';
        break;
      default:
        throw new InvalidArgumentError('action', "'retire' | 'quarantine' | 'restore'", action);
    }
    const appended = await this.store.append({
      type: 'override',
      key,
      at: context.now,
      override,
      reason,
    });
    return appended.state === undefined ? null : buildHint(appended.state, context.now);
  }
}

// ---------------------------------------------------------------------------------------------
// read-plane contracts
// ---------------------------------------------------------------------------------------------

export type ListFilter = {
  readonly kind?: string;
  readonly status?: LifecycleStatus;
  readonly namespace?: string;
  readonly drifting?: boolean;
};

export interface EntityDetail {
  readonly hint: EvidentialHint;
  /** False when the id is unknown — the hint is then the probation prior (spec §5.2). */
  readonly known: boolean;
  readonly recentEpisodes: readonly Episode[];
  /** `provenance` strings from the key's proposal episodes (MinerPort flow). */
  readonly provenance: readonly string[];
  /** True if any proposal episode for this key was promoted by Sage's promotion policy. */
  readonly promoted: boolean;
}

export interface DriftEntry {
  readonly key: EntityKey;
  /** |ema.mu − theta0| — the drift magnitude. */
  readonly delta: number;
  readonly hint: EvidentialHint;
}

export interface DriftReport {
  readonly asOf: number;
  readonly count: number;
  readonly limitApplied: number;
  readonly drifting: readonly DriftEntry[];
}

export interface HintDelta {
  readonly key: EntityKey;
  readonly asOf: number;
  readonly before: EvidentialHint;
  readonly after: EvidentialHint;
  readonly deltaTrust: number;
  readonly statusChanged: boolean;
}

export interface ExplorePolicy {
  /** How many candidates to return; at most this many are given to probation. */
  readonly slots: number;
  /** Seeded RNG source; falls back to `context.seed`. One of the two must be present. */
  readonly seed?: number;
}

export interface Candidate {
  readonly key: EntityKey;
  readonly hint: EvidentialHint;
  readonly admittedBy: 'probation' | 'merit';
  /** Wilson-interval width — the uncertainty the probation sampling was weighted by. */
  readonly uncertainty: number;
}

function uncertaintyOf(entry: { readonly hint: EvidentialHint }): number {
  return wilsonWidth(entry.hint.evidence.successes, entry.hint.evidence.totalTrials);
}

/** Seeded weighted sampling without replacement. Zero-weight pools fall back to index order. */
function pickWeighted<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  rng: () => number,
  count: number,
): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    let total = 0;
    for (const item of pool) total += weightOf(item);
    if (total <= 0) {
      const first = pool[0];
      if (first === undefined) break;
      pool.shift();
      picked.push(first);
      continue;
    }
    let draw = rng() * total;
    let index = 0;
    for (; index < pool.length; index++) {
      const item = pool[index];
      if (item === undefined) break;
      draw -= weightOf(item);
      if (draw <= 0) break;
    }
    const idx = Math.min(index, pool.length - 1);
    const chosen = pool[idx];
    if (chosen === undefined) break;
    pool.splice(idx, 1);
    picked.push(chosen);
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// write-plane contracts
// ---------------------------------------------------------------------------------------------

export interface ProposeOptions {
  /** Overrides the engine's promotion policy for this proposal. */
  readonly promotionPolicy?: PromotionPolicy | undefined;
  /** Fallback provenance if not defined on the proposal. Defaults to 'propose'. */
  readonly provenance?: string | undefined;
}

export interface ProposeOutcome extends EvidentialHint {
  /** The evidential hint for the entity after recording the proposal. */
  readonly hint: EvidentialHint;
  /** The entity state after folding the proposal episode. */
  readonly state: EntityState | undefined;
  /** The appended proposal episode. */
  readonly episode: ProposalEpisode;
  /** Whether the proposal satisfied the active promotion policy. */
  readonly promoted: boolean;
  /** The explanation reason from the promotion policy. */
  readonly promotionReason?: string | undefined;
  /** Distinct provenances observed across all proposal episodes for this key. */
  readonly provenances: readonly string[];
}

export interface MineOptions {
  /** Overrides the engine's promotion policy for all proposals from this miner run. */
  readonly promotionPolicy?: PromotionPolicy | undefined;
  /** Fallback provenance for proposals that omit it; defaults to miner.name. */
  readonly provenance?: string | undefined;
}

export interface MinedProposal extends Proposal {
  /** The outcome of submitting this proposal through the engine's propose flow. */
  readonly outcome: ProposeOutcome;
}

export interface RecordOptions {
  /** Unknown id: create the entity only when true (spec §5.2). Default false. */
  readonly ensure?: boolean;
  /** A single anchor observed at this use. */
  readonly anchor?: Anchor;
  readonly runRef?: string;
  readonly note?: string;
  /** Weight-updater name; defaults to the entity's configured `updater`. */
  readonly updater?: string;
}

export interface UpdaterUsage {
  readonly name: string;
  /** The requested updater that fell back to EMA (reported, never silent). */
  readonly fallbackFrom?: string;
  readonly error?: SageError;
}

export interface RecordOutcome {
  /** The hint after the mutation (a probation prior when the id was unknown and not ensured). */
  readonly hint: EvidentialHint;
  /** `undefined` when the signal was a logged no-op on an unknown, un-ensured id. */
  readonly state: EntityState | undefined;
  /** Which updater produced the new weight (and any fallback), when a state grew/received one. */
  readonly updater?: UpdaterUsage;
}

export interface GuardReportInput {
  readonly ok: boolean;
  /** The guard the host ran; defaults to the entity's current guard kind. */
  readonly kind?: string;
  /** When the guard ran; defaults to `context.now`. */
  readonly at?: number;
}

export type OverrideAction = 'retire' | 'quarantine' | 'restore';
