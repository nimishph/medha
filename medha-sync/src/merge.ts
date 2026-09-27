/**
 * Deterministic merge algorithms for episodes and entity states, spec §7.2.
 *
 * Guarantees mathematical commutativity, associativity, and idempotency:
 *   merge(A, B) === merge(B, A)
 *   merge(merge(A, B), C) === merge(A, merge(B, C))
 *   merge(A, A) === A
 */

import {
  type Anchor,
  type EntityState,
  type Episode,
  type EpisodeInput,
  entityKeyString,
  type LifecycleStatus,
  round6,
  statusFor,
} from '@cntxt-labs/medha-core';

/**
 * Computes a deterministic content key for an episode, ignoring local store seq.
 *
 * A `retract` folds in its `targetSeq` and `reason`. Folding in *something* is the point: with no
 * log in hand there is no target to resolve against, and leaving a retraction's distinguishing
 * fields out made two retractions of different episodes hash identically, so `mergeEpisodes`
 * deduplicated one away (medha-8gx). `targetSeq` is a *local* store seq, so two replicas only
 * converge on it if they happen to number their logs alike — `mergeEpisodes` therefore resolves
 * the target to a content key before deduping, and this function is the unresolved fallback.
 */
export function canonicalEpisodeKey(episode: Episode | EpisodeInput): string {
  return contentKey(episode, episode.type === 'retract' ? String(episode.targetSeq) : '');
}

/**
 * The episode's content key with a caller-supplied stand-in for a `retract`'s target. Split out so
 * the resolved (`mergeEpisodes`) and unresolved (`canonicalEpisodeKey`) forms cannot drift apart.
 */
function contentKey(episode: Episode | EpisodeInput, retractTarget: string): string {
  const { key, at, type } = episode;
  const parts: string[] = [key.namespace, key.kind, key.id, String(at), type];

  switch (type) {
    case 'signal': {
      parts.push(episode.spec.name);
      parts.push(String(episode.spec.value));
      parts.push(String(episode.spec.countsAsTrial));
      parts.push(String(episode.spec.countsAsSuccess));
      parts.push(episode.runRef ?? '');
      parts.push(episode.updater ?? '');
      if (episode.weight !== undefined) parts.push(String(episode.weight));
      if (episode.anchors) {
        const sortedAnchors = [...episode.anchors]
          .map((a) => `${a.kind}:${a.value}`)
          .sort()
          .join(',');
        parts.push(sortedAnchors);
      }
      break;
    }
    case 'guard': {
      parts.push(String(episode.ok));
      parts.push(episode.kind ?? '');
      break;
    }
    case 'override': {
      parts.push(episode.override);
      parts.push(episode.reason);
      break;
    }
    case 'proposal': {
      parts.push(episode.provenance);
      parts.push(episode.description ?? '');
      if (episode.evidenceRefs) {
        parts.push([...episode.evidenceRefs].sort().join(','));
      }
      if (episode.promoted !== undefined) parts.push(String(episode.promoted));
      break;
    }
    case 'sweep': {
      parts.push(episode.action);
      parts.push(episode.reason);
      break;
    }
    case 'baseline': {
      parts.push(entityKeyString(episode.state.key));
      parts.push(String(episode.state.evidence.k));
      parts.push(String(episode.state.evidence.n));
      parts.push(String(episode.state.ema.mu));
      parts.push(episode.state.status);
      break;
    }
    case 'retract': {
      parts.push(retractTarget);
      parts.push(episode.reason);
      break;
    }
    case 'define': {
      parts.push(episode.definition.title);
      parts.push(episode.definition.rationale);
      parts.push([...(episode.definition.tags ?? [])].sort().join(','));
      break;
    }
    case 'decision': {
      parts.push(episode.caseId);
      parts.push(episode.parentId ?? '');
      parts.push(episode.condition);
      parts.push(episode.decision.type);
      if (episode.decision.type === 'probability') parts.push(String(episode.decision.value));
      break;
    }
  }

  return parts.join('\u0000');
}

/** A retraction whose target is not present in the log it came from, keyed by the raw seq. */
function danglingTarget(targetSeq: number): string {
  return `\u0000<unresolved-target>${targetSeq}`;
}

/** How one episode is identified against another replica's log, plus what a retraction masks. */
interface Identity {
  /** Dedup and sort identity of the episode itself. */
  readonly id: string;
  /** For a `retract`: the identity of the episode it masks, or null when unresolvable. */
  readonly targetId: string | null;
}

/**
 * Resolve every episode in one log to its cross-replica identity. A `retract` is identified by the
 * *content* of the episode it masks, not by the local seq it happens to point at, so replicas that
 * retracted the same episode under different local numbering still dedupe to one entry. Targets are
 * resolved within the log that carries the retraction, because `seq` only means something there.
 */
function identities(log: readonly Episode[]): ReadonlyMap<number, Identity> {
  const own = new Map<number, string>();
  for (const ep of log) own.set(ep.seq, contentKey(ep, ''));

  const bySeq = new Map<number, Identity>();
  for (const ep of log) {
    if (ep.type !== 'retract') bySeq.set(ep.seq, { id: contentKey(ep, ''), targetId: null });
  }
  for (const ep of log) {
    if (ep.type !== 'retract') continue;
    const targetKey = own.get(ep.targetSeq);
    bySeq.set(ep.seq, {
      id: contentKey(ep, targetKey ?? danglingTarget(ep.targetSeq)),
      targetId: targetKey ?? null,
    });
  }
  return bySeq;
}

/**
 * Merges two episode logs deterministically.
 * Deduplicates identical episodes, sorts chronologically with deterministic tie-breaking,
 * and assigns fresh sequential sequence numbers.
 *
 * Because `seq` is renumbered, a surviving `retract` has its `targetSeq` renumbered with it —
 * pointing it at the episode that now occupies the target's slot. Leaving it stale would let a
 * retraction mask a different episode after every merge (medha-8gx).
 */
export function mergeEpisodes(local: readonly Episode[], incoming: readonly Episode[]): Episode[] {
  const map = new Map<string, { readonly episode: Episode; readonly targetId: string | null }>();

  const collect = (log: readonly Episode[], ids: ReadonlyMap<number, Identity>): void => {
    for (const ep of log) {
      const { id, targetId } = ids.get(ep.seq) as Identity;
      if (!map.has(id)) map.set(id, { episode: ep, targetId });
    }
  };
  collect(local, identities(local));
  collect(incoming, identities(incoming));

  const entries = [...map.entries()];

  // Deterministic total ordering
  entries.sort(([aId, a], [bId, b]) => {
    if (a.episode.at !== b.episode.at) return a.episode.at - b.episode.at;
    const keyA = entityKeyString(a.episode.key);
    const keyB = entityKeyString(b.episode.key);
    if (keyA !== keyB) return keyA.localeCompare(keyB);
    if (a.episode.type !== b.episode.type) return a.episode.type.localeCompare(b.episode.type);
    return aId.localeCompare(bId);
  });

  const seqById = new Map(entries.map(([id], idx) => [id, idx] as const));

  return entries.map(([, { episode, targetId }], idx) => {
    if (episode.type !== 'retract') return { ...episode, seq: idx };
    // An unresolvable target (a retraction whose target is absent from the log it arrived in) keeps
    // the seq it came with, as before: it is a no-op at worst, and a synthetic one could mask a real
    // episode that arrives later at that index.
    const targetSeq =
      targetId === null ? episode.targetSeq : (seqById.get(targetId) ?? episode.targetSeq);
    return { ...episode, seq: idx, targetSeq };
  });
}

/**
 * 2-way commutative merge of two EntityState arrays.
 * Combines evidence (k, n, contextRejects), sample-weighted EMA mu, union of anchors,
 * and latest guard outcome.
 */
export function mergeEntityStates(
  local: readonly EntityState[],
  incoming: readonly EntityState[],
): EntityState[] {
  const map = new Map<string, EntityState>();

  for (const s of local) {
    map.set(entityKeyString(s.key), s);
  }

  for (const s of incoming) {
    const k = entityKeyString(s.key);
    const existing = map.get(k);
    if (!existing) {
      map.set(k, s);
    } else {
      map.set(k, mergeSingleState(existing, s));
    }
  }

  const result = Array.from(map.values());
  result.sort((a, b) => entityKeyString(a.key).localeCompare(entityKeyString(b.key)));
  return result;
}

function mergeSingleState(s1: EntityState, s2: EntityState): EntityState {
  const totalN = s1.evidence.n + s2.evidence.n;
  const totalK = s1.evidence.k + s2.evidence.k;
  const totalContextRejects = s1.evidence.contextRejects + s2.evidence.contextRejects;

  let mergedMu: number;
  if (totalN === 0) {
    mergedMu = (s1.ema.mu + s2.ema.mu) / 2;
  } else {
    mergedMu = (s1.evidence.n * s1.ema.mu + s2.evidence.n * s2.ema.mu) / totalN;
  }
  mergedMu = round6(Math.min(1, Math.max(0, mergedMu)));

  const updatedAt = Math.max(s1.ema.updatedAt, s2.ema.updatedAt);
  const theta0 = s1.ema.theta0 ?? s2.ema.theta0 ?? 0.5;

  // Merge anchors: unique by kind + value
  const anchorSet = new Set<string>();
  const mergedAnchors: Anchor[] = [];
  for (const a of [...s1.anchors, ...s2.anchors]) {
    const k = `${a.kind}\0${a.value}`;
    if (!anchorSet.has(k)) {
      anchorSet.add(k);
      mergedAnchors.push(a);
    }
  }
  mergedAnchors.sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value));

  // Merge guard: take latest ok/failure report
  let guard = s1.guard;
  if (!s1.guard.lastOkAt && s2.guard.lastOkAt) {
    guard = s2.guard;
  } else if (s1.guard.lastOkAt && s2.guard.lastOkAt) {
    guard = s1.guard.lastOkAt >= s2.guard.lastOkAt ? s1.guard : s2.guard;
  } else if (s1.guard.lastOk === null && s2.guard.lastOk !== null) {
    guard = s2.guard;
  }

  const lastSignalAt = Math.max(s1.lastSignalAt ?? 0, s2.lastSignalAt ?? 0) || null;
  const override = s1.override ?? s2.override ?? null;
  const retiredAt = s1.retiredAt ?? s2.retiredAt ?? null;
  const restoredAt = s1.restoredAt ?? s2.restoredAt ?? null;

  // Lifecycle status
  let status: LifecycleStatus;
  if (s1.status === 'quarantined' || s2.status === 'quarantined') {
    status = 'quarantined';
  } else if (s1.status === 'retired' && s2.status === 'retired') {
    status = 'retired';
  } else {
    status = statusFor(
      {
        key: s1.key,
        evidence: { k: totalK, n: totalN, contextRejects: totalContextRejects },
        ema: { mu: mergedMu, theta0, updatedAt },
        guard,
        anchors: mergedAnchors,
        status: 'probation',
        override,
        retiredAt,
        restoredAt,
        updater: s1.updater || s2.updater,
        createdAt: Math.min(s1.createdAt, s2.createdAt),
        lastSignalAt,
      },
      updatedAt,
    );
  }

  return {
    key: s1.key,
    evidence: {
      k: totalK,
      n: totalN,
      contextRejects: totalContextRejects,
    },
    ema: {
      mu: mergedMu,
      theta0,
      updatedAt,
    },
    guard,
    anchors: mergedAnchors,
    status,
    override,
    retiredAt,
    restoredAt,
    updater: s1.updater || s2.updater,
    createdAt: Math.min(s1.createdAt, s2.createdAt),
    lastSignalAt,
  };
}
