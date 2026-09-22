/**
 * sage-store: the `StorePort` contract and its backends.
 *
 * One storage contract (spec §7.1) and one shared contract suite; memory now, file and SQLite
 * backends later (Loom-ujs3.5). Each backend re-runs the exact same suite with no per-backend
 * branch, so any passing backend is interchangeable with the others.
 */

export * from './contract-suite.ts';
export * from './errors.ts';
export * from './memory-store.ts';
