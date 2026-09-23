import { SageError } from '@sutras/sage-core';
import type { InitReport } from './init.ts';

/** Machine output: JSON with a replacer that makes every engine value round-trippable. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (item instanceof SageError) {
        return item.toJSON();
      }
      if (item instanceof Map) {
        return Object.fromEntries(item);
      }
      if (item instanceof Set) {
        return [...item];
      }
      if (typeof item === 'number' && !Number.isFinite(item)) {
        return String(item);
      }
      return item;
    },
    2,
  )}\n`;
}

/** Human output for a successful init: home, backend, store, config, and the preflight gate. */
export function renderInit(report: InitReport): string {
  const p = report.preflight;
  const lastSweep = p.lastSweep === null ? 'not yet' : new Date(p.lastSweep).toISOString();
  const lines = [
    `sage: initialized engine home at ${report.home}`,
    `  backend:    ${report.backend}`,
    report.path === null ? `  store:      ephemeral (memory)` : `  store:      ${report.path}`,
    ...(report.config === null
      ? []
      : [`  config:     ${report.config} (layout v${report.layoutVersion})`]),
    `  preflight:  ${p.status} — ${p.episodeCount} episodes, ${p.entityCount} entities, integrity ${p.integrity}`,
    `  last sweep: ${lastSweep}`,
    ...(report.backup === null ? [] : [`  backup:     ${report.backup}`]),
  ];
  return `${lines.join('\n')}\n`;
}
