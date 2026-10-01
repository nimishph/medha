import type { Environment } from './environment.ts';
import { openHome } from './open.ts';
import { pageAll } from './read.ts';
import { openBrowser } from './ui.ts';
import { VERSION } from './version.ts';

export interface IssueOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly title?: string | undefined;
  readonly open?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly _?: readonly string[] | undefined;
}

export interface IssueReport {
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly openedBrowser: boolean;
}

export async function runIssue(
  options: IssueOptions,
  environment: Environment,
): Promise<IssueReport> {
  const title =
    (options._ && options._.length > 0 ? options._.join(' ') : options.title)?.trim() ||
    'Issue / Feedback';

  let storeStats = 'None (uninitialized or store not found)';
  try {
    const opened = openHome(options.dir ?? environment.cwd, options.home);
    await opened.store.open();
    try {
      const now = environment.now();
      const [preflight, hints, episodes] = await Promise.all([
        opened.adminEngine.preflight({ now }),
        pageAll(opened.adminEngine, now),
        opened.store.episodes(),
      ]);
      storeStats = `backend: ${opened.config.backend}, entities: ${hints.length}, episodes: ${episodes.length}, preflight: ${preflight.status}`;
    } finally {
      await opened.adminEngine.close();
    }
  } catch (_err: unknown) {
    storeStats = 'None (uninitialized or store not found)';
  }

  const runtime = (process.versions as Record<string, string>).bun
    ? `bun ${(process.versions as Record<string, string>).bun}`
    : `node ${process.version}`;

  const body = [
    '### Description',
    '<!-- Describe the issue, unexpected behavior, or enhancement -->',
    '',
    '### Steps to Reproduce',
    '1. ',
    '',
    '### Expected Behavior',
    '',
    '### Diagnostics (Sanitized)',
    `- **Medha Version**: ${VERSION}`,
    `- **Platform**: ${process.platform} (${process.arch})`,
    `- **Runtime**: ${runtime}`,
    `- **Store**: ${storeStats}`,
    '',
  ].join('\n');

  const repoUrl = 'https://github.com/nimishph/medha/issues/new';
  const fullUrl = `${repoUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

  let openedBrowser = false;
  if (options.open !== false && options.json !== true && !environment.env.CI) {
    openedBrowser = openBrowser(fullUrl);
  }

  return {
    title,
    url: fullUrl,
    body,
    openedBrowser,
  };
}

export function renderIssue(report: IssueReport): string {
  return `${[
    'medha: prepared issue on GitHub:',
    `  title: ${report.title}`,
    `  url:   ${report.url}`,
    report.openedBrowser ? '  (opened in default browser)' : '',
  ]
    .filter(Boolean)
    .join('\n')}\n`;
}
