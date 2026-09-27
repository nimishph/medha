import type {
  AppendResult,
  EntityKey,
  EntityState,
  Episode,
  EpisodeInput,
  OpenResult,
  StorePort,
} from '@cntxt-labs/medha-core';
import { InvalidArgumentError } from '@cntxt-labs/medha-core';
import { NamespaceViolationError } from './errors.ts';

/**
 * A `StorePort` restricted to an allow-list of namespaces: namespace isolation enforced at the
 * store boundary, so every layer above (engine, CLI, sync) inherits it and none can bypass it.
 *
 * - Keyed access (`get`, `append`) outside the scope throws `NamespaceViolationError`. It does not
 *   return `undefined`: an "unknown" answer plus `ensure` would let a caller create entities in a
 *   namespace it was never granted.
 * - Enumeration (`list`, `rebuild`, `episodes`) silently returns only in-scope data, so foreign
 *   entities and episodes are invisible, not merely unlabeled.
 * - `replaceLog` is refused: it replaces the *whole* log, so a scoped caller (compaction, restore,
 *   sync merge) would erase other namespaces. Whole-log maintenance needs the unscoped store.
 * - Meta keys are prefixed with the scope, so a scoped caller cannot read or overwrite another
 *   scope's markers (e.g. the last-sweep time).
 *
 * `seq` values are the inner store's and are global, so a scoped `episodes()` view can have gaps.
 */
export function scopeStore(inner: StorePort, namespaces: readonly string[]): StorePort {
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    throw new InvalidArgumentError('namespaces', 'a non-empty list of namespaces', namespaces);
  }
  for (const ns of namespaces) {
    if (typeof ns !== 'string') {
      throw new InvalidArgumentError('namespaces[]', 'a string', ns);
    }
  }
  const allowed = [...new Set(namespaces)].sort();
  const allowedSet = new Set(allowed);
  const metaPrefix = `scope[${allowed.join(',')}]:`;

  const check = (action: string, key: EntityKey): void => {
    if (!allowedSet.has(key.namespace)) {
      throw new NamespaceViolationError(action, key.namespace, allowed);
    }
  };
  const inScope = (key: EntityKey): boolean => allowedSet.has(key.namespace);

  /**
   * A `retract` masks the episode named by `targetSeq`, so the retraction's real reach is the
   * *target's* namespace, not the wrapper's. Checking only `episode.key` let a caller granted
   * namespace A file a retraction against namespace B's episode and mask it out of every future
   * fold (medha-bis). Resolve against the unscoped `inner.episodes()` — a scoped view hides the very
   * episodes whose keys need checking. A `targetSeq` that resolves to no episode is passed through
   * untouched: it names no namespace to violate, and whether it is a valid retraction is not this
   * wrapper's call to make.
   */
  const checkRetractTarget = async (episode: Extract<EpisodeInput, { type: 'retract' }>) => {
    const target = (await inner.episodes()).find((e) => e.seq === episode.targetSeq);
    if (target !== undefined) check('append (retract target)', target.key);
  };

  return {
    name: `${inner.name}[scoped:${allowed.join(',')}]`,
    registries: inner.registries,
    scope: allowed,
    open: (): Promise<OpenResult> => inner.open(),
    isOpen: () => inner.isOpen(),
    close: () => inner.close(),
    // `async` here is load-bearing, not style: it turns `check`'s synchronous throw into a
    // rejected promise, so `store.get(x).catch(...)` behaves the same as every other StorePort
    // method instead of throwing before a promise is even returned.
    async append(episode: EpisodeInput): Promise<AppendResult> {
      check('append', episode.key);
      if (episode.type === 'baseline') check('append', episode.state.key);
      if (episode.type === 'retract') await checkRetractTarget(episode);
      return inner.append(episode);
    },
    async episodes(afterSeq?: number, limit?: number): Promise<Episode[]> {
      const visible = (await inner.episodes(afterSeq)).filter((e) => inScope(e.key));
      return limit === undefined ? visible : visible.slice(0, limit);
    },
    async get(key: EntityKey): Promise<EntityState | undefined> {
      check('get', key);
      return inner.get(key);
    },
    async list(): Promise<EntityState[]> {
      return (await inner.list()).filter((s) => inScope(s.key));
    },
    async rebuild(): Promise<EntityState[]> {
      return (await inner.rebuild()).filter((s) => inScope(s.key));
    },
    async replaceLog(): Promise<{ readonly from: number; readonly to: number }> {
      throw new NamespaceViolationError('replaceLog (whole-log rewrite)', '*', allowed);
    },
    getMeta: (key: string) => inner.getMeta(metaPrefix + key),
    setMeta: (key: string, value: string) => inner.setMeta(metaPrefix + key, value),
  };
}
