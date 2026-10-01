import { describe, expect, it } from 'bun:test';
import { round6 as tsRound6 } from '../rounding.ts';
import { isRustCoreAvailable, loadRustCore } from '../rust-bridge.ts';
import { wilsonLowerBound as tsWilsonLower } from '../wilson.ts';

describe('NAPI-RS Rust Core Bridge', () => {
  it('detects native Rust core availability safely', () => {
    const available = isRustCoreAvailable();
    expect(typeof available).toBe('boolean');
  });

  const native = loadRustCore();

  if (native) {
    describe('Native Rust bindings parity', () => {
      it('computes round6 identical to TS', () => {
        expect(native.round6(0.1234567)).toBe(0.123457);
        expect(native.round6(0.1234567)).toBe(tsRound6(0.1234567));
        expect(native.round6(0.1234564)).toBe(0.123456);
        expect(native.round6(-0.1234565)).toBe(-0.123457);
        expect(native.round6(0.0)).toBe(0.0);
      });

      it('computes wilsonLowerBound identical to TS', () => {
        expect(native.wilsonLowerBound(0, 0)).toBe(0);
        expect(native.wilsonLowerBound(0, 0)).toBe(tsWilsonLower(0, 0));

        const nativeL = native.wilsonLowerBound(2, 2);
        const tsL = tsWilsonLower(2, 2);
        expect(nativeL).toBe(tsL);
        expect(nativeL).toBe(0.342372);
      });

      it('computes recencyFactor properly', () => {
        expect(native.recencyFactor(null, 1000)).toBe(0.3);
        expect(native.recencyFactor(1000, 1000)).toBe(1.0);
      });

      it('computes durabilityFactor properly', () => {
        expect(native.durabilityFactor(0, true)).toBe(1.0);
        expect(native.durabilityFactor(5, false)).toBe(1.0);
        expect(native.durabilityFactor(5, true)).toBeGreaterThan(1.0);
      });

      it('computes guardFactor according to spec §4.1', () => {
        expect(native.guardFactor('none', null)).toBe(0.5);
        expect(native.guardFactor('none', true)).toBe(0.5);
        expect(native.guardFactor('oracle', true)).toBe(1.0);
        expect(native.guardFactor('oracle', false)).toBe(0.0);
        expect(native.guardFactor('oracle', null)).toBe(0.8);
      });

      it('computes emaStep properly', () => {
        expect(native.emaStep(null, 1.0, 0.2)).toBe(0.2);
        expect(native.emaStep(0.5, 1.0, 0.2)).toBe(0.6);
      });

      it('computes drift report with direction', () => {
        const report = native.computeDrift(20, 0.05, 0.5);
        expect(report.isDrifting).toBe(true);
        expect(report.isDriftingDown).toBe(true);
        expect(report.direction).toBe('down');
        expect(report.driftDelta).toBe(0.45);
      });

      it('computes trust and status end-to-end', () => {
        const result = native.computeTrustAndStatus(
          { k: 10, n: 10, contextRejects: 0 },
          { kind: 'oracle', lastOk: true, lastOkAt: 1000 },
          3,
          { mu: 0.8, theta0: 0.5, sampleCount: 10 },
          1000,
          1000,
          'probation',
        );

        expect(result.trust).toBeGreaterThan(0.5);
        expect(result.status).toBe('trusted');
        expect(result.breakdown.wilsonLower).toBeGreaterThan(0.5);
        expect(result.breakdown.durability).toBeGreaterThan(1.0);
        expect(result.breakdown.guardFactor).toBe(1.0);
      });
    });
  }
});
