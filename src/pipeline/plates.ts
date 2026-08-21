/**
 * Pipeline step: plate assignment.
 *
 * Plates are a global Voronoi on land and ocean together. Sutures may cut a
 * continent and continue into the sea — they must not hug the doodle coast.
 * Small islands inherit the surrounding oceanic plate instead of being
 * pizza-sliced. Distances are noise-warped so boundaries wiggle. Velocities
 * come from `seed + 1`.
 *
 * Deterministic: same mask + same seed → identical `plateId` / `plateVx` /
 * `plateVy`. Driven by Mulberry32 from `helpers.ts`; never touches `Math.random`.
 */

import {
  idx,
  wrapX,
  createRng,
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
 * - `plateId[i]` is `1..N` for every cell (land and ocean). Never 0 after
 *   a successful assignment with any land or sea.
 * - `plateVx[i]` / `plateVy[i]` are the drift velocity (cells / Myr) of the
 *   plate cell `i` belongs to.
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
  const plateId = new Int16Array(N)
  const rngCenter = createRng(seed)
  const warpAmp = Math.max(3, width / 28)
  const warpSeed = (seed * 1103515245 + 12345) >>> 0

  const allCells = new Array<number>(N)
  for (let i = 0; i < N; i++) allCells[i] = i

  const want = globalPlateCount(N)
  const centers = pickCenters(allCells, want, rngCenter, width, height, planetRadiusKm)
  const centersByPlate: { x: number; y: number }[] = [{ x: 0, y: 0 }]
  const localIds: number[] = []
  for (let c = 0; c < centers.length; c++) {
    const id = c + 1
    localIds.push(id)
    centersByPlate[id] = centers[c]
  }
  if (centers.length > 0) {
    paintVoronoi(
      plateId,
      allCells,
      centers,
      localIds,
      width,
      height,
      planetRadiusKm,
      warpAmp,
      warpSeed,
    )
  }

  const finalPlateCount = centers.length
  if (finalPlateCount === 0) {
    return {
      plateId,
      plateVx: new Float32Array(N),
      plateVy: new Float32Array(N),
      boundaries: [],
      plates: [],
    }
  }

  cleanupPlateSpeckle(plateId, width, height, 2)
  mergeTinyPlates(plateId, width, height, 5)
  snapSmallIslandsToOnePlate(plateId, mask, width, height, threshold)

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

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const myPlateId = plateId[i]
      if (myPlateId <= 0) continue

      const myVx = plates[myPlateId - 1].vx
      const myVy = plates[myPlateId - 1].vy

      for (const [dx, dy] of D4_OFFSETS) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const ji = idx(width, nx, ny)
        const theirPlateId = plateId[ji]
        if (theirPlateId === myPlateId || theirPlateId <= 0) continue

        // Dedupe by unordered cell pair so (i, ji) and (ji, i) collide.
        const lo = i < ji ? i : ji
        const hi = i < ji ? ji : i
        const key = lo * N + hi
        if (seenPair.has(key)) continue
        seenPair.add(key)

        const theirVx = plates[theirPlateId - 1].vx
        const theirVy = plates[theirPlateId - 1].vy
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

/** Islands this small inherit one plate instead of being pizza-sliced. */
const SMALL_LANDMASS_CELLS = 400

function globalPlateCount(cellCount: number): number {
  if (cellCount < 400) return 4
  if (cellCount < 2500) return 5
  if (cellCount < 50000) return 8
  return 10
}

function paintVoronoi(
  plateId: Int16Array,
  cells: number[],
  centers: { x: number; y: number }[],
  localIds: number[],
  width: number,
  height: number,
  planetRadiusKm: number,
  warpAmp: number,
  warpSeed: number,
): void {
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k]
    const x = i % width
    const y = (i - x) / width
    const wx = x + (valueNoise2(x * 0.08, y * 0.08, warpSeed) - 0.5) * warpAmp
    const wy = Math.max(
      0,
      Math.min(height - 1, y + (valueNoise2(x * 0.08 + 40, y * 0.08, warpSeed + 19) - 0.5) * warpAmp),
    )
    let nearest = localIds[0]
    let nearestDist = Number.POSITIVE_INFINITY
    for (let c = 0; c < centers.length; c++) {
      const d = cellDistanceKm(
        wx,
        wy,
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

function hash01(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + seed
  n = (n ^ (n >>> 13)) >>> 0
  n = Math.imul(n, 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const n00 = hash01(x0, y0, seed)
  const n10 = hash01(x0 + 1, y0, seed)
  const n01 = hash01(x0, y0 + 1, seed)
  const n11 = hash01(x0 + 1, y0 + 1, seed)
  const nx0 = n00 + u * (n10 - n00)
  const nx1 = n01 + u * (n11 - n01)
  return nx0 + v * (nx1 - nx0)
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
 * Majority-filter 1-cell plate speckles. Neighbours are plates, not
 * land vs sea — otherwise sutures hug the doodle coastline.
 */
function cleanupPlateSpeckle(
  plateId: Int16Array,
  width: number,
  height: number,
  passes: number,
): void {
  const n = width * height
  const next = new Int16Array(n)
  for (let pass = 0; pass < passes; pass++) {
    next.set(plateId)
    for (let i = 0; i < n; i++) {
      if (plateId[i] <= 0) continue
      const x = i % width
      const y = (i - x) / width
      const counts = new Map<number, number>()
      let total = 0
      for (const [dx, dy] of D4_OFFSETS) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const j = idx(width, nx, ny)
        if (plateId[j] <= 0) continue
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

function mergeTinyPlates(
  plateId: Int16Array,
  width: number,
  height: number,
  minKeep: number,
): void {
  const n = plateId.length
  const minArea = Math.max(24, Math.floor(n * 0.04))
  for (let round = 0; round < 6; round++) {
    const area = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const id = plateId[i]
      if (id <= 0) continue
      area.set(id, (area.get(id) ?? 0) + 1)
    }
    if (area.size <= minKeep) return
    let victim = 0
    let victimN = Number.POSITIVE_INFINITY
    for (const [id, c] of area) {
      if (c < victimN) {
        victimN = c
        victim = id
      }
    }
    if (victim <= 0 || victimN >= minArea) return
    for (let i = 0; i < n; i++) {
      if (plateId[i] !== victim) continue
      const x = i % width
      const y = (i - x) / width
      const counts = new Map<number, number>()
      for (const [dx, dy] of D4_OFFSETS) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const q = plateId[idx(width, nx, ny)]
        if (q <= 0 || q === victim) continue
        counts.set(q, (counts.get(q) ?? 0) + 1)
      }
      let best = 0
      let bestN = -1
      for (const [id, c] of counts) {
        if (c > bestN) {
          bestN = c
          best = id
        }
      }
      if (best > 0) plateId[i] = best
    }
  }
}

function snapSmallIslandsToOnePlate(
  plateId: Int16Array,
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
): void {
  for (const cells of collectLandComponents(mask, width, height, threshold)) {
    if (cells.length === 0 || cells.length >= SMALL_LANDMASS_CELLS) continue
    const oceanVotes = new Map<number, number>()
    const landVotes = new Map<number, number>()
    for (const i of cells) {
      const id = plateId[i]
      if (id > 0) landVotes.set(id, (landVotes.get(id) ?? 0) + 1)
      const x = i % width
      const y = (i - x) / width
      for (const [dx, dy] of D4_OFFSETS) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const j = idx(width, nx, ny)
        if (mask[j] >= threshold) continue
        const q = plateId[j]
        if (q <= 0) continue
        oceanVotes.set(q, (oceanVotes.get(q) ?? 0) + 1)
      }
    }
    const votes = oceanVotes.size > 0 ? oceanVotes : landVotes
    let best = 0
    let bestN = -1
    for (const [id, c] of votes) {
      if (c > bestN) {
        bestN = c
        best = id
      }
    }
    if (best <= 0) continue
    for (const i of cells) plateId[i] = best
  }
}
