import type { KindRecency } from './kinds.ts';
import { round6 } from './rounding.ts';
import { DAY_MS, RECENCY_FLOOR, RECENCY_HALF_LIFE_DAYS } from './thresholds.ts';

/**
 * Recency decay R_i(Δt), model §4.2.
 *
 *     R(Δt) = max( R_floor, exp( -[ln2 · Δt] / t_half ) )
 *
 * A never-used entity sits at the floor — `null` last used is treated as infinitely old so it can
 * neither dominate nor be evicted merely for being niche.
 */
export function recencyDecay(
  lastUsedAt: number | null,
  now: number,
  recencyConfig?: KindRecency,
): number {
  const floor = recencyConfig?.floor ?? RECENCY_FLOOR;
  const halfLife = recencyConfig?.halfLifeDays ?? RECENCY_HALF_LIFE_DAYS;
  if (lastUsedAt === null) return floor;
  const ageDays = Math.max(0, (now - lastUsedAt) / DAY_MS);
  const decayed = Math.exp((-Math.LN2 * ageDays) / halfLife);
  const result = decayed < floor ? floor : decayed;
  return round6(result > 1 ? 1 : result);
}
