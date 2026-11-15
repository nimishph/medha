import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

describe('Medha.policyLatch (medha-534)', () => {
  const NOW = 1_700_000_000_000;

  test('refuses un-reinstated status latch on retired entity', async () => {
    const store = new MemoryStore();
    const engine = new Medha({ store });

    await engine.propose(
      { key: { namespace: '', kind: 'rule', id: 'legacy-eval' }, provenance: 'test-rule' },
      { now: NOW },
    );
    // Force retirement
    await engine.override(
      { namespace: '', kind: 'rule', id: 'legacy-eval' },
      'retire',
      { now: NOW + 10 },
      'Rule obsolete',
    );

    const outcome = await engine.policyLatch(
      {
        key: { namespace: '', kind: 'rule', id: 'legacy-eval' },
        author: 'agent:worker',
      },
      { now: NOW + 20 },
    );

    expect(outcome.allowed).toBe(false);
    expect(outcome.latched).toBe(true);
    expect(outcome.requiresHuman).toBe(true);
    expect(outcome.recommendation).toBe('escalate_to_human');
    expect(outcome.reason).toBe('status_latched');
    expect(outcome.escalationInstructions).toContain('medha reinstate');
  });

  test('human review gatekeeper via requireHumanFor gates agent mutations', async () => {
    const store = new MemoryStore({
      registries: {
        kinds: ['critical-gate'],
        signalSpecs: [],
        anchorKinds: [],
        kindSpecs: [
          {
            name: 'critical-gate',
            decisionPolicy: { requireHumanFor: ['apply'] },
          },
        ],
      },
    });
    const engine = new Medha({ store });

    const key = { namespace: '', kind: 'critical-gate', id: 'deploy-prod' };
    await engine.propose({ key, provenance: 'production deployment gate' }, { now: NOW });

    // Append decision branch requiring human
    await engine.decision(
      key,
      {
        condition: "env == 'production'",
        decision: { type: 'apply' },
      },
      { now: NOW + 10 },
      { author: 'human:admin' },
    );

    // 1. Agent asks: must be latched / escalate to human
    const agentOutcome = await engine.policyLatch(
      {
        key,
        context: { env: 'production' },
        author: 'agent:ci-bot',
      },
      { now: NOW + 20 },
    );

    expect(agentOutcome.allowed).toBe(false);
    expect(agentOutcome.latched).toBe(true);
    expect(agentOutcome.requiresHuman).toBe(true);
    expect(agentOutcome.recommendation).toBe('escalate_to_human');
    expect(agentOutcome.reason).toBe('require_human_gate');

    // 2. Human operator asks: approved to proceed
    const humanOutcome = await engine.policyLatch(
      {
        key,
        context: { env: 'production' },
        author: 'human:alice',
      },
      { now: NOW + 30 },
    );

    expect(humanOutcome.allowed).toBe(true);
    expect(humanOutcome.latched).toBe(false);
    expect(humanOutcome.requiresHuman).toBe(false);
    expect(humanOutcome.recommendation).toBe('proceed');
    expect(humanOutcome.reason).toBe('approved');
  });

  test('skips when context matches an ignore decision branch', async () => {
    const store = new MemoryStore();
    const engine = new Medha({ store });

    const key = { namespace: '', kind: 'rule', id: 'lint-check' };
    await engine.propose({ key, provenance: 'lint check' }, { now: NOW });
    await engine.decision(
      key,
      {
        condition: 'file in [vendor.js, bundle.js]',
        decision: { type: 'ignore' },
      },
      { now: NOW + 10 },
    );

    const outcome = await engine.policyLatch(
      {
        key,
        context: { file: 'vendor.js' },
        author: 'agent:linter',
      },
      { now: NOW + 20 },
    );

    expect(outcome.allowed).toBe(false);
    expect(outcome.latched).toBe(false);
    expect(outcome.recommendation).toBe('skip');
    expect(outcome.reason).toBe('decision_ignore');
  });
});
