/**
 * Hack's law on the world's river mask, plus Horton bifurcation when a
 * walk of the existing flux field can do it.
 *
 * Hack 1957: main-stem length L ∝ A^h. On Earth h sits near 0.5–0.6
 * (Hack, J. T., 1957, Studies of longitudinal stream profiles in Virginia
 * and Maryland, USGS PP 294-B; the same neighbourhood is the textbook
 * range). Drainage area is the flux already stored on the world — a
 * cell-runoff sum, not a downloaded DEM.
 *
 * Horton stream numbers use Strahler order on that same graph. No new
 * dependency and no buffer larger than the grid.
 */

import type { World } from '../world/types'

/** Earth neighbourhood for the Hack exponent. */
export const HACK_H_EARTH: readonly [number, number] = [0.5, 0.6]

const MIN_RIVER_CELLS = 12
const MIN_BASINS = 3

const D8: readonly { dx: number; dy: number; dist: number }[] = [
  { dx: -1, dy: -1, dist: Math.SQRT2 },
  { dx: 0, dy: -1, dist: 1 },
  { dx: 1, dy: -1, dist: Math.SQRT2 },
  { dx: -1, dy: 0, dist: 1 },
  { dx: 1, dy: 0, dist: 1 },
  { dx: -1, dy: 1, dist: Math.SQRT2 },
  { dx: 0, dy: 1, dist: 1 },
  { dx: 1, dy: 1, dist: Math.SQRT2 },
]

export interface RiverLawScore {
  /** Fitted Hack exponent, or null when the law does not apply yet. */
  h: number | null
  /** Mean Horton bifurcation ratio Nω / Nω+1, or null. */
  bifurcation: number | null
  note: string
}

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

interface Graph {
  width: number
  height: number
  rivers: Uint8Array
  flux: Float32Array
  /** Downstream river index, or −1 at an outlet. */
  down: Int32Array
  riverIds: number[]
}

function buildGraph(world: World): Graph | null {
  const { width, height } = world.meta
  const n = width * height
  if (world.rivers.length !== n || world.flux.length !== n) return null
  const down = new Int32Array(n)
  down.fill(-1)
  const riverIds: number[] = []
  for (let i = 0; i < n; i++) {
    if (world.rivers[i] !== 1) continue
    if (!Number.isFinite(world.flux[i])) continue
    riverIds.push(i)
  }
  for (const i of riverIds) {
    const x = i % width
    const y = (i - x) / width
    let best = -1
    let bestFlux = world.flux[i]
    for (let k = 0; k < 8; k++) {
      const nx = wrapX(x + D8[k].dx, width)
      const ny = y + D8[k].dy
      if (ny < 0 || ny >= height) continue
      const j = ny * width + nx
      if (world.rivers[j] !== 1) continue
      const fj = world.flux[j]
      if (fj > bestFlux) {
        bestFlux = fj
        best = j
      }
    }
    down[i] = best
  }
  return { width, height, rivers: world.rivers, flux: world.flux, down, riverIds }
}

function neighbourDist(graph: Graph, a: number, b: number): number {
  const { width, height } = graph
  const ax = a % width
  const ay = (a - ax) / width
  for (let k = 0; k < 8; k++) {
    const nx = wrapX(ax + D8[k].dx, width)
    const ny = ay + D8[k].dy
    if (ny < 0 || ny >= height) continue
    if (ny * width + nx === b) return D8[k].dist
  }
  return 1
}

/** Longest main stem: from the outlet, always step to the largest-flux tributary. */
function mainStemLength(graph: Graph, outlet: number): number {
  let length = 0
  let cur = outlet
  const guard = graph.riverIds.length + 1
  for (let hop = 0; hop < guard; hop++) {
    const x = cur % graph.width
    const y = (cur - x) / graph.width
    let best = -1
    let bestFlux = -1
    for (let k = 0; k < 8; k++) {
      const nx = wrapX(x + D8[k].dx, graph.width)
      const ny = y + D8[k].dy
      if (ny < 0 || ny >= graph.height) continue
      const j = ny * graph.width + nx
      if (graph.down[j] !== cur) continue
      const fj = graph.flux[j]
      if (fj > bestFlux) {
        bestFlux = fj
        best = j
      }
    }
    if (best < 0) break
    length += neighbourDist(graph, cur, best)
    cur = best
  }
  return length
}

function fitHack(points: readonly { area: number; length: number }[]): number | null {
  if (points.length < MIN_BASINS) return null
  const xs: number[] = []
  const ys: number[] = []
  for (const p of points) {
    if (p.area <= 0 || p.length <= 0) continue
    const x = Math.log(p.area)
    const y = Math.log(p.length)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    xs.push(x)
    ys.push(y)
  }
  const n = xs.length
  if (n < MIN_BASINS) return null
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    num += dx * (ys[i] - my)
    den += dx * dx
  }
  if (den < 1e-9) return null
  return num / den
}

/**
 * Strahler orders, then stream counts (a new stream starts where order rises).
 * Returns the mean bifurcation ratio, or null if only one order exists.
 */
function hortonBifurcation(graph: Graph): number | null {
  const n = graph.width * graph.height
  const order = new Uint16Array(n)
  const ids = graph.riverIds.slice().sort((a, b) => graph.flux[a] - graph.flux[b])
  for (const i of ids) {
    const x = i % graph.width
    const y = (i - x) / graph.width
    let maxOrder = 0
    let maxCount = 0
    for (let k = 0; k < 8; k++) {
      const nx = wrapX(x + D8[k].dx, graph.width)
      const ny = y + D8[k].dy
      if (ny < 0 || ny >= graph.height) continue
      const j = ny * graph.width + nx
      if (graph.down[j] !== i) continue
      const oj = order[j]
      if (oj > maxOrder) {
        maxOrder = oj
        maxCount = 1
      } else if (oj === maxOrder && oj > 0) {
        maxCount++
      }
    }
    order[i] = maxOrder === 0 ? 1 : maxCount >= 2 ? maxOrder + 1 : maxOrder
  }

  const streams = new Map<number, number>()
  for (const i of ids) {
    const oi = order[i]
    if (oi === 0) continue
    const x = i % graph.width
    const y = (i - x) / graph.width
    let continues = false
    for (let k = 0; k < 8; k++) {
      const nx = wrapX(x + D8[k].dx, graph.width)
      const ny = y + D8[k].dy
      if (ny < 0 || ny >= graph.height) continue
      const j = ny * graph.width + nx
      if (graph.down[j] === i && order[j] === oi) {
        continues = true
        break
      }
    }
    if (!continues) streams.set(oi, (streams.get(oi) ?? 0) + 1)
  }

  const orders = [...streams.keys()].sort((a, b) => a - b)
  const ratios: number[] = []
  for (let k = 0; k < orders.length - 1; k++) {
    const hi = streams.get(orders[k + 1]) ?? 0
    const lo = streams.get(orders[k]) ?? 0
    if (hi > 0 && lo > 0) ratios.push(lo / hi)
  }
  if (!ratios.length) return null
  let sum = 0
  for (const r of ratios) sum += r
  return sum / ratios.length
}

function hNote(h: number, bifurcation: number | null): string {
  const [lo, hi] = HACK_H_EARTH
  const where =
    h >= lo && h <= hi
      ? `Hack exponent h=${h.toFixed(2)} is in the Earth neighbourhood (0.5–0.6).`
      : `Hack exponent h=${h.toFixed(2)} is outside the Earth neighbourhood (0.5–0.6).`
  if (bifurcation == null) return where
  return `${where} Horton bifurcation Rb=${bifurcation.toFixed(2)}.`
}

/**
 * Score main-stem length against drainage area (flux) on the river mask.
 * Too few river cells, or too few separate stems, and the law does not apply yet.
 */
export function scoreRiverLaws(world: World): RiverLawScore {
  const absent: RiverLawScore = {
    h: null,
    bifurcation: null,
    note: "Hack's law does not apply yet — too few river cells.",
  }
  if (!world.rivers || !world.flux) return absent
  const graph = buildGraph(world)
  if (!graph || graph.riverIds.length < MIN_RIVER_CELLS) return absent

  const points: { area: number; length: number }[] = []
  for (const i of graph.riverIds) {
    if (graph.down[i] !== -1) continue
    const area = graph.flux[i]
    const length = mainStemLength(graph, i)
    if (area > 0 && length > 0) points.push({ area, length })
  }
  const h = fitHack(points)
  if (h == null) {
    return {
      h: null,
      bifurcation: null,
      note: "Hack's law does not apply yet — not enough separate main stems.",
    }
  }
  const bifurcation = hortonBifurcation(graph)
  return { h, bifurcation, note: hNote(h, bifurcation) }
}
