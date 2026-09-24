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

/**
 * Per-cell landmass ids for the gazetteer. Sketch-layer blob walk — not a
 * new political engine. 0 is the largest blob; ocean is -1.
 */
export interface LandmassLabels {
  readonly id: Int32Array
  readonly area: number[]
  readonly name: string[]
}

function uniqueLabel(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base} ${n}`)) n++
  const name = `${base} ${n}`
  used.add(name)
  return name
}

function landmassTitle(
  area: number,
  biggest: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
): string {
  const lat = cy / Math.max(1, height)
  const lon = cx / Math.max(1, width)
  const ns = lat < 0.38 ? 'Northern' : lat > 0.62 ? 'Southern' : ''
  const ew = lon < 0.38 ? 'western' : lon > 0.62 ? 'eastern' : ''
  const bearing = [ns, ew].filter(Boolean).join(' ').trim()
  if (area >= Math.max(80, biggest * 0.4)) {
    if (!bearing) return 'The continent'
    const head = bearing.charAt(0).toUpperCase() + bearing.slice(1)
    return `${head} continent`
  }
  if (area < 48) {
    return bearing ? `${bearing.charAt(0).toUpperCase()}${bearing.slice(1)} islet` : 'Islet'
  }
  return bearing ? `${bearing.charAt(0).toUpperCase()}${bearing.slice(1)} island` : 'The island'
}

/** Label every land blob so kingdoms can nest under the continents you drew. */
const labelCache = new WeakMap<Float32Array, { threshold: number; width: number; height: number; labels: LandmassLabels }>()

export function labelLandmasses(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): LandmassLabels {
  const hit = labelCache.get(mask)
  if (hit && hit.threshold === threshold && hit.width === width && hit.height === height) return hit.labels
  const labels = labelLandmassesUncached(mask, width, height, threshold)
  labelCache.set(mask, { threshold, width, height, labels })
  return labels
}

function labelLandmassesUncached(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): LandmassLabels {
  const n = width * height
  const id = new Int32Array(n).fill(-1)
  if (width <= 0 || height <= 0 || mask.length !== n) {
    return { id, area: [], name: [] }
  }

  const visited = new Uint8Array(n)
  const queue = new Int32Array(n)
  const raw: { cells: number[]; area: number; sx: number; sy: number }[] = []

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
      const cells: number[] = []
      let sx = 0
      let sy = 0
      while (head < tail) {
        const i = queue[head++]
        cells.push(i)
        const cx = i % width
        const cy = (i - cx) / width
        sx += cx
        sy += cy
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
      raw.push({ cells, area: cells.length, sx, sy })
    }
  }

  raw.sort((a, b) => b.area - a.area)
  const area: number[] = []
  const name: string[] = []
  const used = new Set<string>()
  const biggest = raw[0]?.area ?? 0
  for (let k = 0; k < raw.length; k++) {
    const blob = raw[k]
    area.push(blob.area)
    const cx = blob.sx / blob.area
    const cy = blob.sy / blob.area
    name.push(uniqueLabel(landmassTitle(blob.area, biggest, cx, cy, width, height), used))
    for (const i of blob.cells) id[i] = k
  }
  return { id, area, name }
}