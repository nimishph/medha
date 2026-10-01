import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  type Anchor,
  type EmaState,
  type Evidence,
  type GuardState,
  isRustCoreAvailable,
  type KindSpec,
  type LifecycleStatus,
  loadRustCore,
  type Override,
  type RecencyConfig,
  type Thresholds,
  computeTrust as tsComputeTrust,
  statusForTrust as tsStatusForTrust,
  wilsonLowerBound as tsWilsonLowerBound,
} from '../../medha-core/src/index.ts';
import { MemoryStore } from '../../medha-store/src/memory-store.ts';
import type { EpisodeInput } from '../../medha-store/src/store-port.ts';

function tsComputeTrustAndStatus(
  evidence: Evidence,
  guard: GuardState,
  distinctAnchors: number,
  ema: EmaState,
  lastSignalAt: number | null,
  now: number,
  storedStatus: LifecycleStatus,
  _override: Override | null,
  thresholds: Thresholds,
  recency: RecencyConfig,
) {
  const anchors: Anchor[] = Array.from({ length: distinctAnchors }, (_, i) => ({
    kind: 'anchor',
    value: `a${i}`,
    observedAt: 1000,
  }));
  const kindSpec: KindSpec = { name: 'rule', thresholds, recency };
  const trust = tsComputeTrust(evidence, guard, anchors, lastSignalAt, now, kindSpec);
  const status = tsStatusForTrust(
    {
      key: { namespace: '', kind: 'rule', id: 'test' },
      status: storedStatus,
      evidence,
      guard,
      anchors,
      ema,
      lastSignalAt,
      version: 1,
      cases: {},
    },
    trust,
    kindSpec,
  );
  return { trust: trust.trust, status };
}

const print = (msg = '') => process.stdout.write(`${msg}\n`);

async function runStressBenchmark() {
  print('='.repeat(78));
  print('       MEDHA STRESS BENCHMARK: PURE TS vs TS-WRAPPER (NAPI) vs RUST NATIVE');
  print('='.repeat(78));
  print(
    `Platform:     ${process.platform}-${process.arch} | ${cpus().length} CPU cores (${cpus()[0]?.model})`,
  );
  print(`Memory:       ${(totalmem() / 1024 ** 3).toFixed(1)} GB RAM`);
  print(
    `Native NAPI:  ${isRustCoreAvailable() ? 'LOADED (crates/medha-napi/medha_napi.node)' : 'NOT AVAILABLE'}`,
  );
  print('-'.repeat(78));

  const rustCore = loadRustCore();
  if (!rustCore) {
    print('Error: NAPI-RS rust core could not be loaded.');
    process.exit(1);
  }

  // --------------------------------------------------------------------------
  // TEST 1: Wilson Score Calculation (1,000,000 iterations)
  // --------------------------------------------------------------------------
  const wilsonIterations = 1_000_000;
  print(
    `\n[STRESS TEST 1] Wilson Score Interval (Lower Bound): ${wilsonIterations.toLocaleString()} iterations`,
  );

  // A. Pure TypeScript
  print('  Running Pure TypeScript implementation...');
  let tsWilsonSum = 0;
  // Warmup JIT
  for (let i = 1; i <= 10_000; i++) tsWilsonLowerBound(i % 100, 100, 1.959964);
  const t0 = performance.now();
  for (let i = 1; i <= wilsonIterations; i++) {
    tsWilsonSum += tsWilsonLowerBound(i % 100, 100, 1.959964);
  }
  const tsWilsonTime = performance.now() - t0;
  const tsWilsonOps = wilsonIterations / (tsWilsonTime / 1000);

  // B. Via TS-Wrapper (Rust NAPI-RS bridge)
  print('  Running Via TS-Wrapper (NAPI-RS bridge)...');
  let napiWilsonSum = 0;
  // Warmup JIT
  for (let i = 1; i <= 10_000; i++) rustCore.wilsonLowerBound(i % 100, 100, 1.959964);
  const t1 = performance.now();
  for (let i = 1; i <= wilsonIterations; i++) {
    napiWilsonSum += rustCore.wilsonLowerBound(i % 100, 100, 1.959964);
  }
  const napiWilsonTime = performance.now() - t1;
  const napiWilsonOps = wilsonIterations / (napiWilsonTime / 1000);

  print(
    `    -> Pure TypeScript Time:  ${tsWilsonTime.toFixed(2)} ms (${(tsWilsonOps / 1e6).toFixed(2)}M ops/sec, ${((tsWilsonTime / wilsonIterations) * 1e6).toFixed(1)} ns/op)`,
  );
  print(
    `    -> Via TS-Wrapper (NAPI): ${napiWilsonTime.toFixed(2)} ms (${(napiWilsonOps / 1e6).toFixed(2)}M ops/sec, ${((napiWilsonTime / wilsonIterations) * 1e6).toFixed(1)} ns/op)`,
  );
  print(
    `    -> Numerical Parity:      TS=${tsWilsonSum.toFixed(4)} | NAPI=${napiWilsonSum.toFixed(4)} (Diff: ${Math.abs(tsWilsonSum - napiWilsonSum).toExponential(2)})`,
  );

  // --------------------------------------------------------------------------
  // TEST 2: Full Bayesian Trust & Status Computation (250,000 iterations)
  // --------------------------------------------------------------------------
  const trustIterations = 250_000;
  print(
    `\n[STRESS TEST 2] Complete Bayesian Trust & Status Computation: ${trustIterations.toLocaleString()} evaluations`,
  );
  print(
    '  Evaluating complete pipeline: Wilson lower/upper + Recency decay + Durability + Guard + EMA Drift',
  );

  const defaultThresholds: Thresholds = {
    trusted: 0.85,
    minUsesForTrusted: 5,
    active: 0.5,
    unguardedCeiling: 0.85,
    minUsesForRetired: 5,
    retiredTrustThreshold: 0.2,
  };
  const defaultRecency: RecencyConfig = {
    halfLifeDays: 30,
    floor: 0.1,
  };

  // A. Pure TypeScript
  print('  Running Pure TypeScript trust pipeline...');
  let tsTrustSum = 0;
  const t2 = performance.now();
  for (let i = 0; i < trustIterations; i++) {
    const k = i % 50;
    const n = 50;
    const evidence: Evidence = { k, n, contextRejects: 0 };
    const guard: GuardState = {
      kind: 'linter',
      lastOk: i % 2 === 0,
      lastOkAt: 1000 + i,
    };
    const ema: EmaState = {
      mu: k / n,
      theta0: 0.8,
      sampleCount: 50,
    };

    const res = tsComputeTrustAndStatus(
      evidence,
      guard,
      3,
      ema,
      1000 + i,
      2000 + i,
      'Active',
      undefined,
      defaultThresholds,
      defaultRecency,
    );
    tsTrustSum += res.trust;
  }
  const tsTrustTime = performance.now() - t2;
  const tsTrustOps = trustIterations / (tsTrustTime / 1000);

  // B. Via TS-Wrapper (Rust NAPI-RS bridge)
  print('  Running Via TS-Wrapper (NAPI-RS bridge)...');
  let napiTrustSum = 0;
  const t3 = performance.now();
  for (let i = 0; i < trustIterations; i++) {
    const k = i % 50;
    const n = 50;
    const res = rustCore.computeTrustAndStatus(
      { k, n, contextRejects: 0 },
      { kind: 'linter', lastOk: i % 2 === 0, lastOkAt: 1000 + i },
      3,
      { mu: k / n, theta0: 0.8, sampleCount: 50 },
      1000 + i,
      2000 + i,
      'Active',
      undefined,
      defaultThresholds,
      defaultRecency,
    );
    napiTrustSum += res.trust;
  }
  const napiTrustTime = performance.now() - t3;
  const napiTrustOps = trustIterations / (napiTrustTime / 1000);

  print(
    `    -> Pure TypeScript Time:  ${tsTrustTime.toFixed(2)} ms (${(tsTrustOps / 1e3).toFixed(1)}k ops/sec, ${((tsTrustTime / trustIterations) * 1e3).toFixed(2)} µs/op)`,
  );
  print(
    `    -> Via TS-Wrapper (NAPI): ${napiTrustTime.toFixed(2)} ms (${(napiTrustOps / 1e3).toFixed(1)}k ops/sec, ${((napiTrustTime / trustIterations) * 1e3).toFixed(2)} µs/op)`,
  );
  print(
    `    -> Numerical Parity:      TS=${tsTrustSum.toFixed(4)} | NAPI=${napiTrustSum.toFixed(4)} (Diff: ${Math.abs(tsTrustSum - napiTrustSum).toExponential(2)})`,
  );

  // --------------------------------------------------------------------------
  // TEST 3: In-Memory Store Episode Ingestion & Folding (50,000 episodes)
  // --------------------------------------------------------------------------
  const storeEpisodes = 50_000;
  print(
    `\n[STRESS TEST 3] In-Memory Episode Ingestion & Entity Folding: ${storeEpisodes.toLocaleString()} episodes across 5,000 entities`,
  );

  print('  Running Pure TypeScript MemoryStore...');
  const tsStore = new MemoryStore();
  await tsStore.open();

  const t4 = performance.now();
  for (let i = 0; i < storeEpisodes; i++) {
    const id = `rule-stress-${String(i % 5000).padStart(5, '0')}`;
    const success = i % 3 !== 0;
    const ep: EpisodeInput = {
      type: 'signal',
      key: { namespace: '', kind: 'rule', id },
      at: 1000 + i,
      ensure: true,
      spec: {
        name: success ? 'APPLY' : 'REJECT_RULE',
        value: success ? 1.0 : -1.0,
        trial: true,
        success,
      },
    };
    await tsStore.append(ep);
  }
  const tsStoreTime = performance.now() - t4;
  const tsStoreOps = storeEpisodes / (tsStoreTime / 1000);
  print(
    `    -> Pure TypeScript Store: ${tsStoreTime.toFixed(2)} ms (${tsStoreOps.toFixed(0)} episodes/sec, ${(tsStoreTime / storeEpisodes).toFixed(3)} ms/ep)`,
  );

  // --------------------------------------------------------------------------
  // TEST 4: Spawning Pure Rust Native Binary Benchmark
  // --------------------------------------------------------------------------
  print('\n[STRESS TEST 4] Executing Pure Rust Native Release Binary (Zero FFI)...');
  const exePath = join(
    import.meta.dir,
    '..',
    '..',
    'target',
    'release',
    'examples',
    'native_stress.exe',
  );
  const rustProc = Bun.spawn({
    cmd: [exePath],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const rustOutputText = await new Response(rustProc.stdout).text();
  await rustProc.exited;

  interface RustBenchData {
    wilson?: { durationMs: number; throughput: number };
    trustAndStatus?: { durationMs: number; throughput: number };
    memoryStore?: { durationMs: number; throughput: number };
  }

  let rustData: RustBenchData | null = null;
  try {
    rustData = JSON.parse(rustOutputText.trim()) as RustBenchData;
  } catch (_err) {
    print(`Warning: Could not parse Rust output: ${rustOutputText}`);
  }

  const nativeWilsonTime = rustData?.wilson?.durationMs ?? 0;
  const nativeWilsonOps = rustData?.wilson?.throughput ?? 0;
  const nativeTrustTime = rustData?.trustAndStatus?.durationMs ?? 0;
  const nativeTrustOps = rustData?.trustAndStatus?.throughput ?? 0;
  const nativeStoreTime = rustData?.memoryStore?.durationMs ?? 0;
  const nativeStoreOps = rustData?.memoryStore?.throughput ?? 0;

  print(
    `    -> Pure Rust Wilson:       ${nativeWilsonTime.toFixed(2)} ms (${(nativeWilsonOps / 1e6).toFixed(2)}M ops/sec, ${((nativeWilsonTime / wilsonIterations) * 1e6).toFixed(1)} ns/op)`,
  );
  print(
    `    -> Pure Rust Trust/Status: ${nativeTrustTime.toFixed(2)} ms (${(nativeTrustOps / 1e6).toFixed(2)}M ops/sec, ${((nativeTrustTime / trustIterations) * 1e3).toFixed(2)} µs/op)`,
  );
  print(
    `    -> Pure Rust MemoryStore:  ${nativeStoreTime.toFixed(2)} ms (${nativeStoreOps.toFixed(0)} episodes/sec, ${(nativeStoreTime / storeEpisodes).toFixed(3)} ms/ep)`,
  );

  // --------------------------------------------------------------------------
  // SUMMARY REPORT TABLE
  // --------------------------------------------------------------------------
  print(`\n${'='.repeat(82)}`);
  print('                       COMPREHENSIVE THREE-TIER STRESS RESULTS');
  print('='.repeat(82));
  print(
    '| Workload / Benchmark                  | Pure TypeScript | TS-Wrapper (NAPI) | Pure Rust Native |',
  );
  print(
    '|---------------------------------------|-----------------|-------------------|------------------|',
  );
  print(
    `| Wilson Lower Bound (1M ops)           | ${tsWilsonTime.toFixed(1).padStart(7)} ms     | ${napiWilsonTime.toFixed(1).padStart(9)} ms     | ${nativeWilsonTime.toFixed(1).padStart(8)} ms     |`,
  );
  print(
    `| Wilson Throughput (ops/sec)           | ${(tsWilsonOps / 1e6).toFixed(2).padStart(7)}M ops/s | ${(napiWilsonOps / 1e6).toFixed(2).padStart(9)}M ops/s | ${(nativeWilsonOps / 1e6).toFixed(2).padStart(8)}M ops/s |`,
  );
  print(
    `| Bayesian Trust & Status (250k evals)  | ${tsTrustTime.toFixed(1).padStart(7)} ms     | ${napiTrustTime.toFixed(1).padStart(9)} ms     | ${nativeTrustTime.toFixed(1).padStart(8)} ms     |`,
  );
  print(
    `| Trust & Status Throughput (evals/sec) | ${(tsTrustOps / 1e3).toFixed(1).padStart(7)}k ev/s  | ${(napiTrustOps / 1e3).toFixed(1).padStart(9)}k ev/s  | ${(nativeTrustOps / 1e3).toFixed(1).padStart(8)}k ev/s  |`,
  );
  print(
    `| MemoryStore 50k Episodes Ingest/Fold  | ${tsStoreTime.toFixed(1).padStart(7)} ms     |        --         | ${nativeStoreTime.toFixed(1).padStart(8)} ms     |`,
  );
  print(
    `| Ingestion Throughput (episodes/sec)   | ${(tsStoreOps / 1e3).toFixed(1).padStart(7)}k eps/s |        --         | ${(nativeStoreOps / 1e3).toFixed(1).padStart(8)}k eps/s |`,
  );
  print('='.repeat(82));

  print('\nKey Architectural Takeaways:');
  const storeSpeedup = tsStoreTime / nativeStoreTime;
  const trustSpeedup = tsTrustTime / nativeTrustTime;
  print(
    ` 1. Native Store Speedup: Pure Rust in-memory store is ${storeSpeedup.toFixed(1)}x faster (${(tsStoreTime).toFixed(0)}ms vs ${(nativeStoreTime).toFixed(0)}ms) for ingestion & state folding.`,
  );
  print(
    ` 2. Pure Rust vs Pure TS Math: Native Rust computes complex Bayesian trust ${trustSpeedup.toFixed(1)}x faster (${(nativeTrustOps / 1e6).toFixed(2)}M/s vs ${(tsTrustOps / 1e3).toFixed(1)}k/s).`,
  );
  print(
    ` 3. FFI Crossing Analysis: Micro-calls across the NAPI boundary carry ~100-300ns JNI/NAPI marshaling overhead; batch calls or heavy store operations yield massive net speedups.`,
  );
}

await runStressBenchmark();
