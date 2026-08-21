/**
 * Tinbergen / Wilson gravity flow.
 *
 *   T_ij = G · (M_i^α · M_j^α) / d_ij^β
 *
 * Default α = 1, G = 1. Distance is the path cost already computed
 * on the map (cells), not great-circle km — Geoform's metric is the
 * atlas graph. β is higher on land than at sea (sea is cheaper).
 *
 * This is economic geography, not GTAP. Mass is surplus × hinterland,
 * not GDP.
 */

export const GRAVITY_G = 1
export const GRAVITY_ALPHA = 1
/** Distance elasticity on land. Typical gravity β is 1.5–2. */
export const GRAVITY_BETA_LAND = 1.8
/** Distance elasticity at sea — cabotage is cheaper than a mountain. */
export const GRAVITY_BETA_SEA = 1.25

export function gravityFlow(
  massI: number,
  massJ: number,
  distance: number,
  kind: 'land' | 'sea' = 'land',
): number {
  const mi = Math.max(1e-6, massI)
  const mj = Math.max(1e-6, massJ)
  const d = Math.max(1, distance)
  const beta = kind === 'sea' ? GRAVITY_BETA_SEA : GRAVITY_BETA_LAND
  return (GRAVITY_G * mi ** GRAVITY_ALPHA * mj ** GRAVITY_ALPHA) / d ** beta
}
