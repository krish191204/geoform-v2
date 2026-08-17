/**
 * Closest geographically plausible shoreline to a sketch mask.
 *
 * Writers paint blobs. Continents have capes, inlets, and noisy shores —
 * not pixel stairs. This copies `input` (never mutates it), meanders the
 * coast with fBm, and keeps land area inside the mask-lock budget so the
 * continent stays where it was drawn.
 */
import { fbmSigned } from './terrainDetail'
import { idx, wrapX } from './helpers'

/** Stay inside the 5% lock with a little headroom. */
const AREA_BUDGET = 0.04

function isLand(mask: Float32Array, w: number, h: number, threshold: number, x: number, y: number): boolean {
  if (y < 0 || y >= h) return false
  return mask[idx(w, wrapX(x, w), y)] >= threshold
}

function landArea(mask: Float32Array, threshold: number): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] >= threshold) n++
  return n
}

function neighborLand(
  mask: Float32Array,
  w: number,
  h: number,
  threshold: number,
  x: number,
  y: number,
): number {
  let n = 0
  if (isLand(mask, w, h, threshold, x - 1, y)) n++
  if (isLand(mask, w, h, threshold, x + 1, y)) n++
  if (isLand(mask, w, h, threshold, x, y - 1)) n++
  if (isLand(mask, w, h, threshold, x, y + 1)) n++
  return n
}

function meanderPass(
  src: Float32Array,
  w: number,
  h: number,
  threshold: number,
  seed: number,
  sx: number,
  sy: number,
): Float32Array {
  const next = new Float32Array(src)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      const nLand = neighborLand(src, w, h, threshold, x, y)
      if (nLand === 0 || nLand === 4) continue
      const land = src[i] >= threshold
      const wave = fbmSigned(x / sx, y / sy, seed, 4)
      const grain = fbmSigned(x / (sx * 0.4), y / (sy * 0.45), seed + 19, 3)
      const v = wave * 0.7 + grain * 0.3
      if (land && v > 0.05) {
        next[i] = Math.min(src[i], threshold - 0.12 - v * 0.18)
      } else if (!land && v < -0.05) {
        next[i] = Math.max(src[i], threshold + 0.12 - v * 0.18)
      }
    }
  }
  return next
}

/**
 * If meander drifted land area past the budget, revert the weakest
 * shoreline flips until we are back inside it.
 */
function enforceArea(
  original: Float32Array,
  grounded: Float32Array,
  threshold: number,
): Float32Array {
  const target = landArea(original, threshold)
  const allowed = AREA_BUDGET * Math.max(1, target)
  let area = landArea(grounded, threshold)
  if (Math.abs(area - target) <= allowed) return grounded

  const out = new Float32Array(grounded)
  const tooMuchLand = area > target
  const order: { i: number; score: number }[] = []
  for (let i = 0; i < out.length; i++) {
    const wasLand = original[i] >= threshold
    const isLandNow = out[i] >= threshold
    if (tooMuchLand && isLandNow && !wasLand) order.push({ i, score: out[i] - threshold })
    if (!tooMuchLand && !isLandNow && wasLand) order.push({ i, score: threshold - out[i] })
  }
  order.sort((a, b) => a.score - b.score)
  for (const { i } of order) {
    if (Math.abs(area - target) <= allowed) break
    out[i] = original[i]
    area += tooMuchLand ? -1 : 1
  }
  return out
}

/**
 * Ground a sketch mask into a plausible shoreline. Pure: same inputs →
 * same output. Does not write `input`.
 */
export function groundCoast(
  input: Float32Array,
  width: number,
  height: number,
  threshold: number,
  seed: number,
): Float32Array {
  let mask = new Float32Array(input)
  mask = meanderPass(mask, width, height, threshold, seed + 44, 18, 14)
  mask = meanderPass(mask, width, height, threshold, seed + 71, 11, 9)
  return enforceArea(input, mask, threshold)
}
