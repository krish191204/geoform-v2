/**
 * Coherent relief + a short hydraulic-erosion pass, used by orogeny.
 *
 * Why this file exists instead of vendoring the three upstream repos:
 *
 *   - FastNoise2 (Auburn) is a C++17 SIMD node-graph library. It cannot
 *     run in the browser Make-sense worker. What we want from it is the
 *     *family* of functions: gradient noise, fBm, and ridged fBm. Those
 *     are implemented here as compact TypeScript.
 *
 *   - terrain-erosion-3-ways (dandrino, MIT 2018) is the source of the
 *     ridge recipe (`|fbm|` octaves, invert, square) and of the hydraulic
 *     loop (rain → slope-capacity → erode or deposit → move downhill →
 *     evaporate, plus angle-of-repose slump). Their numpy sim runs
 *     ~1.4 × dim iterations on a square grid; a 768×384 atlas cannot
 *     afford that on every Make-sense click. We keep the same physics
 *     with ~10 D8 sweeps.
 *
 *   - WorldEngine (Mindwerks) uses the same shape — simplex hills, then
 *     water-driven incision — but it generates its own continents. Calling
 *     it from Make sense would break mask-lock. We steal the shape, not
 *     the process.
 *
 * Pipeline modules must not import `src/world/` (including `world/noise.ts`),
 * so the noise lives here.
 */

import { idx, wrapX } from './helpers'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rolling-hill amplitude on craton, in metres. */
const CRATON_RELIEF_M = 320
/** Bias so fBm ∈ [-1, 1] maps to a mostly-positive add (0 … ~0.9 × CRATON). */
const CRATON_BIAS = 0.4
/** Ridge texture cap on collision belts, in metres. */
const RIDGE_CAP_M = 480
/** Ridge amplitude as a fraction of local boundary uplift. */
const RIDGE_FROM_UPLIFT = 0.22
/** Skip ridge texture below this many metres of boundary uplift. */
const RIDGE_MIN_UPLIFT_M = 50

/** Hydraulic sweeps. Far below dandrino's ~1.4×dim; enough to incise valleys. */
const ERODE_ITERS = 14
/** Water added per land cell per sweep (dimensionless). */
const RAIN = 0.035
/** Fraction of water that evaporates after each sweep. */
const EVAP = 0.4
/** Sediment capacity ≈ slope × water × this. */
const CAPACITY_K = 0.12
/** Fraction of (capacity − sediment) dissolved from the cell. */
const DISSOLVE = 0.18
/** Hard cap on incision per cell per sweep, in metres. */
const MAX_CUT_M = 12
/** Fraction of over-capacity sediment dropped in place. */
const DEPOSIT_RATE = 0.35
/** Fraction of water (and all sediment) sent to the steepest downhill neighbour. */
const TRANSFER = 0.6
/** Angle-of-repose as metres of drop per orthogonal cell. */
const REPOSE_M = 1600
/** Fraction of repose-excess that slumps downhill per sweep. */
const SLUMP = 0.18
/** Don't cut land below this, so rifts don't punch through to sea. */
const MIN_LAND_M = 5

const SQRT2 = Math.SQRT2

const D8: ReadonlyArray<{ dx: number; dy: number; dist: number }> = [
  { dx: -1, dy: -1, dist: SQRT2 },
  { dx: 0, dy: -1, dist: 1 },
  { dx: 1, dy: -1, dist: SQRT2 },
  { dx: -1, dy: 0, dist: 1 },
  { dx: 1, dy: 0, dist: 1 },
  { dx: -1, dy: 1, dist: SQRT2 },
  { dx: 0, dy: 1, dist: 1 },
  { dx: 1, dy: 1, dist: SQRT2 },
]

const GRAD2: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

// ---------------------------------------------------------------------------
// Gradient noise (FastNoise-style)
// ---------------------------------------------------------------------------

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed
  n = (n ^ (n >>> 13)) >>> 0
  n = Math.imul(n, 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

function gradDot(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const g = GRAD2[(hash2(ix, iy, seed) * 8) & 7]
  return g[0] * dx + g[1] * dy
}

/** Gradient noise, roughly in [-1, 1]. */
export function perlin2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const u = fade(fx)
  const v = fade(fy)
  const n00 = gradDot(x0, y0, seed, fx, fy)
  const n10 = gradDot(x0 + 1, y0, seed, fx - 1, fy)
  const n01 = gradDot(x0, y0 + 1, seed, fx, fy - 1)
  const n11 = gradDot(x0 + 1, y0 + 1, seed, fx - 1, fy - 1)
  const nx0 = n00 + u * (n10 - n00)
  const nx1 = n01 + u * (n11 - n01)
  return nx0 + v * (nx1 - nx0)
}

/** Signed fBm in roughly [-1, 1]. */
export function fbmSigned(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin2(x * freq, y * freq, seed + o * 1013)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/**
 * Ridged fBm in [0, 1], sharp crests.
 *
 * Follows dandrino `ridge_noise.py`: accumulate |noise|, invert, square.
 */
export function ridgeFbm(x: number, y: number, seed: number, octaves = 5): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += Math.abs(perlin2(x * freq, y * freq, seed + o * 19)) * amp
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  const inverted = 1 - (norm > 0 ? sum / norm : 0)
  return inverted * inverted
}

// ---------------------------------------------------------------------------
// Relief
// ---------------------------------------------------------------------------

/**
 * Add rolling craton hills and ridged texture on collision belts.
 * In-place; ocean cells are left alone.
 */
export function applyCoherentRelief(
  elev: Float32Array,
  boundaryUplift: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  seed: number,
): void {
  const invW = 1 / Math.max(1, width)
  const invH = 1 / Math.max(1, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (mask[i] <= threshold) continue
      const hill = fbmSigned(x * invW * 6, y * invH * 3, seed)
      elev[i] += (hill * 0.5 + CRATON_BIAS) * CRATON_RELIEF_M
      const belt = boundaryUplift[i]
      if (belt > RIDGE_MIN_UPLIFT_M) {
        const ridge = ridgeFbm(x * invW * 16, y * invH * 8, seed ^ 0xa11e)
        const amp = Math.min(belt * RIDGE_FROM_UPLIFT, RIDGE_CAP_M)
        elev[i] += ridge * amp
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hydraulic erosion (dandrino loop, D8, short)
// ---------------------------------------------------------------------------

function steepestDownhill(
  elev: Float32Array,
  x: number,
  y: number,
  width: number,
  height: number,
): { j: number; slope: number } | null {
  const i = idx(width, x, y)
  const e = elev[i]
  let best = -1
  let bestSlope = 0
  for (let k = 0; k < D8.length; k++) {
    const { dx, dy, dist } = D8[k]
    const ny = y + dy
    if (ny < 0 || ny >= height) continue
    const j = idx(width, wrapX(x + dx, width), ny)
    const drop = e - elev[j]
    if (drop <= 0) continue
    const slope = drop / dist
    if (slope > bestSlope) {
      bestSlope = slope
      best = j
    }
  }
  return best < 0 ? null : { j: best, slope: bestSlope }
}

/**
 * In-place hydraulic erosion plus a light thermal slump.
 *
 * Ocean cells are sinks: water and sediment that reach them vanish, so
 * the sea floor (trenches included) is not filled in. Land is never cut
 * below `MIN_LAND_M`.
 */
export function hydraulicErode(
  elev: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  seed: number,
): void {
  const n = width * height
  const water = new Float32Array(n)
  const sediment = new Float32Array(n)
  const land: number[] = []
  for (let i = 0; i < n; i++) {
    if (mask[i] > threshold) land.push(i)
  }
  if (land.length === 0) return

  for (let t = 0; t < ERODE_ITERS; t++) {
    for (let k = 0; k < land.length; k++) {
      const i = land[k]
      const x = i % width
      const y = (i - x) / width
      water[i] += RAIN * (0.65 + 0.7 * hash2(x, y, seed + t * 17))
    }

    land.sort((a, b) => {
      const d = elev[b] - elev[a]
      return d !== 0 ? d : a - b
    })

    for (let k = 0; k < land.length; k++) {
      const i = land[k]
      const x = i % width
      const y = (i - x) / width
      const down = steepestDownhill(elev, x, y, width, height)
      if (down === null) continue

      const cap = water[i] * down.slope * CAPACITY_K
      const extra = sediment[i] - cap
      if (extra > 0) {
        const dep = extra * DEPOSIT_RATE
        elev[i] += dep
        sediment[i] -= dep
      } else {
        const room = Math.max(0, elev[i] - MIN_LAND_M)
        const cut = Math.min(MAX_CUT_M, (cap - sediment[i]) * DISSOLVE, room)
        elev[i] -= cut
        sediment[i] += cut
      }

      if (mask[down.j] > threshold) {
        const moveW = water[i] * TRANSFER
        water[i] -= moveW
        water[down.j] += moveW
        sediment[down.j] += sediment[i]
        sediment[i] = 0
      } else {
        // Drain into the ocean: sediment leaves the continent.
        water[i] *= 1 - TRANSFER
        sediment[i] = 0
      }
    }

    for (let k = 0; k < land.length; k++) {
      water[land[k]] *= 1 - EVAP
    }

    // Thermal: knife-edges above repose slump downhill, land-to-land only.
    for (let k = 0; k < land.length; k++) {
      const i = land[k]
      const x = i % width
      const y = (i - x) / width
      for (let d = 0; d < D8.length; d++) {
        const { dx, dy, dist } = D8[d]
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const j = idx(width, wrapX(x + dx, width), ny)
        if (mask[j] <= threshold) continue
        const excess = elev[i] - elev[j] - REPOSE_M * dist
        if (excess <= 0) continue
        const move = excess * SLUMP
        elev[i] -= move
        elev[j] += move
      }
    }
  }
}

/**
 * Rolling hills + belt ridges, then a short hydraulic carve.
 * In-place on `elev`. Ocean is not raised.
 */
export function sculptTerrain(
  elev: Float32Array,
  boundaryUplift: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  seed: number,
): void {
  applyCoherentRelief(elev, boundaryUplift, mask, width, height, threshold, seed)
  hydraulicErode(elev, mask, width, height, threshold, seed)
}
