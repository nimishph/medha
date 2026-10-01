import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadNativeBinding() {
  const rootDir = join(__dirname, '..', '..');
  const candidates = [
    join(__dirname, 'medha_napi.node'),
    join(rootDir, 'target', 'release', 'medha_napi.node'),
    join(rootDir, 'target', 'debug', 'medha_napi.node'),
    join(rootDir, 'target', 'release', 'medha_napi.dll'),
    join(rootDir, 'target', 'debug', 'medha_napi.dll'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return require(candidate);
      } catch {
        // Continue searching
      }
    }
  }

  throw new Error(
    `Failed to load native medha_napi binding. Searched:\n${candidates.join('\n')}\nRun 'cargo build -p medha-napi' first.`,
  );
}

const nativeBinding = loadNativeBinding();

export const {
  round6,
  wilsonLowerBound,
  wilsonUpperBound,
  recencyFactor,
  durabilityFactor,
  guardFactor,
  emaStep,
  computeDrift,
  computeTrustAndStatus,
} = nativeBinding;

export default nativeBinding;
