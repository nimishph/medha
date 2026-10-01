import { resolve } from 'node:path';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { collectDashboardData, generateDashboardHtml } from './ui.ts';
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

    const { status, hints, episodes, decisionTrees } = await collectDashboardData(opened, now);

    const html = generateDashboardHtml({
      status,
      entities: hints,
      episodes,
      decisionTrees,
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
    await opened.adminEngine.close();
  }
}

export function renderReport(outcome: ReportOutcome): string {
  return (
    `medha: generated evidential report snapshot at ${outcome.path}\n` +
    `  entities: ${outcome.entityCount}  episodes: ${outcome.episodeCount}\n`
  );
}
