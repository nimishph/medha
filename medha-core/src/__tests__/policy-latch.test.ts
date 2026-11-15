import { describe, expect, test } from 'bun:test';
import type { DecisionCase } from '../decision.ts';
import type { EntityState } from '../entity.ts';
import type { KindSpec } from '../kinds.ts';
import { evaluatePolicyLatch, matchCondition, type PolicyLatchInput } from '../policy-latch.ts';

describe('PolicyLatch (medha-534)', () => {
  const NOW = 1_700_000_000_000;

  function makeState(overrides: Partial<EntityState> = {}): EntityState {
    return {
      key: { namespace: '', kind: 'rule', id: 'rule-1' },
      evidence: { k: 10, n: 10, contextRejects: 0 },
      ema: { mu: 0.9, theta0: 0.5, updatedAt: NOW },
      guard: { kind: 'test', lastOk: true, lastOkAt: NOW },
      anchors: [],
      status: 'trusted',
      override: null,
      retiredAt: null,
      restoredAt: null,
      updater: 'ema',
      createdAt: NOW - 10_000,
      lastSignalAt: NOW,
      ...overrides,
    };
  }

  const makeCase = (overrides: Partial<DecisionCase> = {}): DecisionCase => ({
    id: 'case-1',
    condition: "env == 'production'",
    decision: { type: 'apply' },
    evidence: { k: 10, n: 10, contextRejects: 0 },
    ema: { mu: 0.95, theta0: 0.5, updatedAt: NOW },
    ...overrides,
  });

  describe('matchCondition', () => {
    test('matches empty or wildcard condition always', () => {
      expect(matchCondition('', { env: 'dev' })).toBe(true);
      expect(matchCondition('*', 'anything')).toBe(true);
      expect(matchCondition('always', undefined)).toBe(true);
    });

    test('matches key-value equality and inequality with object context', () => {
      const ctx = { env: 'production', tier: 'web' };
      expect(matchCondition("env == 'production'", ctx)).toBe(true);
      expect(matchCondition("env == 'staging'", ctx)).toBe(false);
      expect(matchCondition("tier != 'db'", ctx)).toBe(true);
      expect(matchCondition("tier != 'web'", ctx)).toBe(false);
    });

    test('matches compound clauses with &&', () => {
      const ctx = { env: 'production', risk: 'high' };
      expect(matchCondition("env == 'production' && risk == 'high'", ctx)).toBe(true);
      expect(matchCondition("env == 'production' && risk == 'low'", ctx)).toBe(false);
    });

    test('matches membership in [a, b]', () => {
      const ctx = { role: 'admin' };
      expect(matchCondition('role in [admin, superuser]', ctx)).toBe(true);
      expect(matchCondition('role in [guest, viewer]', ctx)).toBe(false);
    });

    test('matches string context against substring condition', () => {
      expect(matchCondition('production', 'in production env')).toBe(true);
      expect(matchCondition('staging', 'in production env')).toBe(false);
    });
  });

  describe('evaluatePolicyLatch', () => {
    test('blocks if entity does not exist', () => {
      const input: PolicyLatchInput = {
        key: { namespace: '', kind: 'rule', id: 'missing' },
      };
      const res = evaluatePolicyLatch(null, [], undefined, input, NOW);
      expect(res.allowed).toBe(false);
      expect(res.recommendation).toBe('block');
      expect(res.reason).toBe('entity_not_found');
    });

    test('latches if entity is retired (StatusLatch)', () => {
      const state = makeState({ status: 'retired' });
      const input: PolicyLatchInput = {
        key: state.key,
        author: 'agent:runner',
      };
      const res = evaluatePolicyLatch(state, [], undefined, input, NOW);
      expect(res.allowed).toBe(false);
      expect(res.latched).toBe(true);
      expect(res.requiresHuman).toBe(true);
      expect(res.recommendation).toBe('escalate_to_human');
      expect(res.reason).toBe('status_latched');
      expect(res.escalationInstructions).toContain('medha reinstate');
    });

    test('latches if entity is quarantined (StatusLatch)', () => {
      const state = makeState({ status: 'quarantined' });
      const input: PolicyLatchInput = {
        key: state.key,
        author: 'agent:runner',
      };
      const res = evaluatePolicyLatch(state, [], undefined, input, NOW);
      expect(res.allowed).toBe(false);
      expect(res.latched).toBe(true);
      expect(res.requiresHuman).toBe(true);
      expect(res.recommendation).toBe('escalate_to_human');
      expect(res.reason).toBe('status_latched');
    });

    test('latches if decisionPolicy.requireHumanFor gates apply and author is agent', () => {
      const state = makeState({ status: 'trusted' });
      const kindSpec: KindSpec = {
        name: 'rule',
        decisionPolicy: { requireHumanFor: ['apply'] },
      };
      const branch = makeCase({
        condition: "env == 'production'",
        decision: { type: 'apply' },
      });
      const input: PolicyLatchInput = {
        key: state.key,
        context: { env: 'production' },
        author: 'agent:claude',
      };

      const res = evaluatePolicyLatch(state, [branch], kindSpec, input, NOW);
      expect(res.allowed).toBe(false);
      expect(res.latched).toBe(true);
      expect(res.requiresHuman).toBe(true);
      expect(res.recommendation).toBe('escalate_to_human');
      expect(res.reason).toBe('require_human_gate');
      expect(res.explanation).toContain("gates 'apply' decisions via requireHumanFor");
    });

    test('approves if requireHumanFor gates apply and author is a verified human', () => {
      const state = makeState({ status: 'trusted' });
      const kindSpec: KindSpec = {
        name: 'rule',
        decisionPolicy: { requireHumanFor: ['apply'] },
      };
      const branch = makeCase({
        condition: "env == 'production'",
        decision: { type: 'apply' },
      });
      const input: PolicyLatchInput = {
        key: state.key,
        context: { env: 'production' },
        author: 'human:alice',
      };

      const res = evaluatePolicyLatch(state, [branch], kindSpec, input, NOW);
      expect(res.allowed).toBe(true);
      expect(res.latched).toBe(false);
      expect(res.requiresHuman).toBe(false);
      expect(res.recommendation).toBe('proceed');
      expect(res.reason).toBe('approved');
      expect(res.matchedCase?.id).toBe('case-1');
    });

    test('skips if matched decision branch prescribes ignore', () => {
      const state = makeState({ status: 'trusted' });
      const branch = makeCase({
        condition: "env == 'container'",
        decision: { type: 'ignore' },
      });
      const input: PolicyLatchInput = {
        key: state.key,
        context: { env: 'container' },
        author: 'agent:worker',
      };

      const res = evaluatePolicyLatch(state, [branch], undefined, input, NOW);
      expect(res.allowed).toBe(false);
      expect(res.latched).toBe(false);
      expect(res.requiresHuman).toBe(false);
      expect(res.recommendation).toBe('skip');
      expect(res.reason).toBe('decision_ignore');
    });

    test('approves when trusted entity has no decision tree and no requireHumanFor restriction', () => {
      const state = makeState({ status: 'trusted' });
      const input: PolicyLatchInput = {
        key: state.key,
        author: 'agent:worker',
      };

      const res = evaluatePolicyLatch(state, [], undefined, input, NOW);
      expect(res.allowed).toBe(true);
      expect(res.recommendation).toBe('proceed');
      expect(res.reason).toBe('approved');
    });

    test('blocks when entity trust is below minTrust', () => {
      const state = makeState({
        status: 'trusted',
        evidence: { k: 2, n: 5, contextRejects: 0 },
      });
      const input: PolicyLatchInput = {
        key: state.key,
        minTrust: 0.8,
      };

      const res = evaluatePolicyLatch(state, [], undefined, input, NOW);
      expect(res.allowed).toBe(false);
      expect(res.recommendation).toBe('block');
      expect(res.reason).toBe('entity_untrusted');
    });
  });
});
