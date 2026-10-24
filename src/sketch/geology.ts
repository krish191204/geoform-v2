/**
 * Surface geology read off a grounded `World`.
 *
 * Plates, relief, climate, and rivers decide which rock crops out where:
 * fold belts along collisions, arcs over subduction, basalt in rifts,
 * sheared rock on transforms, then surface cover (alluvium, salt, till)
 * and the quiet interior (basins, cratons). Pure: never writes to `world`.
 */

import type { World } from '../world/types'

export const LITHOLOGY = {
  /** Ocean, or no reading. */
  none: 0,
  /** Ancient granite–gneiss shield. */
  craton: 1,
  /** Metamorphic belt: schist, marble, quartzite. */
  foldBelt: 2,
  /** Andesite volcanoes over granodiorite batholiths. */
  volcanicArc: 3,
  /** Flood basalt and rift-valley fill. */
  riftBasalt: 4,
  /** Sandstone, shale, limestone. */
  sedimentaryBasin: 5,
  /** River gravel and floodplain silt. */
  alluvium: 6,
  /** Salt and gypsum from closed, dry basins. */
  evaporite: 7,
  /** Glacial till and moraine. */
  glacialTill: 8,
  /** Sheared, crushed rock along a transform. */
  faultZone: 9,
} as const

export const LITHOLOGY_LABEL: Record<number, string> = {
  0: 'Ocean',
  1: 'Craton',
  2: 'Fold belt',
  3: 'Volcanic arc',
  4: 'Rift basalt',
  5: 'Sedimentary basin',
  6: 'Alluvium',
  7: 'Evaporite',
  8: 'Glacial till',
  9: 'Fault zone',
}

/** Muted geologic-sheet palette. */
export const LITHOLOGY_COLOR: Record<number, string> = {
  0: '#d6e2e7',
  1: '#e9a9a1',
  2: '#a68fbf',
  3: '#c65a4f',
  4: '#56655b',
  5: '#e2cd8b',
  6: '#f5efc6',
  7: '#f3f1ea',
  8: '#bfcad2',
  9: '#e0893f',
}

const ROCKS: Record<number, string> = {
  1: 'granite and gneiss',
  2: 'schist, marble and quartzite',
  3: 'andesite lava over granodiorite',
  4: 'flood basalt and rift sediments',
  5: 'sandstone, shale and limestone',
  6: 'river gravel and floodplain silt',
  7: 'salt and gypsum',
  8: 'glacial till and moraine',
  9: 'sheared, crushed fault rock',
}

export interface GeologyReading {
  lith: Uint8Array
  ageMyr: Float32Array
  /** 0 none, 1 collision, 2 arc, 3 rift, 4 transform — cells on a plate edge only. */
  boundaryKind: Uint8Array
}

const BK_COLLISION = 1
const BK_ARC = 2
const BK_RIFT = 3
const BK_TRANSFORM = 4

/** Same cut-offs as `computePlates` (cells / Myr). */
const CONVERGE = 0.05
const DIVERGE = 0.05
const SLIDE = 0.1

const FOLD_KM = 300
const ARC_KM = 250
const RIFT_KM = 150
const FAULT_KM = 40

const TILL_TEMP_C = -8
const ALLUVIUM_MAX_M = 500
/** Share of river cells, by flux, too small to lay a floodplain. */
const ALLUVIUM_FLUX_QUANTILE = 0.25
const DRY_LAKE_MOIST = 0.25
const SALT_MOIST = 0.1
const SALT_MAX_M = 300
/** Metres a cell may sit above its lowest neighbour and still be a basin floor. */
const SALT_FLOOR_M = 10
const BASIN_MAX_M = 300
const FORELAND_MAX_M = 250
const FORELAND_MIN_KM = 60
const OLD_OROGEN_M = 1800

const DX = [1, -1, 0, 0]
const DY = [0, 0, 1, -1]
const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east']

interface GridScale {
  w: number
  h: number
  /** East–west km per cell on each row. */
  kmRow: Float64Array
  /** North–south km per row. */
  kmY: number
}

function gridScale(w: number, h: number, radiusKm: number): GridScale {
  const kmX = (2 * Math.PI * radiusKm) / w
  const kmRow = new Float64Array(h)
  for (let y = 0; y < h; y++) kmRow[y] = kmX * Math.sin(((y + 0.5) * Math.PI) / h)
  return { w, h, kmRow, kmY: (Math.PI * radiusKm) / h }
}

/** East and north km from cell `a` to cell `b`, x wrapped. */
function offsetKm(g: GridScale, a: number, b: number): { east: number; north: number } {
  const ax = a % g.w
  const ay = (a - ax) / g.w
  const bx = b % g.w
  const by = (b - bx) / g.w
  let dx = bx - ax
  if (dx > g.w / 2) dx -= g.w
  else if (dx < -g.w / 2) dx += g.w
  return { east: dx * 0.5 * (g.kmRow[ay] + g.kmRow[by]), north: (ay - by) * g.kmY }
}

function kmBetween(g: GridScale, a: number, b: number): number {
  const o = offsetKm(g, a, b)
  return Math.sqrt(o.east * o.east + o.north * o.north)
}

/** Which boundary kinds touch cell `i`, as bits `1 << kind`. Arcs mark the land side only. */
function boundaryBits(world: World, i: number): number {
  const { width: w, height: h, threshold } = world.meta
  const p = world.plateId[i]
  if (p <= 0) return 0
  const x = i % w
  const y = (i - x) / w
  const iLand = world.mask[i] >= threshold
  const vx = world.plateVx[i]
  const vy = world.plateVy[i]
  let bits = 0
  for (let k = 0; k < 4; k++) {
    const ny = y + DY[k]
    if (ny < 0 || ny >= h) continue
    const j = ny * w + ((x + DX[k] + w) % w)
    const q = world.plateId[j]
    if (q === p || q <= 0) continue
    const rx = world.plateVx[j] - vx
    const ry = world.plateVy[j] - vy
    const dot = rx * DX[k] + ry * DY[k]
    const perp = Math.abs(rx * DY[k] - ry * DX[k])
    const jLand = world.mask[j] >= threshold
    if (iLand && jLand) {
      if (dot < -CONVERGE) bits |= 1 << BK_COLLISION
      else if (dot > DIVERGE) bits |= 1 << BK_RIFT
      else if (perp > SLIDE) bits |= 1 << BK_TRANSFORM
    } else if (iLand) {
      if (dot < -CONVERGE) bits |= 1 << BK_ARC
    } else if (!jLand) {
      if (dot > DIVERGE) bits |= 1 << BK_RIFT
      else if (perp > SLIDE) bits |= 1 << BK_TRANSFORM
    }
  }
  return bits
}

/**
 * Multi-source BFS: each cell within `maxKm` learns its nearest seed (by hop
 * order, distance in km). O(n). `samePlate` keeps a seed's reach on its own plate.
 */
function spread(
  world: World,
  g: GridScale,
  seeds: number[],
  maxKm: number,
  samePlate: boolean,
  queue: Int32Array,
): Int32Array | null {
  if (seeds.length === 0) return null
  const { w, h } = g
  const plate = world.plateId
  const near = new Int32Array(w * h).fill(-1)
  let head = 0
  let tail = 0
  for (const s of seeds) {
    near[s] = s
    queue[tail++] = s
  }
  while (head < tail) {
    const c = queue[head++]
    const s = near[c]
    const cx = c % w
    const cy = (c - cx) / w
    for (let k = 0; k < 4; k++) {
      const ny = cy + DY[k]
      if (ny < 0 || ny >= h) continue
      const j = ny * w + ((cx + DX[k] + w) % w)
      if (near[j] !== -1) continue
      if (samePlate && plate[j] !== plate[s]) continue
      if (kmBetween(g, j, s) > maxKm) continue
      near[j] = s
      queue[tail++] = j
    }
  }
  return near
}

function hash01(a: number, b: number): number {
  let x = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x165667b1)) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function riverFluxFloor(world: World, n: number): number {
  const { threshold } = world.meta
  const flows: number[] = []
  for (let i = 0; i < n; i++) {
    if (world.rivers[i] === 1 && world.mask[i] >= threshold) flows.push(world.flux[i])
  }
  if (flows.length === 0) return Infinity
  const sorted = Float64Array.from(flows).sort()
  return sorted[Math.floor(sorted.length * ALLUVIUM_FLUX_QUANTILE)]
}

function isBasinFloor(world: World, i: number): boolean {
  const { width: w, height: h } = world.meta
  const x = i % w
  const y = (i - x) / w
  let lowest = Infinity
  for (let k = 0; k < 4; k++) {
    const ny = y + DY[k]
    if (ny < 0 || ny >= h) continue
    const e = world.elev[ny * w + ((x + DX[k] + w) % w)]
    if (e < lowest) lowest = e
  }
  return world.elev[i] - lowest <= SALT_FLOOR_M
}

/** Normalised distance (0 at the edge, 1 at the reach) to the nearest seed, or 2 when out of reach. */
function reach(g: GridScale, near: Int32Array | null, i: number, maxKm: number): number {
  if (!near || near[i] < 0) return 2
  return kmBetween(g, i, near[i]) / maxKm
}

export function readGeology(world: World): GeologyReading {
  const { width: w, height: h, threshold, planetRadiusKm, seed } = world.meta
  const n = w * h
  const lith = new Uint8Array(n)
  const ageMyr = new Float32Array(n)
  const boundaryKind = new Uint8Array(n)
  if (n === 0 || world.mask.length < n) return { lith, ageMyr, boundaryKind }

  const g = gridScale(w, h, planetRadiusKm)
  const seeds: number[][] = [[], [], [], [], []]
  for (let i = 0; i < n; i++) {
    const bits = boundaryBits(world, i)
    if (bits === 0) continue
    for (let k = BK_COLLISION; k <= BK_TRANSFORM; k++) if (bits & (1 << k)) seeds[k].push(i)
    boundaryKind[i] =
      bits & (1 << BK_COLLISION)
        ? BK_COLLISION
        : bits & (1 << BK_ARC)
          ? BK_ARC
          : bits & (1 << BK_RIFT)
            ? BK_RIFT
            : BK_TRANSFORM
  }

  const queue = new Int32Array(n)
  const fold = spread(world, g, seeds[BK_COLLISION], FOLD_KM, false, queue)
  const arc = spread(world, g, seeds[BK_ARC], ARC_KM, true, queue)
  const rift = spread(world, g, seeds[BK_RIFT], RIFT_KM, false, queue)
  const fault = spread(world, g, seeds[BK_TRANSFORM], FAULT_KM, false, queue)

  const fluxFloor = riverFluxFloor(world, n)
  const iceLine = world.meta.iceLineC ?? 0
  const lakes = world.lakes

  for (let i = 0; i < n; i++) {
    if (world.mask[i] < threshold) continue
    const plate = world.plateId[i]
    const e = world.elev[i]
    const moist = world.moistMean[i]

    if (world.tempMean[i] < TILL_TEMP_C || (world.summer[i] <= iceLine && world.winter[i] <= iceLine)) {
      lith[i] = LITHOLOGY.glacialTill
      ageMyr[i] = 0.01 + 2.5 * hash01(i, seed + 8)
      continue
    }
    if (world.rivers[i] === 1 && e < ALLUVIUM_MAX_M && world.flux[i] >= fluxFloor) {
      lith[i] = LITHOLOGY.alluvium
      ageMyr[i] = 0.01 + 1.9 * hash01(i, seed + 6)
      continue
    }
    const lake = lakes ? lakes[i] === 1 : false
    if (
      (lake && moist < DRY_LAKE_MOIST) ||
      (!lake && moist < SALT_MOIST && e < SALT_MAX_M && isBasinFloor(world, i))
    ) {
      lith[i] = LITHOLOGY.evaporite
      ageMyr[i] = 1 + 19 * hash01(i, seed + 7)
      continue
    }

    const sFault = reach(g, fault, i, FAULT_KM)
    const sArc = reach(g, arc, i, ARC_KM)
    const sRift = reach(g, rift, i, RIFT_KM)
    const sFold = reach(g, fold, i, FOLD_KM)
    const s = Math.min(sFault, sArc, sRift, sFold)
    if (s <= 1) {
      const jitter = hash01(i, seed + 3)
      if (s === sFault) {
        lith[i] = LITHOLOGY.faultZone
        ageMyr[i] = 100 * hash01(plate, seed + 4)
      } else if (s === sArc) {
        lith[i] = LITHOLOGY.volcanicArc
        ageMyr[i] = 60 * s * (0.6 + 0.4 * jitter)
      } else if (s === sRift) {
        lith[i] = LITHOLOGY.riftBasalt
        ageMyr[i] = 30 * s * (0.6 + 0.4 * jitter)
      } else if (e < FORELAND_MAX_M && s * FOLD_KM > FORELAND_MIN_KM) {
        lith[i] = LITHOLOGY.sedimentaryBasin
        ageMyr[i] = 10 + 50 * s
      } else {
        lith[i] = LITHOLOGY.foldBelt
        ageMyr[i] = 30 + 170 * s + 30 * jitter
      }
      continue
    }

    if (e >= OLD_OROGEN_M) {
      lith[i] = LITHOLOGY.foldBelt
      ageMyr[i] = 250 + 150 * hash01(plate, seed + 2)
    } else if (e < BASIN_MAX_M) {
      lith[i] = LITHOLOGY.sedimentaryBasin
      ageMyr[i] = 10 + 240 * (0.5 * hash01(plate, seed + 5) + 0.5 * clamp01(e / BASIN_MAX_M))
    } else {
      lith[i] = LITHOLOGY.craton
      ageMyr[i] = 1500 + 1500 * hash01(plate, seed + 1)
    }
  }

  return { lith, ageMyr, boundaryKind }
}

/** Nearest cell within `maxKm` of `i` on a boundary of `kind`; arcs must share `i`'s plate. */
function nearestEdge(
  world: World,
  g: GridScale,
  i: number,
  kind: number,
  maxKm: number,
): { km: number; dir: string } | null {
  const { w, h } = g
  const plate = world.plateId[i]
  const seen = new Set<number>([i])
  const queue = [i]
  let best = -1
  let bestKm = Infinity
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]
    const d = kmBetween(g, i, c)
    if (d > maxKm) continue
    if (d < bestKm && boundaryBits(world, c) & (1 << kind) && (kind !== BK_ARC || world.plateId[c] === plate)) {
      best = c
      bestKm = d
    }
    const cx = c % w
    const cy = (c - cx) / w
    for (let k = 0; k < 4; k++) {
      const ny = cy + DY[k]
      if (ny < 0 || ny >= h) continue
      const j = ny * w + ((cx + DX[k] + w) % w)
      if (seen.has(j)) continue
      seen.add(j)
      queue.push(j)
    }
  }
  if (best < 0) return null
  if (bestKm < 0.5 * g.kmY) return { km: 0, dir: '' }
  const o = offsetKm(g, i, best)
  const sector = Math.round(Math.atan2(o.north, o.east) / (Math.PI / 4))
  return { km: bestKm, dir: COMPASS[(sector + 8) % 8] }
}

function where(edge: { km: number; dir: string }, phrase: string): string {
  if (edge.km === 0) return `${phrase} right here`
  return `${phrase} ${Math.max(10, Math.round(edge.km / 10) * 10)} km to the ${edge.dir}`
}

function agePhrase(myr: number): string {
  if (myr < 1) return 'under a million years old'
  if (myr < 10) return `about ${myr.toFixed(1)} million years old`
  if (myr < 100) return `about ${Math.round(myr)} million years old`
  if (myr < 1000) return `about ${Math.round(myr / 10) * 10} million years old`
  return `about ${(Math.round(myr / 100) * 100).toLocaleString('en-US')} million years old`
}

function rockCause(world: World, g: GridScale, lith: number, i: number): string {
  switch (lith) {
    case LITHOLOGY.foldBelt: {
      const edge = nearestEdge(world, g, i, BK_COLLISION, FOLD_KM)
      return edge ? where(edge, 'squeezed where two plates meet') : 'the worn-down root of an old mountain belt'
    }
    case LITHOLOGY.volcanicArc: {
      const edge = nearestEdge(world, g, i, BK_ARC, ARC_KM)
      return edge
        ? where(edge, 'fed by ocean floor sinking under the coast')
        : 'built by volcanoes above a sinking ocean plate'
    }
    case LITHOLOGY.riftBasalt: {
      const edge = nearestEdge(world, g, i, BK_RIFT, RIFT_KM)
      return edge ? where(edge, 'erupted where the crust pulls apart') : 'erupted where the crust pulled apart'
    }
    case LITHOLOGY.faultZone: {
      const edge = nearestEdge(world, g, i, BK_TRANSFORM, FAULT_KM)
      return edge ? where(edge, 'ground up where two plates slide past each other') : 'ground up along a fault'
    }
    case LITHOLOGY.sedimentaryBasin: {
      const edge = nearestEdge(world, g, i, BK_COLLISION, FOLD_KM)
      return edge
        ? where(edge, 'worn off the mountains where two plates meet')
        : 'laid down in a quiet lowland far from any plate edge'
    }
    case LITHOLOGY.craton:
      return 'part of the old, stable core of the continent, far from any plate edge'
    case LITHOLOGY.alluvium:
      return 'dropped by the river across its floodplain'
    case LITHOLOGY.evaporite:
      return 'left behind as water dried up in a closed, dry basin'
    case LITHOLOGY.glacialTill:
      return 'dumped by ice in the cold'
    default:
      return ''
  }
}

/** One plain sentence for the inspector. Ocean cells return ''. */
export function describeRock(world: World, g: GeologyReading, i: number): string {
  const { width: w, height: h, threshold, planetRadiusKm } = world.meta
  if (i < 0 || i >= w * h || world.mask[i] < threshold) return ''
  const lith = g.lith[i]
  if (lith === LITHOLOGY.none) return ''
  const cause = rockCause(world, gridScale(w, h, planetRadiusKm), lith, i)
  return `${LITHOLOGY_LABEL[lith]}: ${ROCKS[lith]}, ${agePhrase(g.ageMyr[i])}, ${cause}.`
}

/** Share of land cells per lithology, largest first. */
export function geologySummary(world: World, g: GeologyReading): { lith: number; label: string; share: number }[] {
  const { width: w, height: h, threshold } = world.meta
  const counts = new Array<number>(10).fill(0)
  let land = 0
  for (let i = 0; i < w * h; i++) {
    if (world.mask[i] < threshold) continue
    land++
    counts[g.lith[i]]++
  }
  const rows: { lith: number; label: string; share: number }[] = []
  for (let lith = 1; lith < counts.length; lith++) {
    if (counts[lith] > 0) rows.push({ lith, label: LITHOLOGY_LABEL[lith], share: counts[lith] / land })
  }
  return rows.sort((a, b) => b.share - a.share || a.lith - b.lith)
}
