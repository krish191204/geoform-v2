/**
 * Shared pipeline utilities — used by every Make-sense module.
 *
 * Everything here is pure: same inputs → same outputs, no hidden state,
 * no Date.now / Math.random. The conductor and downstream modules rely
 * on that to keep Make-sense reproducible across runs.
 *
 * Pipeline modules MUST NOT import from `src/world/` or `src/app/`; if
 * something here overlaps with `world/types.ts` (e.g. `idx`, `clamp`),
 * it's because the pipeline needs its own copy that doesn't drag in the
 * `World` type or `BIOME_COLORS` atlas.
 */

// ---------------------------------------------------------------------------
// Indexing and scalar math
// ---------------------------------------------------------------------------

/** Row-major cell index: `y * width + x`. */
export function idx(w: number, x: number, y: number): number {
  return y * w + x
}

/** Clamp `v` into the inclusive range `[lo, hi]`. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Linear interpolation: `a + (b - a) * t`. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Cosine falloff: 1 at the centre, 0 at the edge, C¹-continuous.
 * Returns 0 for `t >= 1`, 1 for `t <= 0`, and `0.5 * (1 + cos(π * t))` between.
 */
export function cosineFalloff(t: number): number {
  if (t <= 0) return 1
  if (t >= 1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * t))
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/** Latitude in radians from cell `y`: top (y=0) = +π/2, bottom (y=h−1) = −π/2. */
export function latRad(y: number, height: number): number {
  if (height <= 1) return 0
  return Math.PI / 2 - (Math.PI * y) / (height - 1)
}

/** Cell latitude in `[0, 1]`: 0 = south pole, 1 = north pole. */
export function latNorm(y: number, height: number): number {
  if (height <= 1) return 0.5
  return 1 - y / (height - 1)
}

/** Wrap an x-coordinate around the longitudinal seam: `((x % w) + w) % w`. */
export function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

/** Great-circle (haversine) distance in km between two cells on a planet of radius `R`. */
export function cellDistanceKm(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
  height: number,
  planetRadiusKm: number,
): number {
  if (width <= 0 || height <= 0) return 0
  const lonA = (ax / width) * 2 * Math.PI
  const latA = latRad(ay, height)
  const lonB = (bx / width) * 2 * Math.PI
  const latB = latRad(by, height)
  const dLat = latB - latA
  const dLon = lonB - lonA
  const sinHalfLat = Math.sin(dLat / 2)
  const sinHalfLon = Math.sin(dLon / 2)
  const h =
    sinHalfLat * sinHalfLat +
    Math.cos(latA) * Math.cos(latB) * sinHalfLon * sinHalfLon
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
  return planetRadiusKm * c
}

// ---------------------------------------------------------------------------
// Mask operations
// ---------------------------------------------------------------------------

/**
 * BFS distance from the nearest sea cell.
 *
 * Multi-source BFS: every cell with `mask[i] <= threshold` is a source
 * with distance 0. The horizontal axis wraps (longitude seam); the
 * vertical axis does not (poles are real). Distance is in 4-neighbour
 * cells (Manhattan grid distance).
 */
export function bfsDistanceFromSea(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): Float32Array {
  const n = width * height
  const out = new Float32Array(n)
  const visited = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0

  for (let i = 0; i < n; i++) {
    if (mask[i] <= threshold) {
      out[i] = 0
      visited[i] = 1
      queue[tail++] = i
    }
  }

  while (head < tail) {
    const i = queue[head++]
    const x = i % width
    const y = (i - x) / width
    const base = out[i] + 1

    const nxLeft = x === 0 ? width - 1 : x - 1
    const nxRight = x === width - 1 ? 0 : x + 1
    const row = y * width
    const next: number[] = [row + nxLeft, row + nxRight]
    if (y > 0) next.push(row - width + x)
    if (y < height - 1) next.push(row + width + x)

    for (let k = 0; k < next.length; k++) {
      const j = next[k]
      if (visited[j] !== 0) continue
      visited[j] = 1
      out[j] = base
      queue[tail++] = j
    }
  }

  return out
}

/**
 * Largest components mask: flood-fill over 4-connected land cells, keep
 * components whose area is at least `minArea`. Returns a Uint8Array
 * (`1` = cell in a kept component, `0` = dropped or sea) and the count
 * of components kept. The horizontal axis wraps; the vertical axis does not.
 */
export function bigComponentsMask(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  minArea: number,
): { mask: Uint8Array; count: number } {
  const n = width * height
  const out = new Uint8Array(n)
  if (n === 0) return { mask: out, count: 0 }

  const visited = new Uint8Array(n)
  const queue = new Int32Array(n)
  let bigCount = 0

  for (let y = 0; y < height; y++) {
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      const seed = rowBase + x
      if (visited[seed] !== 0) continue
      if (mask[seed] < threshold) {
        visited[seed] = 1
        continue
      }

      let head = 0
      let tail = 0
      queue[tail++] = seed
      visited[seed] = 1
      const members: number[] = []

      while (head < tail) {
        const i = queue[head++]
        members.push(i)

        const cx = i % width
        const cy = (i - cx) / width
        const nxLeft = cx === 0 ? width - 1 : cx - 1
        const nxRight = cx === width - 1 ? 0 : cx + 1
        const row = cy * width
        const next: number[] = [row + nxLeft, row + nxRight]
        if (cy > 0) next.push(row - width + cx)
        if (cy < height - 1) next.push(row + width + cx)

        for (let k = 0; k < next.length; k++) {
          const j = next[k]
          if (visited[j] !== 0) continue
          if (mask[j] < threshold) continue
          visited[j] = 1
          queue[tail++] = j
        }
      }

      if (members.length >= minArea) {
        bigCount++
        for (let k = 0; k < members.length; k++) {
          out[members[k]] = 1
        }
      }
    }
  }

  return { mask: out, count: bigCount }
}

/** Arithmetic mean of `values[i]` over cells where `mask[i] > threshold`. */
export function meanLand(values: Float32Array, mask: Float32Array, threshold: number): number {
  let sum = 0
  let count = 0
  for (let i = 0; i < values.length; i++) {
    if (mask[i] > threshold) {
      sum += values[i]
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

/** Sum of `values[i]` over cells where `mask[i] > threshold`. */
export function sumLand(values: Float32Array, mask: Float32Array, threshold: number): number {
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    if (mask[i] > threshold) sum += values[i]
  }
  return sum
}

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** Mulberry32 — fast, deterministic, seeded PRNG returning floats in `[0, 1)`. */
export function createRng(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r ^ (r + Math.imul(r ^ (r >>> 7), 61 | r))) >>> 0
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Neighbour stencils
// ---------------------------------------------------------------------------

/** 4-connectivity offsets in `[dx, dy]` form: N, E, S, W. */
export const D4_OFFSETS: readonly [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]]

/** 8-connectivity offsets in `[dx, dy]` form (corners + edges). */
export const D8_OFFSETS: readonly [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
]

// ---------------------------------------------------------------------------
// Plate count heuristic
// ---------------------------------------------------------------------------

/**
 * Stable plate count for a given land area (cells).
 *
 * 4 if < 1000, 6 if < 5000, 8 if < 20000, 10 otherwise.
 * Tiny landmasses get few plates so they don't fragment; big ones get
 * enough plates to produce believable boundaries.
 */
export function plateCountForArea(landArea: number): number {
  if (landArea < 1000) return 4
  if (landArea < 5000) return 6
  if (landArea < 20000) return 8
  return 10
}