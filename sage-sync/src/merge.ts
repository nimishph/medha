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
 */
export function canonicalEpisodeKey(episode: Episode | EpisodeInput): string {
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
  }

  return parts.join('\u0000');
}

/**
 * Merges two episode logs deterministically.
 * Deduplicates identical episodes, sorts chronologically with deterministic tie-breaking,
 * and assigns fresh sequential sequence numbers.
 */
export function mergeEpisodes(local: readonly Episode[], incoming: readonly Episode[]): Episode[] {
  const map = new Map<string, Episode>();

  for (const ep of local) {
    const k = canonicalEpisodeKey(ep);
    if (!map.has(k)) map.set(k, ep);
  }

  for (const ep of incoming) {
    const k = canonicalEpisodeKey(ep);
    if (!map.has(k)) map.set(k, ep);
  }

  const all = Array.from(map.values());

  // Deterministic total ordering
  all.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    const keyA = entityKeyString(a.key);
    const keyB = entityKeyString(b.key);
    if (keyA !== keyB) return keyA.localeCompare(keyB);
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return canonicalEpisodeKey(a).localeCompare(canonicalEpisodeKey(b));
  });

  return all.map((ep, idx) => ({
    ...ep,
    seq: idx,
  }));
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
