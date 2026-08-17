/**
 * Module entry for the Critique stage.
 *
 * `critiqueMask` runs pre-Make-sense over the soft mask alone.
 * `critiqueWorld` runs post-Make-sense over the derived World; it
 * automatically pulls in `checkMaskLock` if a prior mask has been set
 * via `setPriorMask()` (or by an earlier `critiqueMask` call).
 *
 * No flattery. No alternatives. The output is diagnostic and the user
 * decides what to do with it.
 */
import type { World, WorldMeta, Issue } from '../world/types'
import { idx } from '../world/types'
import { countBigComponents, analyseComponents } from '../sketch/countBigComponents'
import {
  SEVERITY_WEIGHTS,
  scoreFromIssues,
  sortIssuesBySeverity,
  checkIceDesertDualism,
  checkRainShadow,
  checkContinentality,
  checkFluxOnMaxima,
  checkMaskLock,
} from './analyzeWorld'

// ---------------------------------------------------------------------------
// 1. Public types.
// ---------------------------------------------------------------------------

/**
 * One score and its issues.
 *
 * `pre = true` only on results produced by `critiqueMask`. `critiqueWorld`
 * always emits `pre = false`.
 */
export interface CritiqueResult {
  /** 0..100. 100 means zero issues were found. Drops of 25/10/2 per critical/major/minor. */
  score: number
  /** Sorted with critical first, then major, then minor. */
  issues: Issue[]
  /** True if this result was computed pre-Make-sense (mask only). */
  pre: boolean
}

// Re-exported so callers don't need a second import path.
export type { Issue }
export { SEVERITY_WEIGHTS, scoreFromIssues, sortIssuesBySeverity }

// ---------------------------------------------------------------------------
// 2. Pre-Make-sense helpers (mask only).
// ---------------------------------------------------------------------------

/** Fraction of cells with `mask >= threshold`. */
function landFraction(mask: Float32Array, _w: number, _h: number, threshold: number): number {
  let land = 0
  const total = mask.length
  if (total === 0) return 0
  for (let i = 0; i < total; i++) {
    if (mask[i] >= threshold) land++
  }
  return land / total
}

/** Fraction of cells in `y < 4` that are at or above threshold. */
function polarLaneFraction(mask: Float32Array, w: number, h: number, threshold: number): number {
  let land = 0
  let total = 0
  const limit = Math.min(4, h)
  for (let y = 0; y < limit; y++) {
    for (let x = 0; x < w; x++) {
      total++
      if (mask[idx(w, x, y)] >= threshold) land++
    }
  }
  return total === 0 ? 0 : land / total
}

/** Hard cap on per-component cell sample for shape diagnostics. */
const MAX_DETAIL_CELLS = 256

/** Shape data for the single biggest connected component (or null). */
interface BiggestComponent {
  area: number
  bbox: { x1: number; y1: number; x2: number; y2: number }
  cells: { x: number; y: number }[]
  /** 4-connected land–ocean edges on this component (isoperimetric). */
  perimeter: number
}

/**
 * BFS over the mask and return the biggest component (by area). Tracks
 * the bounding box and the first `MAX_DETAIL_CELLS` cells so callers can
 * run shape heuristics (rectangle-as-continent, line-as-continent).
 */
function analyseBiggestComponent(
  mask: Float32Array,
  w: number,
  h: number,
  threshold: number,
): BiggestComponent | null {
  if (w <= 0 || h <= 0 || mask.length !== w * h) return null
  const visited = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  let best: BiggestComponent | null = null
  for (let y = 0; y < h; y++) {
    const rowBase = y * w
    for (let x = 0; x < w; x++) {
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
      let area = 0
      let perimeter = 0
      let x1 = x
      let y1 = y
      let x2 = x
      let y2 = y
      const cells: { x: number; y: number }[] = []
      while (head < tail) {
        const i = queue[head++]
        area++
        const cx = i % w
        const cy = (i - cx) / w
        if (cx < x1) x1 = cx
        if (cx > x2) x2 = cx
        if (cy < y1) y1 = cy
        if (cy > y2) y2 = cy
        if (cells.length < MAX_DETAIL_CELLS) cells.push({ x: cx, y: cy })
        const neighbours = [
          [cx === 0 ? w - 1 : cx - 1, cy],
          [cx === w - 1 ? 0 : cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ] as const
        for (const [nx, ny] of neighbours) {
          if (ny < 0 || ny >= h) {
            perimeter++
            continue
          }
          const j = ny * w + nx
          if (mask[j] < threshold) {
            perimeter++
            continue
          }
          if (visited[j] !== 0) continue
          visited[j] = 1
          queue[tail++] = j
        }
      }
      if (best === null || area > best.area) {
        best = { area, bbox: { x1, y1, x2, y2 }, cells, perimeter }
      }
    }
  }
  return best
}

/**
 * Ocean cells that cannot reach a pole row through ocean. Those are
 * lakes / paint holes, not seas.
 */
function inlandWater(
  mask: Float32Array,
  w: number,
  h: number,
  threshold: number,
): { cells: number; samples: { x: number; y: number }[] } {
  const isOcean = (i: number) => mask[i] < threshold
  const seen = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  let head = 0
  let tail = 0
  const tryEnq = (x: number, y: number) => {
    if (y < 0 || y >= h) return
    const i = y * w + x
    if (seen[i] || !isOcean(i)) return
    seen[i] = 1
    queue[tail++] = i
  }
  for (let x = 0; x < w; x++) {
    tryEnq(x, 0)
    tryEnq(x, h - 1)
  }
  while (head < tail) {
    const i = queue[head++]
    const cx = i % w
    const cy = (i - cx) / w
    tryEnq(cx === 0 ? w - 1 : cx - 1, cy)
    tryEnq(cx === w - 1 ? 0 : cx + 1, cy)
    tryEnq(cx, cy - 1)
    tryEnq(cx, cy + 1)
  }
  let cells = 0
  const samples: { x: number; y: number }[] = []
  for (let i = 0; i < mask.length; i++) {
    if (!isOcean(i) || seen[i]) continue
    cells++
    if (samples.length < 20) samples.push({ x: i % w, y: Math.floor(i / w) })
  }
  return { cells, samples }
}

/**
 * Stair-step coasts: land cells on the shore whose land neighbours form
 * an L (pixel stairs) rather than a shoreline.
 */
function jaggyCoast(
  mask: Float32Array,
  w: number,
  h: number,
  threshold: number,
): { coast: number; jaggies: number; samples: { x: number; y: number }[] } {
  let coast = 0
  let jaggies = 0
  const samples: { x: number; y: number }[] = []
  const land = (x: number, y: number) => {
    if (y < 0 || y >= h) return false
    const xx = ((x % w) + w) % w
    return mask[y * w + xx] >= threshold
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!land(x, y)) continue
      const n = land(x, y - 1)
      const s = land(x, y + 1)
      const e = land(x + 1, y)
      const ww = land(x - 1, y)
      const landN = (n ? 1 : 0) + (s ? 1 : 0) + (e ? 1 : 0) + (ww ? 1 : 0)
      if (landN === 4) continue
      coast++
      const corner = landN === 2 && ((n && e) || (e && s) || (s && ww) || (ww && n))
      const spike = landN <= 1
      if (corner || spike) {
        jaggies++
        if (samples.length < 20) samples.push({ x, y })
      }
    }
  }
  return { coast, jaggies, samples }
}

function sampleLand(mask: Float32Array, w: number, threshold: number, n: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < mask.length && out.length < n; i++) {
    if (mask[i] >= threshold) out.push({ x: i % w, y: Math.floor(i / w) })
  }
  return out
}
function applyScoreFloor(score: number, issues: Issue[]): number {
  let criticalCount = 0
  for (const i of issues) if (i.severity === 'critical') criticalCount++
  let out = score
  if (criticalCount >= 2) out = Math.min(out, 50)
  if (issues.length >= 5) out = Math.min(out, 50)
  return out
}

// ---------------------------------------------------------------------------
// 3. Pre-Make-sense critic: critiqueMask.
// ---------------------------------------------------------------------------

/**
 * Pre-Make-sense critique. Reads the soft mask only. Cheap, deterministic,
 * safe to call on every brush dab — it short-circuits on size failures and
 * returns an empty result if the mask is empty.
 */
export function critiqueMask(
  mask: Float32Array,
  meta: WorldMeta,
  threshold: number,
): CritiqueResult {
  const { width: w, height: h } = meta
  const issues: Issue[] = []
  if (mask.length !== w * h || w === 0 || h === 0) {
    return { score: 100, issues: [], pre: true }
  }

  // 3.1 — land share
  const landPct = landFraction(mask, w, h, threshold) * 100
  if (landPct < 5) {
    // Build a small evidence sample: the first 20 land cells we find.
    const landCells: { x: number; y: number }[] = []
    for (let i = 0; i < mask.length && landCells.length < 20; i++) {
      if (mask[i] >= threshold) {
        landCells.push({ x: i % w, y: Math.floor(i / w) })
      }
    }
    issues.push({
      id: 'too-little-land',
      severity: 'critical',
      title: 'Map is mostly ocean',
      critique: `Only ${landPct.toFixed(1)}% of cells are land. Real ` +
        `continents cover 30-40% of Earth's surface.`,
      fix: 'Paint more land. Even a single continent adds orogeny + climate + rivers.',
      evidence: landCells,
    })
  }
  if (landPct > 95) {
    // Build a small evidence sample: the first 20 sea cells we find.
    const seaCells: { x: number; y: number }[] = []
    for (let i = 0; i < mask.length && seaCells.length < 20; i++) {
      if (mask[i] <= threshold) {
        seaCells.push({ x: i % w, y: Math.floor(i / w) })
      }
    }
    issues.push({
      id: 'too-much-land',
      severity: 'critical',
      title: 'Map is mostly land',
      critique: `${landPct.toFixed(1)}% of cells are land. Almost no ocean.`,
      fix: 'Erase sea in some regions. Continents need coastlines.',
      evidence: seaCells,
    })
  }

  // 3.2 — speckles: too many small islands
  const bigCount = countBigComponents(mask, w, h, threshold, 100)
  if (bigCount > 8) {
    // Evidence: sample a few speckle-cell coordinates (use the mask stats).
    const evidence = sampleSpeckleEvidence(mask, w, h, threshold)
    issues.push({
      id: 'too-many-speckles',
      severity: 'major',
      title: 'Too many small islands',
      critique: `Mask has ${bigCount} separate "big" land masses ` +
        `(each at least 100 cells). That is archipelago, not continents.`,
      fix: 'Merge them with bigger brushes or pick archipelago as the world type.',
      evidence,
    })
  }

  // 3.3 — polar strip suspiciousness
  const polarPct = polarLaneFraction(mask, w, h, threshold) * 100
  if (polarPct > 80) {
    issues.push({
      id: 'polar-strip',
      severity: 'major',
      title: 'Polar strip is suspicious',
      critique: `Rows 0..3 are ${polarPct.toFixed(0)}% land. If both ` +
        `poles are ringed with land, no temperate band can form.`,
      fix: 'Erase some polar land so cold cells have ocean neighbours to moderate.',
      evidence: [
        { x: Math.floor(w / 4), y: 0 },
        { x: Math.floor(w / 2), y: 1 },
        { x: Math.floor((3 * w) / 4), y: 2 },
      ],
    })
  }

  // 3.4 — shape-based checks. Real continents are fractal; rectangular or
  // line-shaped land masses are user artefacts (or a sign the brush was
  // dragged in a straight line across the polar lane).
  const biggest = analyseBiggestComponent(mask, w, h, threshold)
  if (biggest && biggest.area > 600) {
    const bw = biggest.bbox.x2 - biggest.bbox.x1 + 1
    const bh = biggest.bbox.y2 - biggest.bbox.y1 + 1
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
    if (aspect > 3) {
      issues.push({
        id: 'rectangle-continent',
        severity: 'major',
        title: 'Continental shape is too rectangular',
        critique:
          `The largest landmass has an aspect ratio of ${aspect.toFixed(1)}. ` +
          `Real continents have fractal coastlines.`,
        fix: 'Add peninsulas, islands, or reshape the contour. Mountains will appear automatically after Make sense.',
        evidence: biggest.cells.slice(0, 20),
      })
    }
  }

  if (biggest && biggest.area > 100) {
    const bw = biggest.bbox.x2 - biggest.bbox.x1 + 1
    const bh = biggest.bbox.y2 - biggest.bbox.y1 + 1
    if (Math.min(bw, bh) <= 2 && Math.max(bw, bh) >= 8) {
      issues.push({
        id: 'line-continent',
        severity: 'minor',
        title: 'Land is a thin strip',
        critique:
          `The largest landmass is ${Math.min(bw, bh)} cells wide and ` +
          `${Math.max(bw, bh)} cells long.`,
        fix: 'Add width or break the strip into multiple landmasses.',
        evidence: biggest.cells.slice(0, 10),
      })
    }
  }

  // 3.5 — stamp vs continent: a filled box is a brush rectangle, not a plate.
  if (biggest && biggest.area > 200) {
    const bw = biggest.bbox.x2 - biggest.bbox.x1 + 1
    const bh = biggest.bbox.y2 - biggest.bbox.y1 + 1
    const box = bw * bh
    const fill = box > 0 ? biggest.area / box : 0
    if (fill > 0.8) {
      issues.push({
        id: 'box-continent',
        severity: 'major',
        title: 'Land is a stamped box',
        critique:
          `${Math.round(fill * 100)}% of the largest mass’s bounding box is filled. ` +
          `Plates do not punch a rectangle out of the ocean.`,
        fix: 'Break the walls with gulfs, peninsulas, and islands.',
        evidence: biggest.cells.slice(0, 20),
      })
    }
    const compact =
      biggest.perimeter > 0
        ? (4 * Math.PI * biggest.area) / (biggest.perimeter * biggest.perimeter)
        : 1
    if (compact < 0.22) {
      issues.push({
        id: 'scribble-coast',
        severity: 'major',
        title: 'Coast is a scribble',
        critique:
          `Largest landmass compactness is ${compact.toFixed(2)} (circle = 1). ` +
          `That is a doodle outline, not a shoreline.`,
        fix: 'Paint broader masses. Make sense cannot invent a continent from spray.',
        evidence: biggest.cells.slice(0, 20),
      })
    }
  }

  // 3.6 — paint holes: water that never reaches a pole is a lake from the brush.
  const holes = inlandWater(mask, w, h, threshold)
  const landCells = Math.round((landPct / 100) * mask.length)
  if (holes.cells >= 8 && landCells > 0) {
    issues.push({
      id: 'paint-holes',
      severity: 'major',
      title: 'Continents are full of holes',
      critique:
        `${holes.cells} ocean cells are trapped inland and never reach a pole. ` +
        `Those are brush gaps, not seas.`,
      fix: 'Fill the lakes or open them to the ocean with a strait.',
      evidence: holes.samples,
    })
  }

  // 3.7 — pixel stairs
  const jag = jaggyCoast(mask, w, h, threshold)
  if (jag.coast >= 40 && jag.jaggies / jag.coast > 0.35) {
    issues.push({
      id: 'pixel-stairs',
      severity: 'major',
      title: 'Coast is pixel stairs',
      critique:
        `${Math.round((jag.jaggies / jag.coast) * 100)}% of shoreline cells are ` +
        `L-corners or 1-cell spikes. That is the brush grid, not geography.`,
      fix: 'Use a larger brush and pull the coast into smoother capes.',
      evidence: jag.samples,
    })
  }

  // 3.8 — speckle share of all land (tiny scraps, not the 8-mass rule)
  const parts = analyseComponents(mask, w, h, threshold, 100)
  let landArea = 0
  let speckleArea = 0
  for (let i = 0; i < parts.areas.length; i++) {
    landArea += parts.areas[i]
    if (parts.areas[i] < 100) speckleArea += parts.areas[i]
  }
  if (landArea > 200 && speckleArea / landArea > 0.12) {
    issues.push({
      id: 'speckle-share',
      severity: 'major',
      title: 'Green pimples, not continents',
      critique:
        `${Math.round((speckleArea / landArea) * 100)}% of the land is scraps under 100 cells. ` +
        `That is spray on the ocean.`,
      fix: 'Merge the specks into a few large masses, or own an island world after Make sense.',
      evidence: sampleSpeckleEvidence(mask, w, h, threshold),
    })
  }

  // 3.9 — land/water is not a planet. 100% here would be flattery.
  if (landPct >= 5 && landPct <= 95) {
    issues.push({
      id: 'not-a-planet-yet',
      severity: 'major',
      title: 'This is a doodle, not a planet',
      critique:
        `${landPct.toFixed(0)}% land and ${bigCount} large masses. That can look Earth-like ` +
        `as a silhouette and still be geographically empty — no height, climate, or rivers exist yet.`,
      fix: 'Read the issues above, then run Make sense. The score after that is the real one.',
      evidence: sampleLand(mask, w, threshold, 12),
    })
  }

  // Remember for checkMaskLock.
  setPriorMask(mask, meta)

  const sorted = sortIssuesBySeverity(issues)
  const baseScore = scoreFromIssues(sorted)
  return {
    score: applyScoreFloor(baseScore, sorted),
    issues: sorted,
    pre: true,
  }
}

/**
 * Internal: pick a few "speckle" cell coordinates by sampling the
 * components at the back of the size distribution. Stable given the
 * same mask — we scan row-major and rely on that order.
 */
function sampleSpeckleEvidence(
  mask: Float32Array,
  w: number,
  h: number,
  threshold: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  const visited = new Uint8Array(mask.length)
  // Run a BFS but only collect cells from components that finish "small"
  // (between 100 and 1000 cells). Take the centroid of the first 6 such
  // components.
  const queue = new Int32Array(mask.length)
  const sumX = new Int32Array(w * h)
  const sumY = new Int32Array(w * h)
  const compCount = new Int32Array(w * h)
  for (let y = 0; y < h && out.length < 6; y++) {
    for (let x = 0; x < w && out.length < 6; x++) {
      const seed = idx(w, x, y)
      if (visited[seed]) continue
      visited[seed] = 1
      if (mask[seed] < threshold) continue
      let head = 0
      let tail = 0
      queue[tail++] = seed
      let area = 0
      let sx = 0
      let sy = 0
      while (head < tail) {
        const k = queue[head++]
        const kx = k % w
        const ky = (k - kx) / w
        area++
        sx += kx
        sy += ky
        // 4-neighbours.
        const n4 = [
          [kx === 0 ? w - 1 : kx - 1, ky],
          [kx === w - 1 ? 0 : kx + 1, ky],
          [kx, ky - 1],
          [kx, ky + 1],
        ] as const
        for (const [nx, ny] of n4) {
          if (ny < 0 || ny >= h) continue
          const j = ny * w + nx
          if (visited[j]) continue
          if (mask[j] < threshold) continue
          visited[j] = 1
          queue[tail++] = j
        }
      }
      sumX[area - 1] = sx
      sumY[area - 1] = sy
      compCount[area - 1] = 1
      if (area >= 100 && area <= 1000) {
        const cx = Math.round(sx / area)
        const cy = Math.round(sy / area)
        out.push({ x: cx, y: cy })
      }
      // Quiet the linter about unused local arrays. They are kept for
      // diagnostics: a future "evidence histogram" mode can read them.
      void sumX
      void sumY
      void compCount
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. Prior-mask state for checkMaskLock.
// ---------------------------------------------------------------------------

interface PriorSnapshot {
  mask: Float32Array
  meta: WorldMeta
}

let PRIOR: PriorSnapshot | null = null

/**
 * Cache the mask that pre-Make-sense saw, so `critiqueWorld` can check
 * that the derived world did not rewrite the coastline. The shell calls
 * this (or relies on the implicit call from `critiqueMask`) before
 * invoking `critiqueWorld`.
 */
export function setPriorMask(mask: Float32Array, meta: WorldMeta): void {
  PRIOR = { mask, meta }
}

/** Forget the cached prior mask. Useful when the user resets the sketch. */
export function clearPriorMask(): void {
  PRIOR = null
}

/** Read-only accessor for the cached prior mask, or `null`. */
export function getPriorMask(): { meta: WorldMeta; mask: Float32Array } | null {
  return PRIOR ? { mask: PRIOR.mask, meta: PRIOR.meta } : null
}

// ---------------------------------------------------------------------------
// 5. Post-Make-sense critic: critiqueWorld.
// ---------------------------------------------------------------------------

/**
 * Post-Make-sense critique. Walks the World and emits issues for every
 * structural violation it finds. If a prior mask was cached (because
 * `critiqueMask` was called first, or because `setPriorMask` was
 * invoked), `checkMaskLock` is included; otherwise it is silently
 * skipped.
 */
export function critiqueWorld(world: World): CritiqueResult {
  const issues: Issue[] = []
  issues.push(...checkIceDesertDualism(world))
  issues.push(...checkRainShadow(world))
  issues.push(...checkContinentality(world))
  issues.push(...checkFluxOnMaxima(world))

  if (PRIOR && PRIOR.meta.width === world.meta.width && PRIOR.meta.height === world.meta.height) {
    issues.push(...checkMaskLock(PRIOR.mask, world, PRIOR.meta.threshold))
  }

  const sorted = sortIssuesBySeverity(issues)
  return {
    score: scoreFromIssues(sorted),
    issues: sorted,
    pre: false,
  }
}
