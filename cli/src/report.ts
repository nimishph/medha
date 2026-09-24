import { resolve } from 'node:path';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { LIFECYCLE_STATUSES, pageAll, paramsReport, type StatusReport } from './read.ts';
import { generateDashboardHtml } from './ui.ts';
import { VERSION } from './version.ts';

export interface ReportOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly out?: string | undefined;
}

export interface ReportOutcome {
  readonly home: string;
  readonly path: string;
  readonly entityCount: number;
  readonly episodeCount: number;
}

export async function runReport(
  options: ReportOptions,
  environment: Environment,
): Promise<ReportOutcome> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  await opened.store.open();
  try {
    const dest = resolve(options.dir ?? environment.cwd, options.out ?? 'medha-report.html');
    const now = environment.now();

    const [preflight, hints, episodes] = await Promise.all([
      opened.engine.preflight({ now }),
      pageAll(opened.engine, now),
      opened.store.episodes(),
    ]);

    const byStatus = Object.fromEntries(
      LIFECYCLE_STATUSES.map((status) => [
        status,
        hints.filter((hint) => hint.status === status).length,
      ]),
    ) as Record<(typeof LIFECYCLE_STATUSES)[number], number>;
    const drifting = hints.filter((hint) => hint.temporal.isDrifting).length;

    const status: StatusReport = {
      home: opened.home,
      asOf: now,
      backend: opened.config.backend,
      path: opened.config.path,
      preflight,
      byStatus,
      drifting,
      params: paramsReport(now),
    };

    const html = generateDashboardHtml({
      status,
      entities: hints,
      episodes,
      version: VERSION,
      home: opened.home,
    });

    await Bun.write(dest, html);

    return {
      home: opened.home,
      path: dest,
      entityCount: hints.length,
      episodeCount: episodes.length,
    };
  } finally {
    await opened.engine.close();
  }
}

export function renderReport(outcome: ReportOutcome): string {
  return (
    `medha: generated evidential report snapshot at ${outcome.path}\n` +
    `  entities: ${outcome.entityCount}  episodes: ${outcome.episodeCount}\n`
  );
}
