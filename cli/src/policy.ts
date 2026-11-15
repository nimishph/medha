import type { PolicyLatchOutcome } from '@cntxt-labs/medha';
import type { Environment } from './environment.ts';
import { openHome } from './open.ts';

export interface PolicyCommandArgs {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
  readonly namespace?: string | undefined;
  readonly kind?: string | undefined;
  readonly id: string;
  readonly context?: string | undefined;
  readonly author?: string | undefined;
  readonly action?: string | undefined;
  readonly minTrust?: string | undefined;
}

export async function runPolicy(
  args: PolicyCommandArgs,
  environment: Environment,
): Promise<PolicyLatchOutcome> {
  const opened = openHome(args.dir ?? environment.cwd, args.home, environment.env);
  const minTrust = args.minTrust !== undefined ? Number.parseFloat(args.minTrust) : undefined;

  let parsedContext: string | Record<string, unknown> | undefined = args.context;
  if (typeof args.context === 'string' && args.context.trim().startsWith('{')) {
    try {
      parsedContext = JSON.parse(args.context);
    } catch {
      parsedContext = args.context;
    }
  }

  return await opened.engine.policyLatch(
    {
      key: {
        namespace: args.namespace ?? '',
        kind: args.kind ?? 'rule',
        id: args.id,
      },
      context: parsedContext,
      author: args.author,
      action: args.action,
      minTrust,
    },
    { now: environment.now() },
  );
}

export function renderPolicy(outcome: PolicyLatchOutcome): string {
  const lines: string[] = [];
  const statusUpper = outcome.status.toUpperCase();
  const allowStr = outcome.allowed ? 'ALLOW' : outcome.latched ? 'LATCHED (ESCALATE)' : 'BLOCK';

  lines.push(`policy: ${allowStr} [${outcome.reason}]`);
  lines.push(`  recommendation: ${outcome.recommendation}`);
  lines.push(`  status:         ${statusUpper}`);
  lines.push(`  trust:          ${outcome.trust.toFixed(3)}`);
  lines.push(`  requires human: ${outcome.requiresHuman}`);
  lines.push(`  explanation:    ${outcome.explanation}`);

  if (outcome.matchedCase) {
    lines.push(
      `  matched branch: ${outcome.matchedCase.id} (${outcome.matchedCase.condition}) -> ${outcome.matchedCase.decision.type}`,
    );
  }
  if (outcome.escalationInstructions) {
    lines.push(`  escalation:     ${outcome.escalationInstructions}`);
  }

  return `${lines.join('\n')}\n`;
}
