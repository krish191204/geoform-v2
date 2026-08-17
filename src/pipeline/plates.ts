/**
 * Pipeline step: plate assignment.
 *
 * Given a soft land mask and planet parameters, partitions the map into tectonic
 * plates. Each landmass is Voronoi-split on its own (small islands stay one
 * plate). Ocean cells share a residual ocean plate (`id = 0`). Each plate gets
 * a random drift velocity seeded from `seed + 1`. Boundaries are classified
 * by relative motion and lithology.
 *
 * Deterministic: same mask + same seed → identical `plateId` / `plateVx` /
 * `plateVy`. Driven by Mulberry32 from `helpers.ts`; never touches `Math.random`.
 */

import {
  idx,
  wrapX,
  createRng,
  plateCountForArea,
  cellDistanceKm,
  D4_OFFSETS,
} from './helpers'
import type { Plate, Boundary, BoundaryClass } from './types'

// ---------------------------------------------------------------------------
// PlateAssignment — exported shape
// ---------------------------------------------------------------------------

/**
 * Result of running Voronoi plate assignment against a soft mask.
 *
 * - `plateId[i]` is `0` for ocean (residual ocean plate) or `1..N` for land.
 * - `plateVx[i]` / `plateVy[i]` are the drift velocity (cells / Myr) of the
 *   plate cell `i` belongs to; zeroed for ocean cells.
 * - `boundaries` is dedup'd by unordered `(i, ji)` cell pair.
 */
export interface PlateAssignment {
  plateId: Int16Array
  plateVx: Float32Array
  plateVy: Float32Array
  boundaries: Boundary[]
  plates: Plate[]
}

/**
 * Voronoi-partition the land mask into plates; assign velocities; classify
 * boundaries.
 *
 * `planetRadiusKm` drives the great-circle distance used to score Voronoi
 * cells. `obliquityDeg` is accepted for API symmetry with downstream climate
 * modules but does not affect plate placement.
 */
export function assignPlatesUnderMask(
  mask: Float32Array,
  width: number,
  height: number,
  seed: number,
  planetRadiusKm: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _obliquityDeg: number,
  threshold: number = 0.5,
): PlateAssignment {
  const N = width * height
  const plateId = new Int16Array(N) // 0 = ocean
  const rngCenter = createRng(seed)
  const components = collectLandComponents(mask, width, height, threshold)

  // Plate ids are 1-indexed and unique across the whole map. Each
  // landmass is partitioned on its own so a global Voronoi does not
  // stripe every island with the same geodesic cuts.
  let nextPlateId = 1
  const centersByPlate: { x: number; y: number }[] = [ { x: 0, y: 0 } ]

  for (const cells of components) {
    const want = platesForComponent(cells.length)
    const centers = pickCenters(
      cells,
      want,
      rngCenter,
      width,
      height,
      planetRadiusKm,
    )
    if (centers.length === 0) continue
    const localIds: number[] = []
    for (let c = 0; c < centers.length; c++) {
      localIds.push(nextPlateId)
      centersByPlate[nextPlateId] = centers[c]
      nextPlateId++
    }
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k]
      const x = i % width
      const y = (i - x) / width
      let nearest = localIds[0]
      let nearestDist = Number.POSITIVE_INFINITY
      for (let c = 0; c < centers.length; c++) {
        const d = cellDistanceKm(
          x,
          y,
          centers[c].x,
          centers[c].y,
          width,
          height,
          planetRadiusKm,
        )
        if (d < nearestDist) {
          nearestDist = d
          nearest = localIds[c]
        }
      }
      plateId[i] = nearest
    }
  }

  const finalPlateCount = nextPlateId - 1
  if (finalPlateCount === 0) {
    return {
      plateId,
      plateVx: new Float32Array(N),
      plateVy: new Float32Array(N),
      boundaries: [],
      plates: [],
    }
  }

  cleanupPlateSpeckle(plateId, mask, width, height, threshold, 2)

  const centroidX = new Float64Array(finalPlateCount + 1)
  const centroidY = new Float64Array(finalPlateCount + 1)
  const plateArea = new Int32Array(finalPlateCount + 1)
  for (let i = 0; i < N; i++) {
    const p = plateId[i]
    if (p <= 0) continue
    const x = i % width
    const y = (i - x) / width
    centroidX[p] += x
    centroidY[p] += y
    plateArea[p]++
  }

  // -----------------------------------------------------------------
  // 4. Velocity assignment (driven by `createRng(seed + 1)`).
  // -----------------------------------------------------------------
  const rngVel = createRng(seed + 1)
  const plates: Plate[] = []
  for (let p = 1; p <= finalPlateCount; p++) {
    const speed = 0.3 + 0.7 * rngVel()
    const dir = rngVel() * 2 * Math.PI
    const vx = speed * Math.cos(dir)
    const vy = speed * Math.sin(dir)
    const fallback = centersByPlate[p] ?? { x: 0, y: 0 }
    plates.push({
      id: p,
      cx: plateArea[p] > 0 ? centroidX[p] / plateArea[p] : fallback.x,
      cy: plateArea[p] > 0 ? centroidY[p] / plateArea[p] : fallback.y,
      vx,
      vy,
      area: plateArea[p],
    })
  }

  // -----------------------------------------------------------------
  // 5. Per-cell velocity arrays (looked up from plate metadata).
  // -----------------------------------------------------------------
  const plateVx = new Float32Array(N)
  const plateVy = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const p = plateId[i]
    if (p >= 1) {
      plateVx[i] = plates[p - 1].vx
      plateVy[i] = plates[p - 1].vy
    }
  }

  // -----------------------------------------------------------------
  // 6. Boundary classification with deduplication.
  // -----------------------------------------------------------------
  const boundaries: Boundary[] = []
  const seenPair = new Set<number>()
  const OCEAN_VX = 0
  const OCEAN_VY = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const myPlateId = plateId[i]
      if (myPlateId === 0) continue // skip ocean for performance

      const myVx = plates[myPlateId - 1].vx
      const myVy = plates[myPlateId - 1].vy

      for (const [dx, dy] of D4_OFFSETS) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const ji = idx(width, nx, ny)
        const theirPlateId = plateId[ji]
        if (theirPlateId === myPlateId) continue

        // Dedupe by unordered cell pair so (i, ji) and (ji, i) collide.
        const lo = i < ji ? i : ji
        const hi = i < ji ? ji : i
        const key = lo * N + hi
        if (seenPair.has(key)) continue
        seenPair.add(key)

        // Relative velocity: their plate minus mine, in cells/Myr.
        const theirVx =
          theirPlateId > 0 ? plates[theirPlateId - 1].vx : OCEAN_VX
        const theirVy =
          theirPlateId > 0 ? plates[theirPlateId - 1].vy : OCEAN_VY
        const relVx = theirVx - myVx
        const relVy = theirVy - myVy

        // Unit normal from me (i) toward the neighbor (ji), with longitude wrap.
        let ndx = nx - x
        if (ndx > width / 2) ndx -= width
        if (ndx < -width / 2) ndx += width
        const ndy = ny - y
        const norm = Math.sqrt(ndx * ndx + ndy * ndy)
        const nxHat = norm > 0 ? ndx / norm : 0
        const nyHat = norm > 0 ? ndy / norm : 0

        const dot = relVx * nxHat + relVy * nyHat
        const perpX = relVx - dot * nxHat
        const perpY = relVy - dot * nyHat
        const perp = Math.sqrt(perpX * perpX + perpY * perpY)

        const iLand = mask[i] >= threshold
        const jLand = mask[ji] >= threshold

        let cls: BoundaryClass = 'passive'
        if (iLand && jLand) {
          if (dot < -0.05) cls = 'convergent-cc'
          else if (dot > 0.05) cls = 'divergent'
          else if (perp > 0.1) cls = 'transform'
        } else if (iLand !== jLand) {
          if (dot < -0.05) cls = 'convergent-oc'
        } else {
          // Ocean-ocean (only reachable if multiple ocean plates exist).
          if (dot > 0.05) cls = 'divergent'
          else if (perp > 0.1) cls = 'transform'
        }

        boundaries.push({
          i,
          ji,
          plateId: myPlateId,
          otherPlateId: theirPlateId,
          class: cls,
          relativeVx: relVx,
          relativeVy: relVy,
        })
      }
    }
  }

  return {
    plateId,
    plateVx,
    plateVy,
    boundaries,
    plates,
  }
}

/** Islands this small stay one plate instead of being pizza-sliced. */
const SMALL_LANDMASS_CELLS = 400

function platesForComponent(area: number): number {
  if (area < SMALL_LANDMASS_CELLS) return 1
  const byArea = plateCountForArea(area)
  const bySize = Math.max(2, Math.floor(area / 200))
  return Math.min(byArea, bySize)
}

function collectLandComponents(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): number[][] {
  const n = width * height
  const visited = new Uint8Array(n)
  const queue = new Int32Array(n)
  const out: number[][] = []

  for (let seed = 0; seed < n; seed++) {
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
      const x = i % width
      const y = (i - x) / width
      const nxLeft = x === 0 ? width - 1 : x - 1
      const nxRight = x === width - 1 ? 0 : x + 1
      const row = y * width
      const next = [row + nxLeft, row + nxRight]
      if (y > 0) next.push(row - width + x)
      if (y < height - 1) next.push(row + width + x)
      for (let k = 0; k < next.length; k++) {
        const j = next[k]
        if (visited[j] !== 0) continue
        if (mask[j] < threshold) continue
        visited[j] = 1
        queue[tail++] = j
      }
    }
    out.push(members)
  }
  return out
}

function pickCenters(
  cells: number[],
  want: number,
  rng: () => number,
  width: number,
  height: number,
  planetRadiusKm: number,
): { x: number; y: number }[] {
  if (cells.length === 0 || want <= 0) return []
  const count = Math.min(want, cells.length)
  if (count === 1) {
    const i = cells[Math.floor(rng() * cells.length)]
    return [{ x: i % width, y: Math.floor(i / width) }]
  }

  const candidateWant = Math.min(cells.length, Math.max(count * 8, 24))
  const candidates: { x: number; y: number }[] = []
  const seen = new Set<number>()
  let guard = 0
  while (candidates.length < candidateWant && guard < candidateWant * 12) {
    guard++
    const i = cells[Math.floor(rng() * cells.length)]
    if (seen.has(i)) continue
    seen.add(i)
    candidates.push({ x: i % width, y: Math.floor(i / width) })
  }
  for (let k = 0; k < cells.length && candidates.length < candidateWant; k++) {
    const i = cells[k]
    if (seen.has(i)) continue
    seen.add(i)
    candidates.push({ x: i % width, y: Math.floor(i / width) })
  }
  if (candidates.length === 0) return []

  const first = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))
  const centers = [candidates[first]]
  const minDist = new Float64Array(candidates.length)
  for (let j = 0; j < candidates.length; j++) {
    minDist[j] =
      j === first
        ? Number.POSITIVE_INFINITY
        : cellDistanceKm(
            candidates[first].x,
            candidates[first].y,
            candidates[j].x,
            candidates[j].y,
            width,
            height,
            planetRadiusKm,
          )
  }

  while (centers.length < count && centers.length < candidates.length) {
    let bestJ = -1
    let bestDist = -1
    for (let j = 0; j < candidates.length; j++) {
      if (!Number.isFinite(minDist[j])) continue
      if (minDist[j] > bestDist) {
        bestDist = minDist[j]
        bestJ = j
      }
    }
    if (bestJ === -1) break
    const chosen = candidates[bestJ]
    centers.push(chosen)
    minDist[bestJ] = Number.POSITIVE_INFINITY
    for (let j = 0; j < candidates.length; j++) {
      if (!Number.isFinite(minDist[j])) continue
      const d = cellDistanceKm(
        chosen.x,
        chosen.y,
        candidates[j].x,
        candidates[j].y,
        width,
        height,
        planetRadiusKm,
      )
      if (d < minDist[j]) minDist[j] = d
    }
  }
  return centers
}

/**
 * Majority-filter 1-cell plate speckles so a continent is a few
 * contiguous plates, not confetti.
 */
function cleanupPlateSpeckle(
  plateId: Int16Array,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  passes: number,
): void {
  const n = width * height
  const next = new Int16Array(n)
  for (let pass = 0; pass < passes; pass++) {
    next.set(plateId)
    for (let i = 0; i < n; i++) {
      if (mask[i] < threshold || plateId[i] <= 0) continue
      const x = i % width
      const y = (i - x) / width
      const counts = new Map<number, number>()
      let total = 0
      for (const [dx, dy] of D4_OFFSETS) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const j = idx(width, nx, ny)
        if (mask[j] < threshold || plateId[j] <= 0) continue
        counts.set(plateId[j], (counts.get(plateId[j]) ?? 0) + 1)
        total++
      }
      if (total < 2) continue
      let best = plateId[i]
      let bestN = -1
      for (const [id, c] of counts) {
        if (c > bestN) {
          bestN = c
          best = id
        }
      }
      if (bestN >= 3 && best !== plateId[i]) next[i] = best
    }
    plateId.set(next)
  }
}
