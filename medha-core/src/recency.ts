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
export function recencyDecay(lastUsedAt: number | null, now: number): number {
  if (lastUsedAt === null) return RECENCY_FLOOR;
  const ageDays = Math.max(0, (now - lastUsedAt) / DAY_MS);
  const decayed = Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
  const result = decayed < RECENCY_FLOOR ? RECENCY_FLOOR : decayed;
  return round6(result > 1 ? 1 : result);
}
