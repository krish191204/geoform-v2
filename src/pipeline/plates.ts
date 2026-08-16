/**
 * Pipeline step: plate assignment.
 *
 * Given a soft land mask and planet parameters, partitions the map into tectonic
 * plates. Land cells get plate IDs in `1..N` via farthest-point Voronoi on the
 * planet sphere; ocean cells share a residual ocean plate (`id = 0`). Each
 * plate gets a random drift velocity seeded from `seed + 1`. Boundaries are
 * classified by relative motion and lithology.
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

  // -----------------------------------------------------------------
  // 1. Plate count from land area.
  // -----------------------------------------------------------------
  let landArea = 0
  for (let i = 0; i < N; i++) {
    if (mask[i] >= threshold) landArea++
  }

  let plateCount = plateCountForArea(landArea)
  if (landArea < plateCount) {
    // Not enough land cells to host the requested plate count; clamp.
    plateCount = Math.max(2, Math.floor(landArea / 100))
  }

  // -----------------------------------------------------------------
  // 2. Plate centers: 4× plateCount random candidates filtered to
  //    in-mask, then farthest-point sampling to spread them out.
  // -----------------------------------------------------------------
  const rngCenter = createRng(seed)
  const seenPos = new Set<number>()
  const candidates: { x: number; y: number }[] = []

  for (let k = 0; k < 4 * plateCount; k++) {
    const cx = Math.floor(rngCenter() * width)
    const cy = Math.floor(rngCenter() * height)
    const ci = idx(width, cx, cy)
    if (seenPos.has(ci)) continue
    seenPos.add(ci)
    if (mask[ci] >= threshold) {
      candidates.push({ x: cx, y: cy })
    }
  }

  // Fallback: if random sampling yielded fewer than `plateCount` in-mask
  // candidates (very small landmasses), sweep the mask for more.
  if (candidates.length < plateCount) {
    for (let y = 0; y < height && candidates.length < plateCount; y++) {
      for (let x = 0; x < width && candidates.length < plateCount; x++) {
        const ci = idx(width, x, y)
        if (mask[ci] >= threshold && !seenPos.has(ci)) {
          seenPos.add(ci)
          candidates.push({ x, y })
        }
      }
    }
  }

  // Farthest-point sampling on the in-mask candidates.
  const centers: { x: number; y: number }[] = []
  if (candidates.length > 0) {
    const first = Math.min(
      candidates.length - 1,
      Math.floor(rngCenter() * candidates.length),
    )
    centers.push(candidates[first])

    const minDist = new Float64Array(candidates.length)
    for (let j = 0; j < candidates.length; j++) {
      if (j === first) {
        minDist[j] = Number.POSITIVE_INFINITY
        continue
      }
      minDist[j] = cellDistanceKm(
        candidates[first].x,
        candidates[first].y,
        candidates[j].x,
        candidates[j].y,
        width,
        height,
        planetRadiusKm,
      )
    }

    while (centers.length < plateCount && centers.length < candidates.length) {
      let bestJ = -1
      let bestDist = -1
      for (let j = 0; j < candidates.length; j++) {
        if (!isFinite(minDist[j])) continue
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
        if (!isFinite(minDist[j])) continue
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
  }

  // Defensive bail-out: no centers means no land cells in mask.
  if (centers.length === 0) {
    return {
      plateId: new Int16Array(N),
      plateVx: new Float32Array(N),
      plateVy: new Float32Array(N),
      boundaries: [],
      plates: [],
    }
  }
  centers.length = Math.min(centers.length, plateCount)
  const finalPlateCount = centers.length

  // -----------------------------------------------------------------
  // 3. Voronoi-assign every land cell to the nearest plate center.
  // -----------------------------------------------------------------
  const plateId = new Int16Array(N) // 0 = ocean
  const centroidX = new Float64Array(finalPlateCount + 1)
  const centroidY = new Float64Array(finalPlateCount + 1)
  const plateArea = new Int32Array(finalPlateCount + 1)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      if (mask[i] < threshold) continue // ocean stays 0
      let nearest = 1
      let nearestDist = Number.POSITIVE_INFINITY
      for (let p = 0; p < finalPlateCount; p++) {
        const d = cellDistanceKm(
          x,
          y,
          centers[p].x,
          centers[p].y,
          width,
          height,
          planetRadiusKm,
        )
        if (d < nearestDist) {
          nearestDist = d
          nearest = p + 1 // 1-indexed plate ids
        }
      }
      plateId[i] = nearest
      centroidX[nearest] += x
      centroidY[nearest] += y
      plateArea[nearest]++
    }
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
    plates.push({
      id: p,
      cx: plateArea[p] > 0 ? centroidX[p] / plateArea[p] : centers[p - 1].x,
      cy: plateArea[p] > 0 ? centroidY[p] / plateArea[p] : centers[p - 1].y,
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
