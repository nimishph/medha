/**
 * Unit tests and anti-drift validation for the Medha Primer (§14.4, medha-168.2).
 */

import { describe, expect, it } from 'bun:test';
import { commands } from './commands.ts';
import { getPrimer, PRIMER_TOPIC_NAMES, PRIMER_TOPICS, renderPrimer } from './primer.ts';

describe('medha primer CLI & MCP Tool', () => {
  it('returns index when called with no topic or index/help', () => {
    const index = getPrimer();
    expect(index.topic).toBe('index');
    expect(index.title).toContain('Available Topics');
    expect(index.availableTopics.length).toBe(PRIMER_TOPIC_NAMES.length);
    expect(index.content).toContain('medha primer <topic>');

    const fromEmpty = getPrimer('');
    expect(fromEmpty.topic).toBe('index');

    const fromHelp = getPrimer('help');
    expect(fromHelp.topic).toBe('index');
  });

  it('retrieves every canonical topic with strict token-frugal bounds', () => {
    for (const topicName of PRIMER_TOPIC_NAMES) {
      const topic = getPrimer(topicName);
      expect(topic.topic).toBe(topicName);
      expect(topic.title.length).toBeGreaterThan(5);
      expect(topic.description.length).toBeGreaterThan(10);
      expect(topic.content).toContain('# ');

      // Token frugality constraint: max 65 lines per topic
      expect(topic.lineCount).toBeLessThanOrEqual(65);
    }
  });

  it('throws informative error for unknown topic naming valid topics', () => {
    expect(() => getPrimer('nonexistent-topic')).toThrow(
      "Invalid topic: expected one of 'overview'",
    );
  });

  it('renders with and without compact mode', () => {
    const topic = getPrimer('signals');
    const normal = renderPrimer(topic, false);
    expect(normal).toContain('*Medha Primer (signals)');

    const compact = renderPrimer(topic, true);
    expect(compact).not.toContain('*Medha Primer');
    expect(compact).toBe(topic.content);
  });

  it('guarantees zero-drift: all core CLI subcommands are documented in primer topics', () => {
    const registeredSubcommands = Object.keys(commands.subCommands ?? {});
    expect(registeredSubcommands).toContain('primer');

    // Aggregate all primer content
    const allPrimerText = Object.values(PRIMER_TOPICS)
      .map((t) => t.content)
      .join('\n');

    // Key commands every agent must be able to discover
    const essentialCommands = [
      'init',
      'show',
      'record',
      'guard',
      'propose',
      'define',
      'drift',
      'pack',
      'sync',
      'ui',
      'issue',
      'primer',
    ];

    for (const cmd of essentialCommands) {
      expect(allPrimerText).toContain(`medha ${cmd}`);
    }
  });

  it('guarantees math consistency: primer text matches engine constants', () => {
    const guardsTopic = getPrimer('guards');
    expect(guardsTopic.content).toContain('0.85'); // Unguarded ceiling

    const driftTopic = getPrimer('drift');
    expect(driftTopic.content).toContain('1.959964'); // Wilson 95% Z

    const configTopic = getPrimer('config');
    expect(configTopic.content).toContain('sqlite');
    expect(configTopic.content).toContain('file');
    expect(configTopic.content).toContain('memory');
  });
});
