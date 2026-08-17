/**
 * Suitability — per-cell 0..1 score combining biome potential, climate comfort,
 * river access, flux-driven hazards, and coastal access. Used by the Worldbuild
 * stage to seed city placement: high-suitability cells are likelier hosts for
 * an urban centre.
 *
 * Pure: same inputs → same outputs, no hidden state, no Date.now / Math.random.
 */

import { clamp, D8_OFFSETS, idx, wrapX } from './helpers'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SuitabilityResult {
  /** Per-cell suitability score, length W*H, in [0, 1]. */
  suitability: Float32Array
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Base suitability per biome. Hostile biomes (desert, ice) start low. */
const BIOME_BASE: Readonly<Record<string, number>> = {
  rainforest: 0.6,
  'temperate-forest': 0.85,
  'temperate forest': 0.85,
  taiga: 0.5,
  tundra: 0.3,
  steppe: 0.5,
  savanna: 0.7,
  mediterranean: 0.85,
  'boreal-desert': 0.2,
  'boreal desert': 0.2,
  'polar-desert': 0.1,
  'polar desert': 0.1,
  'hot-desert': 0.1,
  'temperate desert': 0.2,
  'tropical desert': 0.1,
  ice: 0.0,
  alpine: 0.4,
  ocean: 0.0,
}

/** Fallback base for biome names that aren't in the lookup table. */
const UNKNOWN_BIOME_BASE = 0.5

/** Penalty per unit of winter cold; 0 above −10°C, saturates at −20°C. */
const WINTER_PENALTY_RATE = 0.3

/** Penalty applied when 50 < flux ≤ 100 (mud / marshy cells). */
const FLUX_PENALTY_MID = 0.2

/** Additional penalty applied when flux > 100 (very wet cells). */
const FLUX_PENALTY_HIGH = 0.3

/** Per-river-neighbour bonus before the cap. */
const RIVER_BONUS_PER_NEIGHBOUR = 0.1

/** Maximum total bonus from nearby rivers. */
const RIVER_BONUS_CAP = 0.2

/** Bonus for cells within 2 cells of ocean (port access). */
const COASTAL_BONUS = 0.15

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute per-cell suitability used by Worldbuild to seed city placement.
 *
 * @param biome Per-cell biome name (length W*H).
 * @param flux Accumulated downhill water flux per cell (length W*H).
 * @param rivers 1 = river cell, 0 = not (length W*H).
 * @param mask Soft land mask 0..1 (length W*H); mask[i] ≤ threshold is sea.
 * @param summer Summer mean temperature °C (length W*H; reserved, unused).
 * @param winter Winter mean temperature °C (length W*H).
 * @param width Map width in cells.
 * @param height Map height in cells.
 * @param threshold Land-mask threshold; cells with mask[i] ≤ threshold are sea.
 */
export function computeSuitability(
  biome: string[],
  flux: Float32Array,
  rivers: Uint8Array,
  mask: Float32Array,
  _summer: Float32Array,
  winter: Float32Array,
  width: number,
  height: number,
  threshold: number,
): SuitabilityResult {
  const n = width * height
  const out = new Float32Array(n)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)

      // 1. Base by biome.
      let suit = BIOME_BASE[biome[i]] ?? UNKNOWN_BIOME_BASE

      // 2. Winter cold penalty — 0 above −10°C, linearly up to 1 at −20°C.
      const winterPenalty = Math.max(0, (-10 - winter[i]) / 10)
      suit -= WINTER_PENALTY_RATE * winterPenalty

      // 3. River-neighbour bonus (D8), capped.
      let riverCount = 0
      for (let k = 0; k < D8_OFFSETS.length; k++) {
        const off = D8_OFFSETS[k]
        const nx = x + off[0]
        const ny = y + off[1]
        if (ny < 0 || ny >= height) continue
        const nwx = wrapX(nx, width)
        if (rivers[idx(width, nwx, ny)] === 1) riverCount++
      }
      if (riverCount > 0) {
        suit += Math.min(RIVER_BONUS_CAP, RIVER_BONUS_PER_NEIGHBOUR * riverCount)
      }

      // 4. Flux penalty — cumulative thresholds (mild above 50, severe above 100).
      if (flux[i] > 100) {
        suit -= FLUX_PENALTY_MID + FLUX_PENALTY_HIGH
      } else if (flux[i] > 50) {
        suit -= FLUX_PENALTY_MID
      }

      // 5. Coastal bonus — ocean within Chebyshev distance 2.
      let nearOcean = false
      outer: for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue
          const nwx = wrapX(x + dx, width)
          if (mask[idx(width, nwx, ny)] <= threshold) {
            nearOcean = true
            break outer
          }
        }
      }
      if (nearOcean) suit += COASTAL_BONUS

      // 7. Clamp to [0, 1].
      out[i] = clamp(suit, 0, 1)
    }
  }

  return { suitability: out }
}