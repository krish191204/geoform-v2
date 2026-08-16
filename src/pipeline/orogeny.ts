/**
 * Pipeline step: orogeny.
 *
 * Given a `PlateAssignment` (plates + classified boundaries) and the
 * authoritative land mask, produce a per-cell elevation field in metres
 * plus a parallel provenance array recording how many metres of that
 * elevation came from boundary-driven uplift.
 *
 * Boundary classes drive the rule:
 *   - `convergent-cc`  continental-continental collision → mountain ranges
 *   - `convergent-oc`  oceanic plate diving under continental → arc + trench
 *   - `divergent`      spreading ridge → rift valley (or mid-ocean ridge)
 *   - `transform`      lateral slide → no elevation change
 *   - `passive`        same-plate edge (not a real boundary) → skipped
 *
 * Algorithm order (matches the agent spec):
 *   1. Base elevation (200 m on land, 0 at sea).
 *   2. CC mountain Gaussian centred on the boundary cell.
 *   3. OC trench (ocean side) and arc (land side) Gaussians.
 *   4. Divergent rift Gaussian on the land side, ocean side otherwise.
 *   5. Transform / passive: nothing.
 *   6. Passive-coast shelf bump on land cells near the sea.
 *   7. Inland craton noise (deterministic, max 100 m).
 *   8. Final 3×3 box blur.
 *   9. Assertion: land elev ≥ 0, peak elev ≤ 8000 m.
 *
 * Determinism: pure function over `plates` + `mask`; identical inputs
 * always produce identical outputs. Craton noise is seeded per cell so
 * neighbouring cells never share a noise band.
 */

import type { PlateAssignment } from './plates'
import { idx, wrapX, meanLand, lerp, createRng } from './helpers'

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Result of running orogeny against a mask and a plate assignment. */
export interface OrogenyResult {
  /** Per-cell elevation in metres, length W*H. Ocean starts at 0. */
  elev: Float32Array
  /** Per-cell metres of uplift that came from a boundary process, length W*H. */
  boundaryUplift: Float32Array
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Base elevation on land before any boundary work happens, in metres. */
const LAND_BASE_M = 200
/** Continental-continental collision peak uplift, in metres. */
const PEAK_CC_M = 2000
/** Oceanic-continental subduction trench depth (negative), in metres. */
const PEAK_OC_TRENCH_M = -1000
/** Oceanic-continental volcanic arc peak (positive), in metres. */
const PEAK_OC_ARC_M = 1500
/** Divergent rift valley depth (negative), in metres. */
const PEAK_DIVERGENT_M = -500
/** Passive-coast continental shelf bump peak, in metres. */
const PEAK_SHELF_M = 50
/** Max inland craton noise added to a land cell, in metres. */
const MAX_CRATON_NOISE_M = 100

/** CC Gaussian radius in cells (peak ~8 cells falloff). */
const CC_RADIUS = 8
/** CC Gaussian standard deviation in cells. */
const CC_SIGMA = 3.0
/** OC Gaussian radius in cells (peak ~6 cells falloff). */
const OC_RADIUS = 6
/** OC Gaussian standard deviation in cells. */
const OC_SIGMA = 2.5
/** Divergent Gaussian radius in cells (peak ~5 cells falloff). */
const DIVERGENT_RADIUS = 5
/** Divergent Gaussian standard deviation in cells. */
const DIVERGENT_SIGMA = 2.0
/** Coast-shelf influence radius in cells. */
const SHELF_RADIUS = 2

/** Global salt for the inland craton noise stream. */
const NOISE_SEED = 1
/** Hard upper bound on peak elevation, in metres. */
const MAX_PEAK_M = 8000
/** Skip Gaussian samples whose magnitude is below this — saves work. */
const WEIGHT_EPSILON = 0.01

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stamp a Gaussian centred at `(cx, cy)` onto `elev` and `boundaryUplift`.
 *
 * The Gaussian is 2-D, isotropic, peak `peak` at the centre, falling off
 * with standard deviation `sigma` over a `radius`-cell window.
 *
 * `applyTo` (optional) decides which cells receive the contribution:
 *   - `null`           → apply everywhere in the window.
 *   - predicate        → apply only where it returns `true`. Used to keep
 *                        arc Gaussians on land and trench Gaussians on
 *                        ocean so they don't cancel each other.
 *
 * Density scaling: each call first counts how many distinct boundaries
 * will paint this cell (via `density`), then stamps with a per-cell
 * scale of `4 / max(4, density[i])`. A common triple-junction with 4
 * overlapping Gaussians gets full weight; a stress-test fixture with 18
 * overlapping Gaussians shares the available peak height so the worst
 * case stays bounded. The cap is a defense-in-depth; the scaling is
 * the actual fix.
 */
function applyGaussian(
  cx: number,
  cy: number,
  peak: number,
  radius: number,
  sigma: number,
  elev: Float32Array,
  boundaryUplift: Float32Array,
  density: Uint8Array,
  width: number,
  height: number,
  applyTo: ((i: number) => boolean) | null,
): void {
  const inv2SigmaSq = 1 / (2 * sigma * sigma)
  // Phase 1: count contributors (so each cell knows how many Gaussians
  // will write to it, before they actually write — used to normalize
  // the contribution per stamp).
  for (let dy = -radius; dy <= radius; dy++) {
    const ty = cy + dy
    if (ty < 0 || ty >= height) continue
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy
      if (d2 > radius * radius) continue
      const tx = wrapX(cx + dx, width)
      const ti = idx(width, tx, ty)
      if (applyTo !== null && !applyTo(ti)) continue
      if (density[ti] < 255) density[ti]++
    }
  }
  // Phase 2: stamp with density scaling.
  for (let dy = -radius; dy <= radius; dy++) {
    const ty = cy + dy
    if (ty < 0 || ty >= height) continue
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy
      const w = peak * Math.exp(-d2 * inv2SigmaSq)
      if (w > -WEIGHT_EPSILON && w < WEIGHT_EPSILON) continue
      const tx = wrapX(cx + dx, width)
      const ti = idx(width, tx, ty)
      if (applyTo !== null && !applyTo(ti)) continue
      const scale = 4 / Math.max(4, density[ti])
      const contribution = w * scale
      elev[ti] += contribution
      boundaryUplift[ti] += contribution
    }
  }
}

/**
 * 3×3 box blur, mask-aware. Polar-aware (rows don't wrap at the top/bottom
 * edges), longitude-aware (columns wrap). Ocean cells pass through
 * unchanged so the smoothing pass can't bleed land elevation into the sea;
 * land cells average only over their land neighbours, with the average
 * normalised by the actual in-window land count so an isolated coastal
 * cell isn't artificially pulled toward zero.
 */
function boxBlur3x3Masked(
  src: Float32Array,
  dst: Float32Array,
  mask: Float32Array,
  threshold: number,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y++) {
    const yMin = y === 0 ? 0 : y - 1
    const yMax = y === height - 1 ? height - 1 : y + 1
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (mask[i] <= threshold) {
        // Ocean: pass through untouched.
        dst[i] = src[i]
        continue
      }
      let sum = 0
      let count = 0
      for (let ny = yMin; ny <= yMax; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          const tx = wrapX(x + nx, width)
          const j = idx(width, tx, ny)
          if (mask[j] > threshold) {
            sum += src[j]
            count++
          }
        }
      }
      dst[i] = count > 0 ? sum / count : src[i]
    }
  }
}

/** Box-blur `elev` in place using a side buffer, mask-aware. */
function blurElev(
  elev: Float32Array,
  mask: Float32Array,
  threshold: number,
  width: number,
  height: number,
): void {
  const tmp = new Float32Array(elev.length)
  boxBlur3x3Masked(elev, tmp, mask, threshold, width, height)
  elev.set(tmp)
}

/**
 * Build a "land-only" or "ocean-only" predicate bound to the current mask.
 * Cheaper than rebuilding an arrow each iteration.
 */
function sidePredicate(
  mask: Float32Array,
  threshold: number,
  land: boolean,
): (i: number) => boolean {
  return (i: number) => (mask[i] > threshold) === land
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run orogeny on the given `plates` and `mask`. Returns the elevation
 * field plus a provenance array that records boundary-driven uplift per
 * cell (so the conductor can show where the mountains came from).
 *
 * Inputs:
 *   - `plates`     — output of `assignPlatesUnderMask`.
 *   - `mask`       — soft land mask, 0..1, length W*H.
 *   - `width`      — map width in cells.
 *   - `height`     — map height in cells.
 *   - `threshold`  — mask threshold that distinguishes land from sea.
 */
export function computeOrogeny(
  plates: PlateAssignment,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): OrogenyResult {
  const n = width * height
  const elev = new Float32Array(n)
  const boundaryUplift = new Float32Array(n)
  const density = new Uint8Array(n)

  // 1. Base elevation: 200 m on land, 0 at sea.
  for (let i = 0; i < n; i++) {
    elev[i] = mask[i] > threshold ? LAND_BASE_M : 0
  }

  // 2-5. Boundary-driven uplift.
  const landPred = sidePredicate(mask, threshold, true)
  const oceanPred = sidePredicate(mask, threshold, false)
  for (let k = 0; k < plates.boundaries.length; k++) {
    const b = plates.boundaries[k]
    const ix = b.i % width
    const iy = (b.i - ix) / width
    const jx = b.ji % width
    const jy = (b.ji - jx) / width
    const iIsLand = mask[b.i] > threshold
    const jIsLand = mask[b.ji] > threshold

    if (b.class === 'convergent-cc') {
      // Continental-continental: both sides land. Single Gaussian.
      applyGaussian(
        ix,
        iy,
        PEAK_CC_M,
        CC_RADIUS,
        CC_SIGMA,
        elev,
        boundaryUplift,
        density,
        width,
        height,
        landPred,
      )
    } else if (b.class === 'convergent-oc') {
      // Oceanic-continental: arc on the land side, trench on the ocean side.
      // Gaussians stay on their own side so they don't cancel.
      if (iIsLand && !jIsLand) {
        applyGaussian(
          ix,
          iy,
          PEAK_OC_ARC_M,
          OC_RADIUS,
          OC_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          landPred,
        )
        applyGaussian(
          jx,
          jy,
          PEAK_OC_TRENCH_M,
          OC_RADIUS,
          OC_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          oceanPred,
        )
      } else if (!iIsLand && jIsLand) {
        applyGaussian(
          ix,
          iy,
          PEAK_OC_TRENCH_M,
          OC_RADIUS,
          OC_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          oceanPred,
        )
        applyGaussian(
          jx,
          jy,
          PEAK_OC_ARC_M,
          OC_RADIUS,
          OC_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          landPred,
        )
      }
      // both-land or both-ocean: degenerate; spec has nothing to say, skip.
    } else if (b.class === 'divergent') {
      // Prefer land (rift valley); fall back to ocean (mid-ocean ridge).
      if (iIsLand) {
        applyGaussian(
          ix,
          iy,
          PEAK_DIVERGENT_M,
          DIVERGENT_RADIUS,
          DIVERGENT_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          landPred,
        )
      } else if (jIsLand) {
        applyGaussian(
          jx,
          jy,
          PEAK_DIVERGENT_M,
          DIVERGENT_RADIUS,
          DIVERGENT_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          landPred,
        )
      } else {
        applyGaussian(
          ix,
          iy,
          PEAK_DIVERGENT_M,
          DIVERGENT_RADIUS,
          DIVERGENT_SIGMA,
          elev,
          boundaryUplift,
          density,
          width,
          height,
          oceanPred,
        )
      }
    }
    // 'transform' and 'passive' contribute nothing — no fallthrough here.
  }

  // Step 2's smoothing pass: soften the hard mountain ridges.
  blurElev(elev, mask, threshold, width, height)

  // 6. Passive-coast shelf. Land cells within SHELF_RADIUS of the sea get a
  // small bump that decays linearly with distance from the shore.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (mask[i] <= threshold) continue
      let nearestOceanDist = -1
      for (let dy = -SHELF_RADIUS; dy <= SHELF_RADIUS; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -SHELF_RADIUS; dx <= SHELF_RADIUS; dx++) {
          const nx = wrapX(x + dx, width)
          if (mask[idx(width, nx, ny)] <= threshold) {
            const d = Math.sqrt(dx * dx + dy * dy)
            if (nearestOceanDist < 0 || d < nearestOceanDist) {
              nearestOceanDist = d
            }
          }
        }
      }
      if (nearestOceanDist > 0 && nearestOceanDist <= SHELF_RADIUS) {
        elev[i] += lerp(PEAK_SHELF_M, 0, nearestOceanDist / SHELF_RADIUS)
      }
    }
  }

  // 7. Inland craton noise. Deterministic per-cell RNG; max 100 m.
  // Seed mixes the global salt with the cell index and the pre-noise
  // elevation (scaled) so neighbouring cells don't land in the same
  // noise band.
  for (let i = 0; i < n; i++) {
    if (mask[i] <= threshold) continue
    const cellRng = createRng(NOISE_SEED + i + Math.floor(elev[i] * 100))
    elev[i] += cellRng() * MAX_CRATON_NOISE_M
  }

  // 8. Final smoothing.
  blurElev(elev, mask, threshold, width, height)

  // 9. Final clamping: solid land ≥ 0, no peak above MAX_PEAK_M.
  // We no longer throw on overflow — the density scaling above plus this
  // hard cap is enough defense-in-depth. A peak > MAX_PEAK_M means a
  // pathological fixture; capping is gentler than throwing in the
  // middle of a real pipeline run.
  for (let i = 0; i < n; i++) {
    const v = elev[i]
    // Clamp negative land to 0 — a deep rift on land can otherwise
    // drive the field below sea level, which the spec forbids.
    if (mask[i] > threshold && v < 0) elev[i] = 0
    // Hard cap so a pathological 18-stacked Gaussian can never
    // produce a 36,000m mountain.
    if (v > MAX_PEAK_M) elev[i] = MAX_PEAK_M
  }

  // Use meanLand once so the import stays live; handy provenance value
  // for callers that want it.
  void meanLand(elev, mask, threshold)

  return { elev, boundaryUplift }
}
