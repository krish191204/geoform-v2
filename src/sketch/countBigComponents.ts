/**
 * Connected-component counting for the soft mask.
 *
 * Used by the coach commit hook to report how many "big" land blobs the
 * writer has produced. Two cells are neighbours if they share an edge
 * (4-connectivity). The horizontal seam wraps (longitude wraparound).
 */

export interface ComponentStats {
  /** Total number of components whose area is at least `minBigArea`. */
  bigComponents: number
  /** Areas of all components found, biggest first. Useful for diagnostics. */
  areas: Float32Array
}

/**
 * BFS flood-fill over `mask` using a 4-neighbour stencil.
 *
 * A cell is "on" if `mask[i] >= threshold`. The horizontal axis wraps,
 * so column 0 is adjacent to column `width - 1`; the vertical axis does
 * not (poles are real poles — we treat them as ordinary seams).
 *
 * Returns the count of components with `area >= minBigArea`, plus a
 * sorted list of all component areas for callers that want the full
 * distribution.
 */
export function countBigComponents(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  minBigArea: number,
): number {
  return analyseComponents(mask, width, height, threshold, minBigArea).bigComponents
}

/**
 * Full version of `countBigComponents` — exposes per-component areas too.
 */
export function analyseComponents(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  minBigArea: number,
): ComponentStats {
  if (width <= 0 || height <= 0 || mask.length !== width * height) {
    return { bigComponents: 0, areas: new Float32Array(0) }
  }

  const visited = new Uint8Array(mask.length)
  // Worst case: every cell is its own component. Pre-size the buffer.
  const areaBuf = new Float32Array(mask.length)
  let areaCount = 0
  const queue = new Int32Array(mask.length)

  for (let y = 0; y < height; y++) {
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      const seed = rowBase + x
      if (visited[seed] !== 0) continue
      if (mask[seed] < threshold) {
        visited[seed] = 1
        continue
      }

      // BFS over the component rooted at (x, y).
      let head = 0
      let tail = 0
      queue[tail++] = seed
      visited[seed] = 1
      let area = 0

      while (head < tail) {
        const i = queue[head++]
        area++

        const cx = i % width
        const cy = (i - cx) / width

        // 4-neighbour offsets; x wraps, y does not.
        const neighbours = [
          [cx === 0 ? width - 1 : cx - 1, cy],
          [cx === width - 1 ? 0 : cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ] as const

        for (const [nx, ny] of neighbours) {
          if (ny < 0 || ny >= height) continue
          const j = ny * width + nx
          if (visited[j] !== 0) continue
          if (mask[j] < threshold) continue
          visited[j] = 1
          queue[tail++] = j
        }
      }

      if (area > 0) {
        areaBuf[areaCount++] = area
      }
    }
  }

  // Sort a fresh, tightly-sized view of the populated portion.
  const filled = areaBuf.subarray(0, areaCount)
  const sorted = Float32Array.from(filled)
  sorted.sort()
  // Float32Array sorts ascending; reverse for biggest-first.
  const reversed = new Float32Array(sorted.length)
  for (let i = 0; i < sorted.length; i++) {
    reversed[i] = sorted[sorted.length - 1 - i]
  }
  let bigComponents = 0
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i] >= minBigArea) bigComponents++
  }
  return { bigComponents, areas: reversed }
}