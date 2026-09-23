/**
 * sage-store: the `StorePort` contract and its backends.
 *
 * One storage contract (spec §7.1) and one shared contract suite that every backend re-runs with
 * no per-backend branch, so any passing backend is interchangeable: memory (ephemeral), the
 * git-trackable FilePolicyStore (atomic JSON commits with a backup fallback), and the SQLite
 * volume backend. Each backend keeps the episode log as the source of truth and folds the
 * projection from it.
 */

export * from './contract-suite.ts';
export * from './errors.ts';
export * from './file-store.ts';
export * from './memory-store.ts';
export { resolveRegistries } from './registries.ts';
export * from './sqlite-store.ts';
