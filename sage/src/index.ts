export * from '@sutras/sage-core';
/**
 * sage: the engine facade — read/write/maintenance planes, session-start sweep, exploration
 * helper, plus the CLI and MCP servers.
 *
 * The read plane (§6.1) and write plane (§6.2) land on top of the sage-core kernel (Loom-ujs3.3)
 * and sage-store (Loom-ujs3.4); the maintenance plane (§6.4: session-start sweep, compaction,
 * preflight, backup/restore) is Loom-ujs3.8. MinerPort `propose`/`mine` is Loom-ujs3.9 (listed
 * under the write plane in the spec; they need the miner flow, not this facade).
 */

export * from '@sutras/sage-sync';
export * from './engine.ts';
export * from './maintenance.ts';
export * from './updaters.ts';
