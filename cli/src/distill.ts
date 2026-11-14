import { readFileSync } from 'node:fs';
import type { Proposal, TrajectoryEvidence } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';

export interface DistillOptions {
  readonly dir?: string;
  readonly home?: string;
  readonly file?: string;
  readonly incident?: string;
  readonly commit?: string;
  readonly autoFile?: boolean;
}

export interface DistillReport {
  readonly home: string;
  readonly incidentId: string;
  readonly proposals: readonly Proposal[];
  readonly filedCount: number;
  readonly autoFile: boolean;
}

export async function runDistill(
  options: DistillOptions,
  environment: Environment,
): Promise<DistillReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    let trajectory: TrajectoryEvidence;

    if (options.file) {
      const raw = readFileSync(options.file, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        trajectory = {
          id: parsed.id ?? options.incident ?? 'incident-1',
          title: parsed.title ?? 'Session Incident',
          commitSha: parsed.commitSha ?? options.commit,
          lessons: parsed.lessons,
        };
      } catch {
        trajectory = {
          id: options.incident ?? 'incident-1',
          title: options.file,
          commitSha: options.commit,
          lessons: [
            {
              id: `lesson-${(options.incident ?? 'session').toLowerCase()}`,
              text: raw.trim(),
            },
          ],
        };
      }
    } else {
      trajectory = {
        id: options.incident ?? 'session',
        title: `Retrospective distillation for ${options.incident ?? 'session'}`,
        commitSha: options.commit,
        lessons: [
          {
            id: `rule-${(options.incident ?? 'session').toLowerCase()}`,
            text: `Distilled empirical rule from ${options.incident ?? 'session'}`,
          },
        ],
      };
    }

    const outcome = await opened.engine.distillTrajectory(
      trajectory,
      { autoFile: options.autoFile === true },
      { now: environment.now() },
    );

    return {
      home: opened.home,
      incidentId: trajectory.id,
      proposals: outcome.proposals,
      filedCount: outcome.filedCount,
      autoFile: options.autoFile === true,
    };
  } finally {
    await opened.engine.close();
  }
}

export function renderDistill(report: DistillReport): string {
  const lines: string[] = [
    `medha: distilled ${report.proposals.length} proposal(s) from incident '${report.incidentId}'`,
  ];
  if (report.autoFile) {
    lines.push(`filed on probation: ${report.filedCount} proposal(s)`);
  } else {
    lines.push('mode: dry-run preview (use --auto-file to record directly into store)');
  }
  lines.push('');
  for (const p of report.proposals) {
    const key = p.key ? `${p.key.kind}:${p.key.id}` : p.id;
    const anchor = p.anchor ? ` [anchor: ${p.anchor.kind}=${p.anchor.value}]` : '';
    lines.push(`- ${key}${anchor}: ${p.description ?? p.note ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}
