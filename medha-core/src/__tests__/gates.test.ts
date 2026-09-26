import { describe, expect, test } from 'bun:test';
import { freshState } from '../entity.ts';
import { applySignal } from '../fold.ts';
import { buildHint, evaluateGates } from '../hint.ts';
import { APPLY, REJECT_RULE } from '../signals.ts';

const START = 1_700_000_000_000;
const KEY = { namespace: 'n', kind: 'rule', id: 'r1' };
const PASSED = { kind: 'ci', lastOk: true, lastOkAt: START } as const;
const FAILED = { kind: 'ci', lastOk: false, lastOkAt: START } as const;

/** Every guard × signal-history combination the fold can reach in a small grid. */
function* states() {
  for (const guard of [undefined, PASSED, FAILED]) {
    for (const applies of [0, 1, 5, 12, 40]) {
      for (const rejects of [0, 2, 8]) {
        let state = freshState(KEY, START, guard ? { guard, theta0: 0.9 } : { theta0: 0.9 });
        let t = START;
        for (let i = 0; i < applies; i++) {
          t += 1000;
          state = applySignal(state, { spec: APPLY }, { now: t }).state;
        }
        for (let i = 0; i < rejects; i++) {
          t += 1000;
          state = applySignal(state, { spec: REJECT_RULE }, { now: t }).state;
        }
        yield { state, now: t + 1000 };
      }
    }
  }
}

describe('gates — one evaluation shared by hint and explain-threshold', () => {
  test('hint flags equal gate verdicts, and a gate is met iff all its conditions are', () => {
    let checked = 0;
    for (const { state, now } of states()) {
      const hint = buildHint(state, now);
      const [trusted, active, drifting] = evaluateGates(state, hint.trustScore);
      expect(hint.clearsThreshold.trusted).toBe(trusted.met);
      expect(hint.clearsThreshold.active).toBe(active.met);
      expect(hint.temporal.isDrifting).toBe(drifting.met);
      expect(hint.temporal.driftDelta).toBe(drifting.value);
      for (const gate of [trusted, active, drifting]) {
        expect(gate.met).toBe(gate.conditions.every((c) => c.met));
      }
      checked++;
    }
    expect(checked).toBe(45);
  });

  test('a failed or absent guard is reported as an unmet trusted condition', () => {
    for (const guard of [FAILED, undefined]) {
      let state = freshState(KEY, START, guard ? { guard, theta0: 0.9 } : { theta0: 0.9 });
      for (let i = 0; i < 40; i++) {
        state = applySignal(state, { spec: APPLY }, { now: START + i * 1000 }).state;
      }
      const hint = buildHint(state, START + 41_000);
      const [trusted] = evaluateGates(state, hint.trustScore);
      expect(trusted.met).toBe(false);
      expect(trusted.conditions.find((c) => c.name === 'guard')?.met).toBe(false);
    }
  });
});
