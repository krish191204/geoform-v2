/**
 * Harsh teardown of a derived World.
 *
 * The Critique stage is the system's red pen. It looks at the mask (pre
 * Make-sense) and the World (post Make-sense) and calls out anything that
 * cannot, should not, or just does not happen on a planet. It never
 * hedges. It never offers alternatives. The user decides what to do with
 * the report.
 *
 * Severity weights: critical 25, major 10, minor 2. Score starts at 100
 * and deducts the sum of weights, clamped to `[0, 100]`.
 */

import type { World, Issue } from '../world/types'
import { idx } from '../world/types'
import { countBigComponents } from '../sketch/countBigComponents'

// ---------------------------------------------------------------------------
// 1. Severity weights and score aggregation.
// ---------------------------------------------------------------------------

/**
 * Deduction per severity. A single critical caps the score at 75; a single
 * major caps it at 90; a single minor caps it at 98; zero issues is 100.
 */
export const SEVERITY_WEIGHTS: Readonly<Record<Issue['severity'], number>> = Object.freeze({
  critical: 25,
  major: 10,
  minor: 2,
})

/**
 * Aggregate a score from an issue list. Starts at 100 and subtracts the
 * sum of severity weights. Clamped to `[0, 100]`.
 *
 * Deterministic — the same input list always yields the same number.
 */
export function scoreFromIssues(issues: Issue[]): number {
  let deduction = 0
  for (const i of issues) {
    deduction += SEVERITY_WEIGHTS[i.severity] ?? 0
  }
  const score = 100 - deduction
  if (score < 0) return 0
  if (score > 100) return 100
  return score
}

/**
 * Sort issues so the harshest ones read first. Critical -> major -> minor.
 * Stable for ties (preserves the order callers produced, e.g. the order
 * checks fired in).
 */
export function sortIssuesBySeverity(issues: Issue[]): Issue[] {
  const order: Record<Issue['severity'], number> = { critical: 0, major: 1, minor: 2 }
  return [...issues].sort((a, b) => order[a.severity] - order[b.severity])
}

// ---------------------------------------------------------------------------
// 2. Neighbor stencils.
// ---------------------------------------------------------------------------

/** 8-connected offsets (for local-maxima checks). Row stays inside the map. */
const NEIGHBOR_OFFSETS_8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const

/** 4-connected offsets (for BFS / coast distance). x wraps, y stays. */
const NEIGHBOR_OFFSETS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

// ---------------------------------------------------------------------------
// 3. Helpers used by the post-Make-sense checks.
// ---------------------------------------------------------------------------

/**
 * Distance in cells from the nearest coast. Coastal cells are land cells
 * with at least one 8-neighbour ocean neighbor. Ocean cells stay at 0.
 *
 * Inland cells have a strictly positive distance; we treat `coastDist > 50`
 * as "real interior" when evaluating continentality.
 */
export function computeCoastDistance(world: World): Float32Array {
  const { elev } = world
  const w = world.meta.width
  const h = world.meta.height
  const seaLevel = world.meta.seaLevel
  const dist = new Float32Array(w * h)
  if (w === 0 || h === 0) return dist

  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0

  // Seed: every coastal land cell gets distance 1 and goes into the queue.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      if (elev[i] < seaLevel) continue
      let isCoast = false
      for (const [dx, dy] of NEIGHBOR_OFFSETS_8) {
        const nx = (x + dx + w) % w
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        if (elev[ny * w + nx] < seaLevel) {
          isCoast = true
          break
        }
      }
      if (isCoast) {
        dist[i] = 1
        queue[tail++] = i
      }
    }
  }

  // BFS outward: distance increases by one per ring.
  while (head < tail) {
    const i = queue[head++]
    const cx = i % w
    const cy = (i - cx) / w
    const next = dist[i] + 1
    for (const [dx, dy] of NEIGHBOR_OFFSETS_4) {
      const nx = (cx + dx + w) % w
      const ny = cy + dy
      if (ny < 0 || ny >= h) continue
      const j = ny * w + nx
      if (elev[j] < seaLevel) continue
      if (dist[j] > 0) continue
      dist[j] = next
      queue[tail++] = j
    }
  }
  return dist
}

// ---------------------------------------------------------------------------
// 4. DOM-bar check: an ice cell directly next to a hot-arid desert cell.
// ---------------------------------------------------------------------------

/**
 * The Donald bar: a cell with `temp < 5°C` must not sit adjacent to a
 * cell with `temp > 30°C AND moist < 0.2`. The planet has no air-mass
 * that can step from "ice" to "Sahara" in one cell.
 *
 * Evidence lists the offending pair (the cold cell and its hostile neighbor).
 * If several violations exist, the first 8 pairs are recorded.
 */
export function checkIceDesertDualism(world: World): Issue[] {
  const { tempMean, moistMean } = world
  const w = world.meta.width
  const h = world.meta.height
  const issues: Issue[] = []
  const evidence: { x: number; y: number }[] = []
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      const t = tempMean[i]
      if (t >= 5) continue // not an "ice-side" cell
      for (const [dx, dy] of NEIGHBOR_OFFSETS_8) {
        const nx = (x + dx + w) % w
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        const j = ny * w + nx
        const tn = tempMean[j]
        const mn = moistMean[j]
        if (tn > 30 && mn < 0.2) {
          count++
          if (evidence.length < 16) {
            evidence.push({ x, y })
            evidence.push({ x: nx, y: ny })
          }
        }
      }
    }
  }
  if (count > 0) {
    issues.push({
      id: 'ice-desert-dualism',
      severity: 'critical',
      title: 'Ice adjacent to tropical desert',
      critique: `Found ${count} ice/desert boundary pairs: an ` +
        `ice cell (T<5C) sits next to a neighbour with T>30C and ` +
        `moist<0.2. That is the Donald bar violated — no air mass ` +
        `can cover that gradient in one cell.`,
      fix: 'Move the polar continent off the equator or rerun climate with a larger planetRadiusKm.',
      evidence,
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// 5. Rain-shadow check: prevailing west wind, windward must be wetter.
// ---------------------------------------------------------------------------

/**
 * Heuristic: assume west-to-east prevailing wind. For every row, locate
 * ridge candidates (cells visibly higher than both their upwind and
 * downwind neighbours). Compare moistMean upwind vs. leeward. Any ridge
 * with windward.mean < lee.mean is reported.
 */
export function checkRainShadow(world: World): Issue[] {
  const { elev, moistMean } = world
  const w = world.meta.width
  const h = world.meta.height
  const seaLevel = world.meta.seaLevel
  const issues: Issue[] = []
  const evidence: { x: number; y: number }[] = []
  let violationCount = 0

  for (let y = 1; y < h - 1; y++) {
    for (let x = 4; x < w - 4; x++) {
      const i = idx(w, x, y)
      if (elev[i] < seaLevel + 0.15) continue // only consider real ridges
      const westE = elev[idx(w, x - 4, y)]
      const eastE = elev[idx(w, x + 4, y)]
      if (elev[i] < westE + 0.15 || elev[i] < eastE + 0.15) continue // not a local high

      // Windward slice: x-4..x-1. Lee slice: x+1..x+4. Land only.
      let wSum = 0
      let wN = 0
      let eSum = 0
      let eN = 0
      for (let dx = -4; dx <= -1; dx++) {
        const j = idx(w, x + dx, y)
        if (elev[j] >= seaLevel) {
          wSum += moistMean[j]
          wN++
        }
      }
      for (let dx = 1; dx <= 4; dx++) {
        const j = idx(w, x + dx, y)
        if (elev[j] >= seaLevel) {
          eSum += moistMean[j]
          eN++
        }
      }
      if (wN < 2 || eN < 2) continue
      const windward = wSum / wN
      const lee = eSum / eN
      if (windward < lee - 0.04) {
        violationCount++
        if (evidence.length < 8) evidence.push({ x, y })
      }
    }
  }

  // Report any flipped shadow: a single ridge with reversed wets is enough
  // evidence to flag. We do not require a majority flip — that just dilutes
  // the message.
  if (violationCount > 0) {
    issues.push({
      id: 'rain-shadow-flipped',
      severity: 'minor',
      title: 'Rain shadow flipped',
      critique: `${violationCount} ridge${violationCount === 1 ? '' : 's'} ` +
        `${violationCount === 1 ? 'has' : 'have'} a drier windward (west) ` +
        `face than lee. With prevailing west wind, upwind flanks should be ` +
        `wetter.`,
      fix: 'Moisten upwind slopes, dry the lee, or change prevailing wind.',
      evidence,
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// 6. Continentality check: inland cells must have real seasonal swing.
// ---------------------------------------------------------------------------

/**
 * Real inland cells (coastDist > 50) read large annual temperature
 * ranges (continentality). If the median annual range over inland cells
 * is below 15C, the planet has no seasons at depth.
 */
export function checkContinentality(world: World): Issue[] {
  const { elev, tempRange } = world
  const w = world.meta.width
  const h = world.meta.height
  const seaLevel = world.meta.seaLevel
  const issues: Issue[] = []
  const coastDist = computeCoastDistance(world)
  const evidence: { x: number; y: number }[] = []
  let inlandCells = 0
  let flatCells = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      if (elev[i] < seaLevel) continue
      if (coastDist[i] <= 50) continue
      inlandCells++
      if (tempRange[i] < 15) {
        flatCells++
        if (evidence.length < 8) evidence.push({ x, y })
      }
    }
  }

  if (inlandCells >= 16 && flatCells / inlandCells > 0.5) {
    issues.push({
      id: 'no-continentality',
      severity: 'major',
      title: 'No continentality inland',
      critique: `${flatCells} of ${inlandCells} inland cells ` +
        `(coastDist > 50) have annual temperature range below 15C. ` +
        `Continental interiors burn in summer and freeze in winter.`,
      fix: 'Widen the seasonal swing on the climate model, or extend the land inward.',
      evidence,
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// 7. Flux on local maxima: rivers do not climb hills.
// ---------------------------------------------------------------------------

/**
 * Strict local maxima of the elevation field (higher than all 8
 * neighbours) must not have positive flux. Water does not flow uphill.
 */
export function checkFluxOnMaxima(world: World): Issue[] {
  const { elev, flux } = world
  const w = world.meta.width
  const h = world.meta.height
  const seaLevel = world.meta.seaLevel
  const issues: Issue[] = []
  const evidence: { x: number; y: number }[] = []
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      if (elev[i] < seaLevel) continue
      if (flux[i] <= 0) continue
      const e = elev[i]
      let isMax = true
      for (const [dx, dy] of NEIGHBOR_OFFSETS_8) {
        const nx = (x + dx + w) % w
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        if (elev[ny * w + nx] >= e) {
          isMax = false
          break
        }
      }
      if (isMax) {
        count++
        if (evidence.length < 12) evidence.push({ x, y })
      }
    }
  }
  if (count > 0) {
    issues.push({
      id: 'flux-on-maxima',
      severity: 'critical',
      title: 'Rivers cresting peaks',
      critique: `${count} cells are higher than all 8 neighbours yet ` +
        `carry downhill water flux. Water does not flow uphill.`,
      fix: 'Carve a channel through the ridge, lower the high cell, or rerun flux.',
      evidence,
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// 8. Mask lock check: world adds at most coast noise to the soft mask.
// ---------------------------------------------------------------------------

/**
 * Build a "current land" mask from elevation vs sea level, run the
 * same big-component counter on it, and compare to the saved pre-count.
 *
 * The rule: the count must not move by more than 5% (relative). If it does,
 * Make-sense rewrote the coastline more than the eye should be able to see.
 *
 * If `priorMask` is empty (length 0) the check is skipped — no prior data.
 */
export function checkMaskLock(
  priorMask: Float32Array,
  world: World,
  threshold: number,
): Issue[] {
  const issues: Issue[] = []
  if (priorMask.length === 0) return issues
  const w = world.meta.width
  const h = world.meta.height
  const n = w * h
  if (priorMask.length !== n) return issues

  const preCount = countBigComponents(priorMask, w, h, threshold, 100)

  // Reconstruct land from elevation vs sea level.
  const post = new Float32Array(n)
  const sea = world.meta.seaLevel
  for (let i = 0; i < n; i++) {
    post[i] = world.elev[i] >= sea ? 1 : 0
  }
  const postCount = countBigComponents(post, w, h, 0.5, 100)

  const denom = Math.max(1, preCount + postCount)
  const drift = Math.abs(preCount - postCount) / denom
  if (drift > 0.05) {
    issues.push({
      id: 'mask-drift',
      severity: 'critical',
      title: 'World rewrote the coastline',
      critique: `Pre-Make-sense mask had ${preCount} big land ` +
        `components (>=100 cells); the derived World has ${postCount}. ` +
        `That's a ${(drift * 100).toFixed(1)}% shift — Make-sense is ` +
        `supposed to add coast noise, not geography.`,
      fix: 'Re-paint the mask, or rerun Make-sense with conservative step limits.',
      evidence: [],
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// 9. Stained-glass plates: too much land is a plate edge.
// ---------------------------------------------------------------------------

/**
 * A continent that is pizza-sliced has a huge fraction of land cells
 * sitting on a land–land plate boundary. A suture or two is a thin
 * belt; Voronoi stained glass is a mesh.
 */
export function checkPlateStainedGlass(world: World): Issue[] {
  const { plateId, mask, meta } = world
  const w = meta.width
  const h = meta.height
  const threshold = meta.threshold
  let land = 0
  let edge = 0
  const evidence: { x: number; y: number }[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      if (mask[i] < threshold) continue
      if (plateId[i] <= 0) continue
      land++
      let isEdge = false
      for (const [dx, dy] of NEIGHBOR_OFFSETS_4) {
        const nx = (x + dx + w) % w
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        const j = ny * w + nx
        if (mask[j] < threshold) continue
        if (plateId[j] > 0 && plateId[j] !== plateId[i]) {
          isEdge = true
          break
        }
      }
      if (isEdge) {
        edge++
        if (evidence.length < 12) evidence.push({ x, y })
      }
    }
  }
  if (land < 80) return []
  const ratio = edge / land
  if (ratio <= 0.12) return []
  return [
    {
      id: 'plate-stained-glass',
      severity: 'major',
      title: 'Plates look like stained glass',
      critique:
        `${edge} of ${land} land cells (${(ratio * 100).toFixed(0)}%) ` +
        `sit on a land–land plate edge. That is a Voronoi mesh, not ` +
        `a handful of tectonic belts.`,
      fix: 'Fewer plates per landmass, oceanic plates in the sea, wiggly sutures — not pizza.',
      evidence,
    },
  ]
}

// ---------------------------------------------------------------------------
// 10. Uniform biome: one label ate the continent.
// ---------------------------------------------------------------------------

/**
 * A grounded planet has more than one land biome. Skip cells still
 * labelled ocean (unclassified test fixtures).
 */
export function checkUniformBiome(world: World): Issue[] {
  const { biome, mask, meta } = world
  const n = meta.width * meta.height
  const counts = new Map<string, number>()
  let land = 0
  for (let i = 0; i < n; i++) {
    if (mask[i] < meta.threshold) continue
    const b = biome[i]
    if (!b || b === 'ocean') continue
    land++
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  if (land < 80) return []
  let best = ''
  let bestN = 0
  for (const [id, c] of counts) {
    if (c > bestN) {
      bestN = c
      best = id
    }
  }
  const share = bestN / land
  if (share <= 0.72) return []
  return [
    {
      id: 'uniform-biome',
      severity: 'major',
      title: 'One biome ate the continent',
      critique:
        `${bestN} of ${land} classified land cells (${(share * 100).toFixed(0)}%) ` +
        `are ${best}. A planet that size has coasts, interiors, and altitude.`,
      fix: 'Raise interior rain, keep orographic shadows local, and do not default mid-latitudes to steppe.',
      evidence: [],
    },
  ]
}

// ---------------------------------------------------------------------------
// 11. Every town is a capital.
// ---------------------------------------------------------------------------

/**
 * Auto-founding should mix roles. More than one seat among five or more
 * towns is a placement bug, not a civilisation of thrones.
 */
export function checkAllCapitals(world: World): Issue[] {
  const cities = world.cities
  if (cities.length < 5) return []
  const seats = cities.filter((c) => (c.role ?? 'seat_of_power') === 'seat_of_power').length
  if (seats <= 1) return []
  return [
    {
      id: 'all-capitals',
      severity: 'major',
      title: 'Too many seats of power',
      critique:
        `${seats} of ${cities.length} towns are seats of power. ` +
        `A continent has one capital, then farms, ports, and mines — not a dozen thrones.`,
      fix: 'Quota mix: one seat, then farmland, fishing, mining, trade, pastoral.',
      evidence: cities
        .filter((c) => (c.role ?? 'seat_of_power') === 'seat_of_power')
        .slice(0, 8)
        .map((c) => ({ x: c.x, y: c.y })),
    },
  ]
}
