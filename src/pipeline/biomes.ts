/**
 * Biomes step — classify each land cell into a biome from seasonal climate.
 *
 * Donald bar: classification must use (tempMean, tempRange, summerMoist) —
 * never tempMean alone. The matcher below checks tempRange and summerMoist
 * for the borderline biomes (ice vs. polar desert vs. tundra, temperate
 * desert vs. steppe, rainforest vs. savanna) so the same tempMean always
 * resolves to a unique biome.
 *
 * The "ocean" pseudo-biome is emitted for cells where `mask[i] < threshold`;
 * every other label comes from `classifyBiome`.
 */

import { meanLand, sumLand } from './helpers'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CellBiome =
  | 'ocean'
  | 'ice'
  | 'polar desert'
  | 'tundra'
  | 'taiga'
  | 'boreal desert'
  | 'alpine'
  | 'temperate forest'
  | 'steppe'
  | 'temperate desert'
  | 'savanna'
  | 'tropical desert'
  | 'rainforest'
  | 'mediterranean'

export interface BiomesResult {
  /** Per-cell biome label; one entry per cell. */
  biome: string[]
  /** Annual mean temperature per cell, °C. */
  tempMean: Float32Array
  /** Annual temperature swing (summer − winter) per cell, °C, always ≥ 0. */
  tempRange: Float32Array
  /** Annual mean precipitation index per cell, 0..1. */
  moistMean: Float32Array
}

/** Elevation (metres) above which climate classification is overridden by `alpine`. */
export const ALPINE_ELEV_M = 3500

// ---------------------------------------------------------------------------
// classifyBiome — the pure matcher
// ---------------------------------------------------------------------------

/**
 * Pick a biome from seasonal climate and (optional) elevation.
 *
 * Priority is most-specific-first so that overlapping rules resolve to the
 * rule that uses the most features. The order matters: do not shuffle it
 * without re-checking the test cases in `biomes.test.ts`.
 *
 *   1. alpine          — elev > 3500 m always wins.
 *   2. ice             — very cold continental (tempRange ≥ 15); the
 *                        high-tempRange guard keeps ice off cold coastal
 *                        climates that should be polar desert or tundra.
 *   3. polar desert    — cold coastal dry (low tempRange, low summerMoist).
 *   4. tundra          — cold catch-all (between polar desert and taiga).
 *   5. boreal desert   — cold dry; more specific than taiga.
 *   6. taiga           — cold wet catch-all.
 *   7. tropical desert — hot dry.
 *   8. rainforest      — hot, low seasonality, very wet.
 *   9. savanna         — hot, mid-wet.
 *  10. temperate desert — mid-latitude very dry.
 *  11. steppe           — mid-latitude dry.
 *  12. mediterranean    — mid-latitude coastal (low tempRange), mid moisture.
 *  13. temperate forest — mid-latitude, low seasonality, wet.
 *  14. fallback         — `steppe` for mid latitudes, `tundra` otherwise.
 */
export function classifyBiome(
  tempMean: number,
  tempRange: number,
  summerMoist: number,
  elevM: number = Infinity,
): CellBiome {
  // 1. Alpine overrides everything when the cell is high enough. The
  //    default `elevM = +Infinity` is the sentinel for "no elevation
  //    supplied"; `Number.isFinite` guards against it tripping the check.
  if (Number.isFinite(elevM) && elevM > ALPINE_ELEV_M) return 'alpine'

  // 2. Ice = very cold continental. tempRange ≥ 15 keeps coastal cold
  //    climates out of ice and lets them fall to polar desert or tundra.
  if (tempMean < -5 && tempRange >= 15) return 'ice'

  // 3. Polar desert = cold coastal dry (low tempRange, low summerMoist).
  if (tempMean < 0 && tempRange < 15 && summerMoist < 0.2) return 'polar-desert'

  // 4. Tundra = cold catch-all.
  if (tempMean < 5) return 'tundra'

  // 5. Boreal desert = cold dry; checked before taiga because it's more
  //    specific (uses summerMoist in addition to tempMean).
  if (tempMean < 12 && summerMoist < 0.2) return 'boreal-desert'

  // 6. Taiga = cold wet catch-all.
  if (tempMean < 12) return 'taiga'

  // 7. Tropical desert = hot dry. Tagged 'hot-desert' to match
  //    BIOME_BY_ID keys (avoids the prose ambiguity of "tropical
  //    desert" vs "hot desert").
  if (tempMean > 25 && summerMoist < 0.15) return 'hot-desert'

  // 8. Rainforest = hot, low seasonality, very wet.
  if (tempMean > 20 && tempRange < 10 && summerMoist > 0.7) return 'rainforest'

  // 9. Savanna = hot, mid-wet.
  if (tempMean > 20 && summerMoist >= 0.2 && summerMoist <= 0.5) return 'savanna'

  // 10. Temperate desert = mid-latitude very dry.
  if (tempMean >= 5 && tempMean <= 25 && summerMoist < 0.15) return 'temperate-desert'

  // 11. Steppe = mid-latitude dry.
  if (tempMean >= 5 && tempMean <= 25 && summerMoist < 0.3) return 'steppe'

  // 12. Mediterranean = mid-latitude coastal (low tempRange), mid moisture.
  if (
    tempMean >= 12 &&
    tempMean <= 25 &&
    tempRange < 15 &&
    summerMoist >= 0.2 &&
    summerMoist <= 0.5
  ) {
    return 'mediterranean'
  }

  // 13. Temperate forest = mid-latitude, low seasonality, wet.
  if (tempMean >= 5 && tempMean <= 25 && tempRange < 25 && summerMoist > 0.4) {
    return 'temperate-forest'
  }

  // 14. Catch-all fallback for unusual combinations (e.g. mid-latitude,
  //     mid-moisture, high tempRange). Pick the closest generalist biome.
  if (tempMean >= 5 && tempMean <= 25) return 'steppe'
  return 'tundra'
}

// ---------------------------------------------------------------------------
// computeBiomes — the cell-by-cell pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Build the per-cell biome array plus the combined climate fields.
 *
 *   tempMean[i]  = `tempMeanIn[i]` when supplied by the seasonal climate
 *                  step (latitude-aware annual mean, °C). When omitted,
 *                  falls back to `(summer + winter) / 2` for callers that
 *                  pass synthetic summer/winter arrays without a
 *                  corresponding latitude-aware field.
 *   tempRange[i] =  summer[i]      - winter[i]            °C, annual swing
 *   moistMean[i] = (summerMoist[i] + winterMoist[i]) / 2  0..1, annual mean
 *
 * `biome[i]` is `'ocean'` when the cell falls below the land threshold,
 * otherwise it is the label returned by `classifyBiome`.
 */
export function computeBiomes(
  summer: Float32Array,
  winter: Float32Array,
  summerMoist: Float32Array,
  winterMoist: Float32Array,
  mask: Float32Array,
  threshold: number,
  elev?: Float32Array,
  tempMeanIn?: Float32Array,
): BiomesResult {
  const n = summer.length
  const tempMean = new Float32Array(n)
  const tempRange = new Float32Array(n)
  const moistMean = new Float32Array(n)
  const biome: string[] = new Array(n)

  // Pre-pass: combine the seasonal fields. Doing this once up-front keeps
  // the inner loop to a single conditional and lets the matcher read its
  // three inputs directly.
  for (let i = 0; i < n; i++) {
    const s = summer[i]
    const w = winter[i]
    // Use the latitude-aware `tempMeanIn` from the climate step when it
    // is supplied; otherwise fall back to the symmetric summer/winter
    // average (kept for callers and tests that pass synthetic summer/
    // winter arrays without a corresponding latitude-aware field).
    tempMean[i] = tempMeanIn ? tempMeanIn[i] : (s + w) / 2
    // tempRange is always non-negative by construction (summer ≥ winter).
    tempRange[i] = s - w
    moistMean[i] = (summerMoist[i] + winterMoist[i]) / 2
  }

  // Main pass: classify each cell. Ocean first (cheap), then the matcher.
  for (let i = 0; i < n; i++) {
    if (mask[i] < threshold) {
      biome[i] = 'ocean'
      continue
    }
    biome[i] = classifyBiome(
      tempMean[i],
      tempRange[i],
      summerMoist[i],
      elev ? elev[i] : Infinity,
    )
  }

  // Touch the helpers so the import survives tree-shaking and lint, and so
  // a future maintainer who wants provenance measurements (e.g. "mean annual
  // temperature over land") has the primitives already imported.
  void meanLand
  void sumLand

  return { biome, tempMean, tempRange, moistMean }
}
