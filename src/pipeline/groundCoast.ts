/**
 * Closest geographically plausible shoreline to a sketch mask.
 *
 * Writers paint blobs. Continents have capes, inlets, and noisy shores —
 * not pixel stairs. This copies `input` (never mutates it), fills enclosed
 * brush-seas, drops spray specks, meanders the coast with fBm, and keeps
 * land area inside the mask-lock budget. The atlas is allowed to look
 * different from the doodle.
 */
import { fbmSigned } from './terrainDetail'
import { idx, wrapX } from './helpers'

/** Headroom under the pipeline lock so meander + hole-fill can diverge. */
const AREA_BUDGET = 0.10
/** Land scraps smaller than this are spray, not islands. */
const SPECKLE_CELLS = 48

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
 * Ocean that is not the world ocean — inland brush gaps that never
 * join the main sea. Fill them as land. Does not write `src`.
 */
function fillEnclosedSeas(
  src: Float32Array,
  w: number,
  h: number,
  threshold: number,
): Float32Array {
  const n = src.length
  const label = new Int32Array(n)
  const area = new Int32Array(n)
  let nextId = 1
  const queue = new Int32Array(n)
  for (let seed = 0; seed < n; seed++) {
    if (label[seed] !== 0) continue
    if (src[seed] >= threshold) continue
    const id = nextId++
    let head = 0
    let tail = 0
    queue[tail++] = seed
    label[seed] = id
    let cells = 0
    while (head < tail) {
      const i = queue[head++]
      cells++
      const x = i % w
      const y = (i - x) / w
      const nbrs = [
        y * w + wrapX(x - 1, w),
        y * w + wrapX(x + 1, w),
        y > 0 ? (y - 1) * w + x : -1,
        y < h - 1 ? (y + 1) * w + x : -1,
      ]
      for (const j of nbrs) {
        if (j < 0 || label[j] !== 0 || src[j] >= threshold) continue
        label[j] = id
        queue[tail++] = j
      }
    }
    area[id] = cells
  }
  let keepId = 0
  let keepArea = 0
  for (let id = 1; id < nextId; id++) {
    if (area[id] > keepArea) {
      keepArea = area[id]
      keepId = id
    }
  }
  if (keepId === 0) return src
  const out = new Float32Array(src)
  for (let i = 0; i < n; i++) {
    const id = label[i]
    if (id !== 0 && id !== keepId) out[i] = threshold + 0.22
  }
  return out
}

/**
 * Drop land components too small to be islands. Does not write `src`.
 */
function dropSpeckles(
  src: Float32Array,
  w: number,
  h: number,
  threshold: number,
): Float32Array {
  const n = src.length
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  const out = new Float32Array(src)
  for (let seed = 0; seed < n; seed++) {
    if (seen[seed] || src[seed] < threshold) continue
    let head = 0
    let tail = 0
    queue[tail++] = seed
    seen[seed] = 1
    const cells: number[] = [seed]
    while (head < tail) {
      const i = queue[head++]
      const x = i % w
      const y = (i - x) / w
      const nbrs = [
        y * w + wrapX(x - 1, w),
        y * w + wrapX(x + 1, w),
        y > 0 ? (y - 1) * w + x : -1,
        y < h - 1 ? (y + 1) * w + x : -1,
      ]
      for (const j of nbrs) {
        if (j < 0 || seen[j] || src[j] < threshold) continue
        seen[j] = 1
        queue[tail++] = j
        cells.push(j)
      }
    }
    if (cells.length >= SPECKLE_CELLS) continue
    for (const i of cells) out[i] = Math.min(src[i], threshold - 0.2)
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
  mask = fillEnclosedSeas(mask, width, height, threshold)
  mask = dropSpeckles(mask, width, height, threshold)
  const cleaned = new Float32Array(mask)
  mask = meanderPass(mask, width, height, threshold, seed + 44, 18, 14)
  mask = meanderPass(mask, width, height, threshold, seed + 71, 11, 9)
  mask = meanderPass(mask, width, height, threshold, seed + 103, 7, 6)
  return enforceArea(cleaned, mask, threshold)
}
