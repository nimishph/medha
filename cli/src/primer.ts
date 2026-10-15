/**
 * Paginated, token-frugal primer for agents and developers (§14.4, medha-168.2).
 * Provides focused, 25-50 line explanations of Medha concepts to prevent context bloat.
 */

import {
  ACTIVE_THRESHOLD,
  APPLY,
  DEFAULT_EMA_ALPHA,
  DEFAULT_THETA0,
  DRIFT_THRESHOLD,
  DURABILITY_MAX,
  guardFactor,
  InvalidArgumentError,
  MIN_SAMPLES_FOR_DRIFT,
  MIN_USES_FOR_RETIRED,
  MIN_USES_FOR_TRUSTED,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  REJECT_CONTEXT,
  REJECT_RULE,
  RETIRED_TRUST_THRESHOLD,
  SKIP,
  TRUSTED_THRESHOLD,
  UNGUARDED_TRUST_CEILING,
  WILSON_Z,
  wilsonLowerBound,
} from '@cntxt-labs/medha-core';
import { PRIMER_TEMPLATES, type PrimerPlaceholder } from './primer-topics.ts';

export interface PrimerTopicInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
}

/**
 * The value of every primer placeholder, from the kernel's own constants and functions. The Rust
 * CLI fills the same placeholders from its kernel (crates/medha-cli/src/primer.rs).
 */
export function primerValues(): Record<PrimerPlaceholder, string> {
  const guard = (lastOk: boolean | null, kind = 'ci') =>
    String(guardFactor({ kind, lastOk, lastOkAt: null }));
  return {
    ACTIVE_THRESHOLD: String(ACTIVE_THRESHOLD),
    TRUSTED_THRESHOLD: String(TRUSTED_THRESHOLD),
    MIN_USES_FOR_TRUSTED: String(MIN_USES_FOR_TRUSTED),
    UNGUARDED_TRUST_CEILING: String(UNGUARDED_TRUST_CEILING),
    RETIRED_TRUST_THRESHOLD: String(RETIRED_TRUST_THRESHOLD),
    MIN_USES_FOR_RETIRED: String(MIN_USES_FOR_RETIRED),
    DRIFT_THRESHOLD: String(DRIFT_THRESHOLD),
    MIN_SAMPLES_FOR_DRIFT: String(MIN_SAMPLES_FOR_DRIFT),
    DEFAULT_EMA_ALPHA: String(DEFAULT_EMA_ALPHA),
    DEFAULT_THETA0: String(DEFAULT_THETA0),
    RECENCY_HALF_LIFE_DAYS: String(RECENCY_HALF_LIFE_DAYS),
    RECENCY_FLOOR: String(RECENCY_FLOOR),
    DURABILITY_MAX: String(DURABILITY_MAX),
    WILSON_Z: String(WILSON_Z),
    L_2_OF_2: wilsonLowerBound(2, 2).toFixed(2),
    L_200_OF_200: wilsonLowerBound(200, 200).toFixed(2),
    G_PASSED: guard(true),
    G_UNVERIFIED: guard(null),
    G_NONE: guard(null, 'none'),
    G_FAILED: guard(false),
    APPLY_VALUE: String(APPLY.value),
    REJECT_RULE_VALUE: String(REJECT_RULE.value),
    SKIP_VALUE: String(SKIP.value),
    REJECT_CONTEXT_VALUE: String(REJECT_CONTEXT.value),
  };
}

/** Fill `{{NAME}}` placeholders; an unknown name is left as written, for the test to catch. */
export function fillPrimer(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => values[name] ?? match);
}

export const PRIMER_TOPICS: Record<string, PrimerTopicInfo> = (() => {
  const values = primerValues();
  return Object.fromEntries(
    PRIMER_TEMPLATES.map((t) => [
      t.name,
      {
        name: t.name,
        title: t.title,
        description: t.description,
        content: fillPrimer(t.template, values),
      },
    ]),
  );
})();

export const PRIMER_TOPIC_NAMES = Object.keys(PRIMER_TOPICS);

export interface PrimerResult {
  readonly topic: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
  readonly lineCount: number;
  readonly availableTopics: readonly {
    readonly name: string;
    readonly title: string;
    readonly description: string;
  }[];
}

/**
 * Retrieve primer content for a topic. If topic is omitted or empty, returns an index overview.
 */
export function getPrimer(rawTopic?: string | undefined): PrimerResult {
  const normalized = (rawTopic ?? '').trim().toLowerCase();
  const availableTopics = PRIMER_TOPIC_NAMES.map((name) => {
    const info = PRIMER_TOPICS[name];
    if (!info) {
      throw new InvalidArgumentError('name', 'a valid topic', name);
    }
    return {
      name,
      title: info.title,
      description: info.description,
    };
  });

  if (normalized === '' || normalized === 'index' || normalized === 'help') {
    const lines = [
      '# Medha Primer Index',
      '',
      'Medha is an evidential memory engine. Use this primer for token-frugal agent guidance.',
      '',
      '### Available Topics',
      ...availableTopics.map((t) => `- **\`${t.name}\`**: ${t.title} — *${t.description}*`),
      '',
      '### Usage',
      '- CLI: `medha primer <topic>` (e.g. `medha primer signals`)',
      '- CLI JSON: `medha primer <topic> --json`',
      '- MCP Tool: `primer(topic: "guards")`',
    ];
    const content = lines.join('\n');
    return {
      topic: 'index',
      title: 'Medha Primer: Available Topics',
      description: 'Index of available agent primer topics.',
      content,
      lineCount: lines.length,
      availableTopics,
    };
  }

  const topicInfo = PRIMER_TOPICS[normalized];
  if (!topicInfo) {
    const valid = PRIMER_TOPIC_NAMES.map((t) => `'${t}'`).join(', ');
    throw new InvalidArgumentError('topic', `one of ${valid}`, rawTopic);
  }

  const lines = topicInfo.content.split('\n');
  return {
    topic: topicInfo.name,
    title: topicInfo.title,
    description: topicInfo.description,
    content: topicInfo.content,
    lineCount: lines.length,
    availableTopics,
  };
}

/**
 * Render primer output for console or stdout.
 */
export function renderPrimer(result: PrimerResult, compact = false): string {
  if (compact) {
    return result.content;
  }
  return `${result.content}\n\n---\n*Medha Primer (${result.topic}) | Run 'medha primer' to view all topics.*`;
}
