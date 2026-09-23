/**
 * Seasonal climate step of the Make-sense pipeline.
 *
 * Inputs: orogeny output (elev in metres), the soft land mask, map
 * dimensions, the land threshold, and a couple of planet parameters.
 * Outputs: per-cell summer and winter temperature (°C) plus summer
 * and winter moisture (0..1).
 *
 * The model is an Earth analogue, not a GCM. It has to be
 * geographically honest enough that a writer hovering a cell is not
 * lied to:
 *
 *   - Equator is hot, poles are cold. (The previous insolation proxy
 *     made both ~30 °C and put 40 °C on open ocean.)
 *   - Seasonal amplitude grows with |latitude| and with distance from
 *     the sea. Equator stays mild; interiors swing. Distance from the
 *     sea is measured in kilometres (scaled by the planet radius), so
 *     a bigger planet has more continental interiors.
 *   - Ocean has thermal inertia: SST stays inside roughly −1.8..30 °C
 *     with a small annual range.
 *   - Rain is not only orographic. Flat ocean and coasts get a
 *     latitude baseline (ITCZ / storm-track); ridges still wet the
 *     windward face and dry the lee.
 *   - Winds are latitude-banded: trade easterlies below 30°,
 *     westerlies from 30° to 60°, polar easterlies above 60°. In the
 *     trades the windward face of a ridge is its EAST face; in the
 *     westerlies it is the WEST face.
 *   - The ITCZ migrates with the seasons: its gaussian centre shifts
 *     toward the summer hemisphere by up to ~8° (scaled by obliquity),
 *     so cells near 0–15° |latitude| get a wet-summer / drier-winter
 *     (savanna / monsoon-like) asymmetry.
 */

import { idx, wrapX, latRad, bfsDistanceFromSea } from './helpers'
import { computeOceanCurrents } from './oceanCurrents'

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
  /** 'cold current' or 'warm current' when a coast carries one. */
  currentNote: '' | 'cold current' | 'warm current'
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Sea-level annual mean at the equator, °C. */
const EQUATOR_MEAN_C = 27
/** Sea-level annual mean at the poles, °C. */
const POLE_MEAN_C = -18
const LAPSE_RATE_C_PER_KM = 6.5
/** E-folding-ish distance for Earth-like continentality, km. */
const COASTALITY_SCALE_KM = 1500
/** Fallback when the caller passes a non-positive planet radius. */
const EARTH_RADIUS_KM = 6371
const LAND_TEMP_MIN_C = -40
const LAND_TEMP_MAX_C = 48
const OCEAN_SST_MIN_C = -1.8
const OCEAN_SST_MAX_C = 30
const PRECIP_PER_KM_UPSLOPE = 0.65
const OCEAN_EVAP = 0.18
/** Winter damping for the OROGRAPHIC march only; the latitude baseline
 * gets its seasonality from the ITCZ shift instead. */
const WINTER_PRECIP_SCALE = 0.5
const EARTH_OBLIQUITY_DEG = 23.5
/** ITCZ migration toward the summer hemisphere at Earth obliquity, degrees. */
const ITCZ_SHIFT_DEG = 8

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute summer and winter temperature and moisture fields for every cell.
 *
 * Deterministic given `(mask, elev, planetRadiusKm, obliquity,
 * threshold)`. Same inputs → same outputs, bit-for-bit, regardless of
 * `_seed`. The wind model is latitude-banded: trade easterlies for
 * |lat| < 30° (air marches east→west, windward is the EAST face of a
 * ridge), westerlies for 30°–60° (west→east, windward is the WEST
 * face), and polar easterlies above 60° (east→west again). Each row
 * gets a single direction from `rowWindDir`; the temperature model is
 * latitude-continuous, so band edges only switch the precipitation
 * march direction and do not create a temperature discontinuity.
 *
 * Donald-bar invariants this step satisfies:
 *
 *   - **No ice↔warm-desert dualism.** Temperature varies smoothly
 *     with latitude, elevation, and coastal proximity.
 *   - **No abrupt discontinuities.** Adjacent cells have similar
 *     temperatures because every input is a continuous field.
 *   - **Measurable continentality.** Inland cells get a larger
 *     annual range than coastal cells at the same latitude, and the
 *     effect scales with real distance: coast distance in cells is
 *     converted to km via the planet radius, so a larger planet has
 *     harsher interiors at the same grid size.
 *   - **Windward wetter than lee, per wind band.** Orographic extract
 *     fires on ascent along the row's own wind direction; a latitude
 *     baseline sits under that so oceans are not bone-dry.
 *   - **Seasonal ITCZ shift.** The tropical rain belt follows the
 *     summer hemisphere, giving 0–15° |latitude| a wet-summer /
 *     drier-winter monsoon-like asymmetry.
 *   - **Moisture is conserved on the orographic march.** Baseline
 *     rain is evaporation, then the total is clamped to 1.0.
 */
export function computeSeasonalClimate(
  orogeny: OrogenyResult,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  planetRadiusKm: number,
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
  const radiusKm = planetRadiusKm > 0 ? planetRadiusKm : EARTH_RADIUS_KM
  const kmPerCell = (2 * Math.PI * radiusKm) / width

  const obliquityRad = (obliquityDeg * Math.PI) / 180
  const sinObl = Math.sin(obliquityRad)
  const earthSinObl = Math.sin((EARTH_OBLIQUITY_DEG * Math.PI) / 180)
  const seasonScale = earthSinObl > 1e-6 ? sinObl / earthSinObl : 0
  const seasonShiftDeg = ITCZ_SHIFT_DEG * seasonScale

  for (let y = 0; y < height; y++) {
    const lat = latRad(y, height)
    const cosLat = Math.max(0, Math.cos(lat))
    const latSeason = Math.pow(Math.abs(Math.sin(lat)), 0.9)
    const annualSea = POLE_MEAN_C + (EQUATOR_MEAN_C - POLE_MEAN_C) * cosLat

    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const isOcean = mask[i] < threshold
      const coastality = 1 / (1 + (coastDist[i] * kmPerCell) / COASTALITY_SCALE_KM)
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
    }
  }

  // Coastal currents: warm western boundaries, cold eastern ones.
  // Applied before the mix so the anomaly bleeds a cell or two inland.
  const currents = computeOceanCurrents(mask, width, height, threshold)
  for (let i = 0; i < n; i++) {
    const bias = currents.tempBias[i]
    if (bias !== 0) {
      summer[i] += bias
      winter[i] += bias
    }
    if (currents.mild[i] > 0) {
      const mid = (summer[i] + winter[i]) / 2
      const pull = 1 - 0.28 * currents.mild[i]
      summer[i] = mid + (summer[i] - mid) * pull
      winter[i] = mid + (winter[i] - mid) * pull + 1.3 * currents.mild[i]
    }
    const isOcean = mask[i] < threshold
    if (isOcean) {
      summer[i] = clampNum(summer[i], OCEAN_SST_MIN_C, OCEAN_SST_MAX_C)
      winter[i] = clampNum(winter[i], OCEAN_SST_MIN_C, OCEAN_SST_MAX_C)
    } else {
      summer[i] = clampNum(summer[i], LAND_TEMP_MIN_C, LAND_TEMP_MAX_C)
      winter[i] = clampNum(winter[i], LAND_TEMP_MIN_C, LAND_TEMP_MAX_C)
    }
    if (winter[i] > summer[i]) {
      const mid = (summer[i] + winter[i]) / 2
      summer[i] = mid
      winter[i] = mid
    }
  }

  // Air mixes. A one-cell 8000 m spike is not a climate boundary.
  mixTemperature(summer, width, height, 2)
  mixTemperature(winter, width, height, 2)
  for (let i = 0; i < n; i++) tempMean[i] = (summer[i] + winter[i]) / 2

  marchPrecipitation(orogeny.elev, mask, threshold, width, height, summerMoist, 1.0, currents.evapScale)
  marchPrecipitation(
    orogeny.elev,
    mask,
    threshold,
    width,
    height,
    winterMoist,
    WINTER_PRECIP_SCALE,
    currents.evapScale,
  )

  for (let y = 0; y < height; y++) {
    const lat = latRad(y, height)
    const dir = rowWindDir(lat)
    const baseSummer = latitudePrecip(lat, seasonShiftDeg)
    const baseWinter = latitudePrecip(lat, -seasonShiftDeg)
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const isOcean = mask[i] < threshold
      const coastality = 1 / (1 + (coastDist[i] * kmPerCell) / COASTALITY_SCALE_KM)
      const coastFactor = 0.80 + 0.20 * coastality
      const wetSummer = isOcean ? baseSummer + 0.14 : baseSummer * coastFactor
      const wetWinter = isOcean ? baseWinter + 0.14 : baseWinter * coastFactor
      // Upstream = the neighbour the row's wind arrives from; a big
      // drop from upstream means this cell sits in a foehn lee.
      const upstreamI = idx(width, wrapX(x - dir, width), y)
      const drop = orogeny.elev[upstreamI] - orogeny.elev[i]
      const foehn = !isOcean && drop > 280 ? 0.78 : 1
      const scale = currents.moistScale[i]
      summerMoist[i] = clampNum((summerMoist[i] + wetSummer * foehn) * scale, 0, 1)
      winterMoist[i] = clampNum((winterMoist[i] + wetWinter * foehn) * scale, 0, 1)
    }
  }

  return { summer, winter, tempMean, summerMoist, winterMoist, currentNote: currents.note }
}

// ---------------------------------------------------------------------------
// Latitude moisture + precipitation march
// ---------------------------------------------------------------------------

/**
 * Prevailing zonal wind direction for a row, by absolute latitude:
 *
 *   - trade easterlies for |lat| < 30°  → air travels east→west (−1),
 *     so the windward face of a ridge is its EAST face;
 *   - westerlies for 30°–60°           → west→east (+1), windward is
 *     the WEST face;
 *   - polar easterlies above 60°       → east→west (−1) again.
 *
 * `+1` means the precipitation march walks each row in +x order with
 * the upstream neighbour at x−1; `−1` walks in −x order with the
 * upstream neighbour at x+1.
 */
export function rowWindDir(lat: number): 1 | -1 {
  const deg = Math.abs(lat) * (180 / Math.PI)
  if (deg < 30) return -1
  if (deg <= 60) return 1
  return -1
}

/**
 * Background precipitation from latitude: wet ITCZ, dry subtropics,
 * wet mid-latitude storm track, drier poles. Orography modulates
 * this; it does not replace it.
 *
 * `seasonShiftDeg` migrates the ITCZ gaussian centre toward the
 * summer hemisphere: pass `+shift` for the summer field and `−shift`
 * for the winter field (shift = 8° at Earth obliquity, scaled by
 * `seasonScale`). Because the centre sits at +shift° |latitude| in
 * summer and −shift° in winter, cells near 0–15° |latitude| get a
 * wet-summer / drier-winter asymmetry — the savanna/monsoon-like
 * precursor. The subtropical dry belt and the mid-latitude storm
 * track stay fixed across seasons.
 */
function latitudePrecip(lat: number, seasonShiftDeg: number): number {
  const deg = Math.abs(lat) * (180 / Math.PI)
  const dItcz = deg - seasonShiftDeg
  const itcz = Math.exp(-(dItcz * dItcz) / 324) * 0.62
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
 * Diffuse temperature so neighbouring cells cannot jump from ice to
 * hot desert. Broad ice caps stay cold; one-cell orogeny spikes do not
 * invent a climate front.
 */
function mixTemperature(field: Float32Array, w: number, h: number, passes: number): void {
  const next = new Float32Array(field.length)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const west = field[y * w + wrapX(x - 1, w)]
        const east = field[y * w + wrapX(x + 1, w)]
        const north = y > 0 ? field[(y - 1) * w + x] : field[i]
        const south = y < h - 1 ? field[(y + 1) * w + x] : field[i]
        next[i] = field[i] * 0.45 + (west + east + north + south) * 0.1375
      }
    }
    field.set(next)
  }
}

/**
 * March a column of saturated air along each row in that row's
 * prevailing wind direction (`rowWindDir`): +x in the westerlies,
 * −x in the trade and polar easterlies. Moisture is extracted
 * whenever the current cell is higher than its upstream (upwind
 * neighbour, wrapped) cell. The cylinder wraps: the air column is
 * continuous across the x=0 / x=width-1 seam. We prime with two
 * air-circuits (no deposit, just let `airM` stabilize around the
 * cylinder) and then take one deposit pass that accumulates actual
 * precipitation. Ocean cells recharge the column (evaporation) so
 * coasts can rain even after an upstream continent wrung the air dry.
 *
 * `scale` is applied to the precipitation that lands on each cell:
 * `1.0` for summer, `0.5` for winter.
 *
 * The "extract on ascent" condition is what makes the windward side
 * of an N-S ridge wetter than the lee — the WEST face in the
 * westerlies, the EAST face in the trades and polar easterlies.
 */
function marchPrecipitation(
  elev: Float32Array,
  mask: Float32Array,
  threshold: number,
  width: number,
  height: number,
  out: Float32Array,
  scale: number,
  evapScale?: Float32Array,
): void {
  const march = (deposit: boolean) => {
    for (let y = 0; y < height; y++) {
      const dir = rowWindDir(latRad(y, height))
      let airM = 1.0
      for (let step = 0; step < width; step++) {
        const x = dir > 0 ? step : width - 1 - step
        const i = idx(width, x, y)
        if (mask[i] < threshold) {
          const evap = OCEAN_EVAP * (evapScale ? evapScale[i] : 1)
          airM = airM + evap < 1 ? airM + evap : 1
        }
        const upstreamI = idx(width, wrapX(x - dir, width), y)
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
