/**
 * Hydrology step: flow accumulation and river mask.
 *
 * Algorithm:
 *   1. Sink-fill the elevation so every cell has a downhill path to a coast.
 *   2. Sort cells by elevation descending.
 *   3. D8 flow accumulation: each cell donates `1 + flux[cell]` to its lowest
 *      neighbour. Ocean cells are sinks. Local maxima (no lower neighbour)
 *      stay at `flux = 0`.
 *   4. Mark rivers where `flux > RIVER_THRESHOLD`.
 *
 * No flux boost, no multiplier. Raw accumulation; the renderer scales on
 * display. The audit explicitly flagged flux boosting as a hack — real rivers
 * fall out of real terrain.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** River cutoff. `flux > RIVER_THRESHOLD` -> river cell. */
export const RIVER_THRESHOLD = 8

/** √2 — D8 diagonal distance. */
const SQRT2 = Math.SQRT2

/** D8 offsets: dx, dy, distance. Cardinals = 1, diagonals = √2. */
export const D8_OFFSETS: ReadonlyArray<{ dx: number; dy: number; dist: number }> = [
  { dx: -1, dy: -1, dist: SQRT2 },
  { dx: 0, dy: -1, dist: 1 },
  { dx: 1, dy: -1, dist: SQRT2 },
  { dx: -1, dy: 0, dist: 1 },
  { dx: 1, dy: 0, dist: 1 },
  { dx: -1, dy: 1, dist: SQRT2 },
  { dx: 0, dy: 1, dist: 1 },
  { dx: 1, dy: 1, dist: SQRT2 },
]

// ---------------------------------------------------------------------------
// Helpers (inlined; the rest of the pipeline will share these once extracted)
// ---------------------------------------------------------------------------

/** Row-major index into a W*H typed array. */
export function idx(w: number, x: number, y: number): number {
  return y * w + x
}

/** Wrap x around the longitudinal seam (toroidal). */
export function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

/** Average mask value over land cells (mask >= threshold). 0 if none. */
export function meanLand(mask: Float32Array, threshold: number): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] >= threshold) {
      sum += mask[i]
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

// ---------------------------------------------------------------------------
// D8 neighbour descent
// ---------------------------------------------------------------------------

/**
 * Index of the lowest neighbour, or -1 if this cell is a local maximum.
 * Ocean cells are valid destinations — they accumulate flux but never
 * propagate it (the main loop skips them). This keeps coastal cells as
 * proper drains without breaking flat-land tests.
 */
function lowestNeighbour(
  elev: Float32Array,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  let bestJ = -1
  let bestH = elev[idx(w, x, y)]
  for (let k = 0; k < 8; k++) {
    const o = D8_OFFSETS[k]
    const nx = wrapX(x + o.dx, w)
    const ny = y + o.dy
    if (ny < 0 || ny >= h) continue
    const j = idx(w, nx, ny)
    const hn = elev[j]
    if (hn < bestH) {
      bestH = hn
      bestJ = j
    }
  }
  return bestJ
}

// ---------------------------------------------------------------------------
// Sink fill
// ---------------------------------------------------------------------------

/**
 * Raise every interior pit so each land cell has a downhill path to the coast.
 *
 * Naive "lift each pit to its lowest neighbour" iterations collapse a real
 * landscape into a flat plateau (every cell propagates the global minimum
 * uphill). The correct algorithm is Planchon-Darboux / priority-flood:
 *
 *   1. Seed a min-heap with the ocean cells at their original elevation.
 *   2. Pop the lowest cell; mark visited.
 *   3. For each unvisited neighbour, set filled = max(original, popped) and
 *      push. The max ensures elevation is monotonic away from the ocean —
 *      pits get filled, ridges stay above their surroundings.
 *
 * After this, every land cell either matches its filled elevation (if it
 * was a pit) or its original elevation (if it had natural downhill).
 */
function fillSinks(
  elev: Float32Array,
  mask: Float32Array,
  w: number,
  h: number,
  threshold: number,
): void {
  const n = w * h
  // Binary heap keyed on filled elevation.
  const heap: number[] = []
  const visited = new Uint8Array(n)

  const lessThan = (a: number, b: number): boolean => elev[heap[a]] < elev[heap[b]]
  const swap = (a: number, b: number): void => {
    const tmp = heap[a]
    heap[a] = heap[b]
    heap[b] = tmp
  }
  const siftUp = (slot: number): void => {
    while (slot > 0) {
      const parent = (slot - 1) >> 1
      if (lessThan(slot, parent)) {
        swap(slot, parent)
        slot = parent
      } else break
    }
  }
  const siftDown = (slot: number): void => {
    const len = heap.length
    for (;;) {
      const l = slot * 2 + 1
      const r = l + 1
      let smallest = slot
      if (l < len && lessThan(l, smallest)) smallest = l
      if (r < len && lessThan(r, smallest)) smallest = r
      if (smallest === slot) break
      swap(slot, smallest)
      slot = smallest
    }
  }
  const push = (i: number): void => {
    heap.push(i)
    siftUp(heap.length - 1)
  }
  const pop = (): number => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      siftDown(0)
    }
    return top
  }

  // Seed: ocean cells (and any land cell with mask[i] < threshold, which
  // includes any other soft-mask "ocean-like" zones). Their filled elev is
  // their original elev — they're drains.
  for (let i = 0; i < n; i++) {
    if (mask[i] < threshold) {
      push(i)
      visited[i] = 1
    }
  }

  // Spread outward.
  while (heap.length > 0) {
    const cur = pop()
    const cx = cur % w
    const cy = (cur - cx) / w
    for (let k = 0; k < 8; k++) {
      const o = D8_OFFSETS[k]
      const nx = wrapX(cx + o.dx, w)
      const ny = cy + o.dy
      if (ny < 0 || ny >= h) continue
      const j = idx(w, nx, ny)
      if (visited[j]) continue
      visited[j] = 1
      // Pits rise; ridges stay.
      if (elev[j] < elev[cur]) elev[j] = elev[cur]
      push(j)
    }
  }
}

// ---------------------------------------------------------------------------
// Cell sort
// ---------------------------------------------------------------------------

/**
 * Cell indices sorted by elevation descending. Stable for ties via index
 * order — matters for reproducibility.
 */
function sortByElevationDesc(elev: Float32Array): Uint32Array {
  const n = elev.length
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  // TypedArray doesn't have a stable sort everywhere; the comparator keeps
  // ties deterministic by falling back to the original index.
  const a = Array.from(order)
  a.sort((i, j) => {
    const d = elev[j] - elev[i]
    if (d !== 0) return d
    return i - j
  })
  for (let i = 0; i < n; i++) order[i] = a[i]
  return order
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HydrologyResult {
  /** Accumulated downhill water flux per cell, length W*H. Raw — no scaling. */
  flux: Float32Array
  /** 1 = river cell (flux > RIVER_THRESHOLD), 0 = not. Length W*H. */
  rivers: Uint8Array
}

/**
 * Compute flow accumulation and a river mask.
 *
 * @param elev elevation field, length W*H
 * @param mask soft mask, 0..1, length W*H
 * @param width grid width
 * @param height grid height
 * @param threshold mask threshold separating land from ocean
 */
export function computeHydrology(
  elev: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): HydrologyResult {
  const n = width * height
  // Copy elevation: sink-fill mutates it, and the caller owns the input.
  const e = new Float32Array(n)
  for (let i = 0; i < n; i++) e[i] = elev[i]

  // 1. Sink fill — every land cell gets a downhill path.
  fillSinks(e, mask, width, height, threshold)

  // 2. Sort cells by elevation descending.
  const order = sortByElevationDesc(e)

  // 3. D8 flow accumulation.
  const flux = new Float32Array(n)
  const rivers = new Uint8Array(n)

  for (let o = 0; o < n; o++) {
    const i = order[o]
    // Skip ocean cells — they are sinks; flux is meaningful on land.
    if (mask[i] < threshold) continue
    const x = i % width
    const y = (i - x) / width
    const j = lowestNeighbour(e, x, y, width, height)
    if (j === -1) {
      // Sink / flat plain / local min: no strictly lower neighbour.
      // Keep accumulated flux from donors above (the descending sort
      // already added them). The original code wrongly zeroed flux here,
      // clobbering downstream-cumulated flux. The Donald-bar check
      // (`flux[i] === 0` on strict local maxima) is independent and
      // asserted in a separate test (see PR 5).
      continue
    }
    flux[j] += 1 + flux[i]
  }

  // 4. Mark rivers where flux exceeds the documented threshold.
  for (let i = 0; i < n; i++) {
    if (mask[i] < threshold) {
      rivers[i] = 0
      continue
    }
    rivers[i] = flux[i] > RIVER_THRESHOLD ? 1 : 0
  }

  return { flux, rivers }
}