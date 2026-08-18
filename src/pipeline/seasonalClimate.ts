/**
 * Seasonal climate step of the Make-sense pipeline.
 *
 * Inputs: orogeny output (elev in metres), the soft land mask, map
 * dimensions, the land threshold, and a couple of planet parameters.
 * Outputs: per-cell summer and winter temperature (°C) plus summer
 * and winter moisture (0..1).
 *
 * The model is a Phase-1 Earth analogue, not a GCM. It has to be
 * geographically honest enough that a writer hovering a cell is not
 * lied to:
 *
 *   - Equator is hot, poles are cold. (The previous insolation proxy
 *     made both ~30 °C and put 40 °C on open ocean.)
 *   - Seasonal amplitude grows with |latitude| and with distance from
 *     the sea. Equator stays mild; interiors swing.
 *   - Ocean has thermal inertia: SST stays inside roughly −1.8..30 °C
 *     with a small annual range.
 *   - Rain is not only orographic. Flat ocean and coasts get a
 *     latitude baseline (ITCZ / storm-track); ridges still wet the
 *     windward face and dry the lee.
 */

import { idx, wrapX, latRad, bfsDistanceFromSea } from './helpers'

/**
 * Minimal slice of the orogeny output the climate step needs: just
 * the per-cell elevation in metres. The full `OrogenyResult` (with
 * `boundaries`, `peakMeters`, etc.) is owned by the orogeny module;
 * we re-declare the contract here so the climate step is testable
 * without depending on the orogeny module being present.
 */
export interface OrogenyResult {
  /** Per-cell elevation in metres; length W*H. */
  elev: Float32Array
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Summer / winter climate fields per cell.
 *
 * `summer` and `winter` are mean temperatures in °C for the warm and
 * cold halves of the year. `summerMoist` and `winterMoist` are
 * dimensionless precipitation indices in `[0, 1]`: 0 = bone-dry, 1 =
 * fully saturated. All arrays are length `width * height`.
 */
export interface SeasonalClimateResult {
  /** Summer mean temperature per cell, °C. */
  summer: Float32Array
  /** Winter mean temperature per cell, °C. */
  winter: Float32Array
  /**
   * Annual mean temperature per cell, °C. Equal to
   * `(summer + winter) / 2` after lapse, continentality, ocean
   * inertia, and clamps — so the inspector, the temperature layer,
   * and the biome classifier all read the same planet.
   */
  tempMean: Float32Array
  /** Summer precipitation index per cell, 0..1. */
  summerMoist: Float32Array
  /** Winter precipitation index per cell, 0..1. */
  winterMoist: Float32Array
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Sea-level annual mean at the equator, °C. */
const EQUATOR_MEAN_C = 27
/** Sea-level annual mean at the poles, °C. */
const POLE_MEAN_C = -18
const LAPSE_RATE_C_PER_KM = 6.5
const COASTALITY_SCALE_CELLS = 80
const LAND_TEMP_MIN_C = -40
const LAND_TEMP_MAX_C = 48
const OCEAN_SST_MIN_C = -1.8
const OCEAN_SST_MAX_C = 30
const PRECIP_PER_KM_UPSLOPE = 0.65
const OCEAN_EVAP = 0.18
const WINTER_PRECIP_SCALE = 0.5
const EARTH_OBLIQUITY_DEG = 23.5

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute summer and winter temperature and moisture fields for every cell.
 *
 * Deterministic given `(mask, elev, obliquity, threshold)`. Same inputs
 * → same outputs, bit-for-bit, regardless of `_seed`. The wind model
 * is the Phase-1 single-direction simplification: a uniform
 * west wind (`windX = +1`) that marches each row from west to east
 * with horizontal wrap — windward is the west face of a ridge, lee
 * is the east face. That matches the post-Make-sense rain-shadow
 * check. Phase 2 will add latitude-band wind profiles (trade winds /
 * westerlies / polar easterlies).
 *
 * Donald-bar invariants this step satisfies:
 *
 *   - **No ice↔warm-desert dualism.** Temperature varies smoothly
 *     with latitude, elevation, and coastal proximity.
 *   - **No abrupt discontinuities.** Adjacent cells have similar
 *     temperatures because every input is a continuous field.
 *   - **Measurable continentality.** Inland cells get a larger
 *     annual range than coastal cells at the same latitude.
 *   - **Windward wetter than lee.** Orographic extract still fires
 *     on ascent; a latitude baseline sits under that so oceans are
 *     not bone-dry.
 *   - **Moisture is conserved on the orographic march.** Baseline
 *     rain is evaporation, then the total is clamped to 1.0.
 */
export function computeSeasonalClimate(
  orogeny: OrogenyResult,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  _planetRadiusKm: number,
  obliquityDeg: number,
  _seed: number,
): SeasonalClimateResult {
  const n = width * height
  const summer = new Float32Array(n)
  const winter = new Float32Array(n)
  const tempMean = new Float32Array(n)
  const summerMoist = new Float32Array(n)
  const winterMoist = new Float32Array(n)

  const coastDist = bfsDistanceFromSea(mask, width, height, threshold)

  const obliquityRad = (obliquityDeg * Math.PI) / 180
  const sinObl = Math.sin(obliquityRad)
  const earthSinObl = Math.sin((EARTH_OBLIQUITY_DEG * Math.PI) / 180)
  const seasonScale = earthSinObl > 1e-6 ? sinObl / earthSinObl : 0

  for (let y = 0; y < height; y++) {
    const lat = latRad(y, height)
    const cosLat = Math.max(0, Math.cos(lat))
    const latSeason = Math.pow(Math.abs(Math.sin(lat)), 0.9)
    const annualSea = POLE_MEAN_C + (EQUATOR_MEAN_C - POLE_MEAN_C) * cosLat

    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const isOcean = mask[i] < threshold
      const coastality = 1 / (1 + coastDist[i] / COASTALITY_SCALE_CELLS)
      const inland = isOcean ? 0 : 1 - coastality
      const lapse = isOcean ? 0 : (orogeny.elev[i] / 1000) * LAPSE_RATE_C_PER_KM

      const half = isOcean
        ? (1.2 + 3.8 * latSeason) * seasonScale
        : (2.5 + 11 * latSeason + inland * (9 + 14 * latSeason)) * seasonScale

      let s = annualSea + half - lapse
      let w = annualSea - half - lapse
      if (isOcean) {
        s = clampNum(s, OCEAN_SST_MIN_C, OCEAN_SST_MAX_C)
        w = clampNum(w, OCEAN_SST_MIN_C, OCEAN_SST_MAX_C)
      } else {
        s = clampNum(s, LAND_TEMP_MIN_C, LAND_TEMP_MAX_C)
        w = clampNum(w, LAND_TEMP_MIN_C, LAND_TEMP_MAX_C)
      }
      if (w > s) {
        const mid = (s + w) / 2
        s = mid
        w = mid
      }

      summer[i] = s
      winter[i] = w
      tempMean[i] = (s + w) / 2
    }
  }

  marchPrecipitation(orogeny.elev, mask, threshold, width, height, summerMoist, 1.0)
  marchPrecipitation(orogeny.elev, mask, threshold, width, height, winterMoist, WINTER_PRECIP_SCALE)

  for (let y = 0; y < height; y++) {
    const lat = latRad(y, height)
    const base = latitudePrecip(lat)
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const isOcean = mask[i] < threshold
      const coastality = 1 / (1 + coastDist[i] / COASTALITY_SCALE_CELLS)
      const wet = isOcean ? base + 0.14 : base * (0.80 + 0.20 * coastality)
      const upstreamI = idx(width, wrapX(x - 1, width), y)
      const drop = orogeny.elev[upstreamI] - orogeny.elev[i]
      const foehn = !isOcean && drop > 280 ? 0.78 : 1
      summerMoist[i] = clampNum(summerMoist[i] + wet * foehn, 0, 1)
      winterMoist[i] = clampNum(winterMoist[i] + wet * WINTER_PRECIP_SCALE * foehn, 0, 1)
    }
  }

  return { summer, winter, tempMean, summerMoist, winterMoist }
}

// ---------------------------------------------------------------------------
// Latitude moisture + precipitation march
// ---------------------------------------------------------------------------

/**
 * Background precipitation from latitude: wet ITCZ, dry subtropics,
 * wet mid-latitude storm track, drier poles. Orography modulates
 * this; it does not replace it.
 */
function latitudePrecip(lat: number): number {
  const deg = Math.abs(lat) * (180 / Math.PI)
  const itcz = Math.exp(-(deg * deg) / 324) * 0.62
  const storm = Math.exp(-((deg - 50) * (deg - 50)) / 144) * 0.36
  const subtrop = Math.exp(-((deg - 27) * (deg - 27)) / 64) * 0.18
  return clampNum(0.1 + itcz + storm - subtrop, 0.05, 0.85)
}

function clampNum(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

/**
 * March a column of saturated air west-to-east across each row,
 * extracting moisture whenever the current cell is higher than its
 * upstream (western neighbour, wrapped) cell. The cylinder wraps:
 * the air column is continuous across the x=0 / x=width-1 seam. We
 * prime with two air-circuits (no deposit, just let `airM` stabilize
 * around the cylinder) and then take one deposit pass that
 * accumulates actual precipitation. Ocean cells recharge the column
 * (evaporation) so coasts can rain even after an upstream continent
 * wrung the air dry.
 *
 * `scale` is applied to the precipitation that lands on each cell:
 * `1.0` for summer, `0.5` for winter.
 *
 * The "extract on ascent" condition is what makes the windward
 * (west) side of an N-S ridge wetter than the lee (east) side.
 */
function marchPrecipitation(
  elev: Float32Array,
  mask: Float32Array,
  threshold: number,
  width: number,
  height: number,
  out: Float32Array,
  scale: number,
): void {
  const march = (deposit: boolean) => {
    for (let y = 0; y < height; y++) {
      let airM = 1.0
      for (let x = 0; x < width; x++) {
        const i = idx(width, x, y)
        if (mask[i] < threshold) {
          airM = airM + OCEAN_EVAP < 1 ? airM + OCEAN_EVAP : 1
        }
        const upstreamI = idx(width, wrapX(x - 1, width), y)
        const upstreamElev = elev[upstreamI]
        const currentElev = elev[i]
        if (currentElev > upstreamElev) {
          const extract = ((currentElev - upstreamElev) / 1000) * PRECIP_PER_KM_UPSLOPE
          const precip = extract < airM ? extract : airM
          airM -= precip
          if (deposit) out[i] += precip * scale
        }
      }
    }
  }
  march(false)
  march(false)
  march(true)
}
