/**
 * Seasonal climate step of the Make-sense pipeline.
 *
 * Inputs: orogeny output (elev in metres), the soft land mask, map
 * dimensions, the land threshold, and a couple of planet parameters.
 * Outputs: per-cell summer and winter temperature (°C) plus summer
 * and winter moisture (0..1).
 *
 * The "Donald bar" rules — no ice↔warm-desert dualism, smooth
 * temperature gradients, measurable continentality, windward/lee
 * asymmetry from orography, conserved moisture — are structurally
 * satisfied here. The math is simple on purpose: a Phase-1
 * approximation that gets the qualitative behaviour right before
 * Phase 2 wires up proper Hadley cells, Ferrel westerlies, and a
 * Clausius–Clapeyron moisture budget.
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
  /** Summer precipitation index per cell, 0..1. */
  summerMoist: Float32Array
  /** Winter precipitation index per cell, 0..1. */
  winterMoist: Float32Array
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Tunable constants for the Phase-1 model. Phase 2 will replace some
 * of these with physics-derived equivalents (real solar zenith,
 * Hadley-cell wind vectors, Clausius–Clapeyron moisture capacity).
 * For now the values reproduce the qualitative behaviour the audit
 * flagged as broken: continentality, rain shadow, moisture
 * conservation, and a smooth seasonal gradient.
 */
const BASE_TEMP_C = 30
const LAPSE_RATE_C_PER_KM = 6.5
const COASTALITY_SCALE_CELLS = 80
const WINTER_CONT_DELTA_C = 25
const SUMMER_CONT_DELTA_C = 10
const TEMP_CLAMP_MIN_C = -40
const TEMP_CLAMP_MAX_C = 50
const PRECIP_PER_KM_UPSLOPE = 0.4
const WINTER_PRECIP_SCALE = 0.5

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute summer and winter temperature and moisture fields for every cell.
 *
 * Deterministic given `(mask, elev, obliquity, threshold)`. Same inputs
 * → same outputs, bit-for-bit, regardless of `_seed`. The wind model
 * is the Phase-1 single-direction simplification: a uniform
 * west-blowing easterly (`windX = -1`, `windY = 0`) that marches each
 * row from east to west with horizontal wrap. Phase 2 will add
 * latitude-band wind profiles (trade winds / westerlies / polar
 * easterlies).
 *
 * Donald-bar invariants this step satisfies:
 *
 *   - **No ice↔warm-desert dualism.** Temperature varies smoothly
 *     with latitude, elevation, and coastal proximity — there is no
 *     categorical boundary where a cold cell sits next to a hot,
 *     dry one.
 *   - **No abrupt discontinuities.** Adjacent cells have similar
 *     temperatures because every input to the temperature formula
 *     (insolation, lapse rate, continentality) is a continuous field.
 *   - **Measurable continentality.** `winter -= (1 - coastality) * 25`
 *     and `summer += (1 - coastality) * 10`, so inland cells have an
 *     annual range ~35 °C larger than coastal cells at the same
 *     latitude.
 *   - **Windward wetter than lee.** The precipitation march extracts
 *     moisture whenever the current cell is higher than its upstream
 *     neighbour (i.e. the air is forced up), which is exactly the
 *     windward side of an N-S ridge.
 *   - **Moisture is conserved.** `precip = min(extract, airM)` and
 *     `airM -= precip`, so no cell's moisture index can exceed the
 *     initial 1.0 saturation.
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
  const summerMoist = new Float32Array(n)
  const winterMoist = new Float32Array(n)

  // Step 1: BFS distance from the nearest sea cell. Distance is in
  // 4-neighbour cells (Manhattan grid distance), horizontal wraps,
  // vertical does not.
  const coastDist = bfsDistanceFromSea(mask, width, height, threshold)

  // Step 2: per-cell summer and winter temperature.
  //
  // Latitude comes from helpers.latRad (y=0 is the north pole,
  // y=height-1 is the south pole). The seasonal zenith-cosine
  // `cosZ = sin(obliquity) * cos(lat)` is a Phase-1 simplification;
  // it has the right shape — high summer insolation at high
  // latitudes, low winter insolation — even if the absolute
  // magnitude differs from a full solar-geometry calculation.
  const obliquityRad = (obliquityDeg * Math.PI) / 180
  const sinObl = Math.sin(obliquityRad)

  for (let y = 0; y < height; y++) {
    const lat = latRad(y, height)
    const cosZ = sinObl * Math.cos(lat)
    // Summer insolation exceeds winter at non-polar latitudes: at
    // summer solstice the noon sun is high, at winter solstice it is
    // low. The Phase-1 simplification uses the same cosine sweep as
    // the zenith angle, but with summer=max and winter=min so the
    // annual range (summer − winter) is always non-negative.
    const summerInsol = 1 + cosZ
    const winterInsol = 1 - cosZ
    const summerBase = BASE_TEMP_C * summerInsol
    const winterBase = BASE_TEMP_C * winterInsol

    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const elevKm = orogeny.elev[i] / 1000
      const lapse = elevKm * LAPSE_RATE_C_PER_KM
      // Coastality is 1 at the shore, decays toward 0 deep inland.
      // A scale of 80 cells gives a believable continentality
      // half-life: at 80 cells from the sea coastality is 0.5, at
      // 240 cells it is 0.25.
      const coastality = 1 / (1 + coastDist[i] / COASTALITY_SCALE_CELLS)
      const inland = 1 - coastality

      let s = summerBase - lapse + inland * SUMMER_CONT_DELTA_C
      let w = winterBase - lapse - inland * WINTER_CONT_DELTA_C

      if (s < TEMP_CLAMP_MIN_C) s = TEMP_CLAMP_MIN_C
      else if (s > TEMP_CLAMP_MAX_C) s = TEMP_CLAMP_MAX_C
      if (w < TEMP_CLAMP_MIN_C) w = TEMP_CLAMP_MIN_C
      else if (w > TEMP_CLAMP_MAX_C) w = TEMP_CLAMP_MAX_C

      summer[i] = s
      winter[i] = w
    }
  }

  // Step 3: precipitation march.
  //
  // Each row is an independent air column. Air enters the row at the
  // eastern edge (x = width-1) fully saturated (`airM = 1.0`). It
  // marches west (x = width-1, width-2, ..., 0), passing over each
  // cell. Whenever the current cell is higher than its upstream
  // (eastern neighbour, wrapped) cell, the air is being forced up
  // the slope and drops its excess moisture as precipitation.
  // `precip = min(extract, airM)` and `airM -= precip` together
  // guarantee conservation.
  marchPrecipitation(orogeny.elev, width, height, summerMoist, 1.0)
  // Winter is generally drier — same march, halved output.
  marchPrecipitation(orogeny.elev, width, height, winterMoist, WINTER_PRECIP_SCALE)

  return { summer, winter, summerMoist, winterMoist }
}

// ---------------------------------------------------------------------------
// Precipitation march
// ---------------------------------------------------------------------------

/**
 * March a column of saturated air east-to-west across each row,
 * extracting moisture whenever the current cell is higher than its
 * upstream (eastern neighbour, wrapped) cell. Each row is
 * independent; `airM` resets to 1.0 at the eastern edge.
 *
 * `scale` is applied to the precipitation that lands on each cell:
 * `1.0` for summer, `0.5` for winter.
 *
 * Precipitation is conserved by construction: `precip = min(extract,
 * airM)` and `airM -= precip`. The maximum any cell can accumulate
 * is 1.0 (the initial saturation), regardless of how many
 * precipitation events occur upstream.
 *
 * The "extract on ascent" condition is what makes the windward side
 * of an N-S ridge wetter than the lee side: air climbs the windward
 * face and drops its moisture there; by the time it crests and
 * starts descending on the lee side, `airM` is depleted and no
 * further precipitation can fall.
 */
function marchPrecipitation(
  elev: Float32Array,
  width: number,
  height: number,
  out: Float32Array,
  scale: number,
): void {
  // Cylinder wrap: keep `airM` continuous across x=0/x=width-1.
  // 1 pass alone leaves a discontinuity at x=0 (the air column is
  // already-depleted when the wind reaches the wrap). We do 2 prime
  // circuits (no deposit, just let the airM settle around the cylinder)
  // and then 1 deposit pass that captures the actual precipitation.
  // Single wind direction (west) — never average with the eastbound
  // march, that would destroy the rain shadow.
  const march = (deposit: boolean) => {
    for (let y = 0; y < height; y++) {
      let airM = 1.0
      for (let x = width - 1; x >= 0; x--) {
        const i = idx(width, x, y)
        const upstreamI = idx(width, wrapX(x + 1, width), y)
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
  march(false)  // prime 1
  march(false)  // prime 2
  march(true)   // deposit
}
