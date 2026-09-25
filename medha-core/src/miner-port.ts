import type { Context } from './context.ts';
import type { Anchor } from './durability.ts';
import type { EntityKey, EntityState } from './entity.ts';
import type { ProposalEpisode } from './episode.ts';
import { InvalidArgumentError } from './errors.ts';

/**
 * MinerPort and proposal flow contracts, library spec §7.3.
 *
 * A miner is host-supplied and inspects an evidence stream (digests, run traces, transcripts)
 * to synthesize candidate proposals.
 *
 * Invariant I & II: A miner never writes state. Medha puts every proposal on probation with
 * provenance and owns promotion policy (including overridable policies like >=2 converging
 * sources). Medha ships no miner.
 */

export interface Proposal {
  readonly key?: EntityKey | undefined;
  readonly kind?: string | undefined;
  readonly id?: string | undefined;
  readonly namespace?: string | undefined;
  readonly description?: string | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly anchor?: Anchor | undefined;
  readonly provenance?: string | undefined;
  readonly theta0?: number | undefined;
  readonly author?: string | undefined;
  readonly at?: number | undefined;
  readonly note?: string | undefined;
}

export function resolveProposalKey(proposal: Proposal): EntityKey {
  if (proposal.key !== undefined) {
    return proposal.key;
  }
  if (proposal.kind === undefined || proposal.kind.trim() === '') {
    throw new InvalidArgumentError('proposal.kind', 'a non-empty string', proposal.kind);
  }
  if (proposal.id === undefined || proposal.id.trim() === '') {
    throw new InvalidArgumentError('proposal.id', 'a non-empty string', proposal.id);
  }
  return {
    namespace: proposal.namespace ?? '',
    kind: proposal.kind,
    id: proposal.id,
  };
}

export interface MinerPort<TEvidence = unknown> {
  /** Identifier of the miner (e.g. 'digest-clusterer', 'recipe-miner'). */
  readonly name: string;
  /**
   * Mine the evidence stream and produce candidate proposals.
   * Miners never mutate state; Medha handles putting proposals on probation with provenance
   * and evaluating promotion policy.
   */
  mine(
    evidence: AsyncIterable<TEvidence> | Iterable<TEvidence>,
    context: Context,
  ): Promise<readonly Proposal[]> | readonly Proposal[];
}

export interface PromotionContext {
  readonly proposal: Proposal;
  readonly key: EntityKey;
  readonly state: EntityState | undefined;
  readonly proposalEpisodes: readonly ProposalEpisode[];
  readonly provenances: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly context: Context;
}

export interface PromotionDecision {
  readonly promoted: boolean;
  readonly reason?: string;
}

export type PromotionPolicy = (
  context: PromotionContext,
) => boolean | PromotionDecision | Promise<boolean | PromotionDecision>;

/**
 * Default promotion policy (§7.3): at least minSources (default 2) converging sources
 * proposing the same entity key.
 */
export function convergingSourcesPolicy(
  options: { readonly minSources?: number } = {},
): PromotionPolicy {
  const minSources = options.minSources ?? 2;
  if (!Number.isSafeInteger(minSources) || minSources < 1) {
    throw new InvalidArgumentError('options.minSources', 'a positive integer >= 1', minSources);
  }
  return (ctx: PromotionContext): PromotionDecision => {
    const distinct = ctx.provenances;
    const promoted = distinct.length >= minSources;
    return {
      promoted,
      reason: promoted
        ? `${distinct.length} converging sources: ${distinct.join(', ')} (threshold >= ${minSources})`
        : `Requires >= ${minSources} converging sources; saw ${distinct.length} (${distinct.join(', ') || 'none'})`,
    };
  };
}

export function convergingEvidenceRefsPolicy(
  options: { readonly minRefs?: number } = {},
): PromotionPolicy {
  const minRefs = options.minRefs ?? 2;
  if (!Number.isSafeInteger(minRefs) || minRefs < 1) {
    throw new InvalidArgumentError('options.minRefs', 'a positive integer >= 1', minRefs);
  }
  return (ctx: PromotionContext): PromotionDecision => {
    const distinct = ctx.evidenceRefs;
    const promoted = distinct.length >= minRefs;
    return {
      promoted,
      reason: promoted
        ? `${distinct.length} converging evidence refs (threshold >= ${minRefs})`
        : `Requires >= ${minRefs} converging evidence refs; saw ${distinct.length}`,
    };
  };
}

export function alwaysPromotePolicy(): PromotionPolicy {
  return (): PromotionDecision => ({
    promoted: true,
    reason: 'always promote policy',
  });
}

export function neverPromotePolicy(): PromotionPolicy {
  return (): PromotionDecision => ({
    promoted: false,
    reason: 'never promote policy',
  });
}
