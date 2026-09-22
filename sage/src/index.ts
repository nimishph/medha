/**
 * sage: the engine facade — read/write/maintenance planes, session-start sweep, exploration
 * helper, plus the CLI and MCP servers.
 *
 * Loom-ujs3.6 (read plane) and Loom-ujs3.7 (write plane) land here on top of the sage-core
 * kernel (Loom-ujs3.3) and sage-store (Loom-ujs3.4). The maintenance plane (§6.4: sweep,
 * compact, preflight, backup/restore) is Loom-ujs3.8; MinerPort `propose`/`mine` is Loom-ujs3.9
 * (the WritePlane section of the spec lists them; they need the miner flow, not this facade).
 */

export * from './engine.ts';
export * from './updaters.ts';
