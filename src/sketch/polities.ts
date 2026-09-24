/**
 * Countries, landscape analogs, and trade on a derived World.
 *
 * Runs after Make sense. Does not mutate the sketch mask or climate.
 * Borders follow relief and water; goods and routes are guesses with reasons.
 */

import type { City, Polity, RouteRisk, TradeGood, TradeRoute, World, WorldOverlay } from '../world/types'
import { idx } from '../world/types'
import { analogAt, analogForCells, PLACE_ANALOGS, TRADE_GOOD_LABEL } from './analogs'
import { ensureSeatCount } from './settlements'
import { attachChronicle } from './chronicle'
import { gravityFlow } from '../science/gravity'

export const MIN_POLITIES = 1
export const MAX_POLITIES = 24
/** Floor for the automatic country count so a continent is not a peninsula. */
const DEFAULT_POLITY_FLOOR = 6

export function clampPolityCount(n: number): number {
  if (!Number.isFinite(n)) return 4
  return Math.max(MIN_POLITIES, Math.min(MAX_POLITIES, Math.round(n)))
}

export function defaultPolityCount(world: World): number {
  const t = world.meta.threshold
  let n = 0
  for (let i = 0; i < world.mask.length; i++) {
    if (world.mask[i] < t) continue
    if (world.elev[i] >= 3500) continue
    if (world.suitability[i] < 0.28) continue
    n++
  }
  return clampPolityCount(Math.max(DEFAULT_POLITY_FLOOR, Math.round(n / 900)))
}

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function isLand(world: World, i: number): boolean {
  return world.mask[i] >= world.meta.threshold
}

const N4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

class MinHeap {
  readonly keys: number[] = []
  readonly vals: number[] = []
  get size(): number {
    return this.keys.length
  }
  push(key: number, val: number): void {
    this.keys.push(key)
    this.vals.push(val)
    this.up(this.keys.length - 1)
  }
  pop(): { key: number; val: number } | null {
    const n = this.keys.length
    if (!n) return null
    const key = this.keys[0]
    const val = this.vals[0]
    const lk = this.keys.pop() as number
    const lv = this.vals.pop() as number
    if (n > 1) {
      this.keys[0] = lk
      this.vals[0] = lv
      this.down(0)
    }
    return { key, val }
  }
  private up(i: number): void {
    const { keys, vals } = this
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= keys[i]) break
      ;[keys[p], keys[i]] = [keys[i], keys[p]]
      ;[vals[p], vals[i]] = [vals[i], vals[p]]
      i = p
    }
  }
  private down(i: number): void {
    const { keys, vals } = this
    const n = keys.length
    for (;;) {
      let m = i
      const l = i * 2 + 1
      const r = l + 1
      if (l < n && keys[l] < keys[m]) m = l
      if (r < n && keys[r] < keys[m]) m = r
      if (m === i) break
      ;[keys[m], keys[i]] = [keys[i], keys[m]]
      ;[vals[m], vals[i]] = [vals[i], vals[m]]
      i = m
    }
  }
}

function landStepCost(world: World, from: number, to: number): number {
  const de = Math.abs(world.elev[to] - world.elev[from])
  let c = 1 + (Number.isFinite(de) ? de / 480 : 0)
  const b = world.biome[to]
  if (b === 'ice' || b === 'alpine') c += 7
  if (b === 'hot-desert' || b === 'polar-desert') c += 2.2
  if (b === 'tundra') c += 1.4
  if (world.elev[to] > 2800) c += 2
  const riverTo = world.flux[to] > 12 || world.rivers[to] > 0
  const riverFrom = world.flux[from] > 12 || world.rivers[from] > 0
  if (world.flux[to] > 20 && !riverTo && !riverFrom) c += 1.3
  if (world.suitability[to] < 0.2) c += 0.8
  return Number.isFinite(c) && c >= 1 ? c : 1
}

/** Past this travel cost a cell stays wild, even if a shorter hop path exists. */
const CLAIM_REACH = 42
/** Close to the seat: the core. */
const CORE_REACH = 10
/** Inside this, held land. Farther, still inside the reach, is a march. */
const CLAIMED_REACH = 24
/** Crossing the river mask. Open country does not pay this. */
const RIVER_CROSS_COST = 24
/** A step this steep is a crest, not a slope. */
const CREST_JUMP_M = 600

function crossesRiver(world: World, from: number, to: number): boolean {
  return (world.rivers[from] > 0) !== (world.rivers[to] > 0)
}

/** Extra claim cost for stepping across a high crest. Zero on a gentle slope. */
function crestExtra(world: World, from: number, to: number): number {
  const a = world.elev[from]
  const b = world.elev[to]
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  const jump = Math.abs(b - a)
  if (jump < CREST_JUMP_M) return 0
  return (jump - 200) / 35
}

/**
 * Cost to claim `to` from `from`. Ridges and rivers are frontiers:
 * open country is the land-step cost; a crest or a river crossing costs more.
 * Trade routing still uses `landStepCost` alone.
 */
function claimStepCost(world: World, from: number, to: number): number {
  let c = landStepCost(world, from, to)
  if (crossesRiver(world, from, to)) c += RIVER_CROSS_COST
  c += crestExtra(world, from, to)
  return Number.isFinite(c) && c >= 1 ? c : 1
}

export type MarchBand = 'core' | 'claimed' | 'march' | 'wild'

function seatOf(world: World, pid: number): { x: number; y: number } | null {
  const polity = world.polities.find((p) => p.id === pid)
  if (polity) return { x: polity.capitalX, y: polity.capitalY }
  const seat = world.cities.find((c) => c.role === 'seat_of_power' && c.polityId === pid)
  if (seat) return { x: seat.x, y: seat.y }
  return null
}

/** Travel cost from a seat to one land cell. Same frontier costs as growth. */
function travelCost(world: World, ax: number, ay: number, bx: number, by: number): number {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  const start = idx(w, ax, ay)
  const goal = idx(w, bx, by)
  if (start === goal) return 0
  const dist = new Float64Array(n).fill(1e9)
  const heap = new MinHeap()
  dist[start] = 0
  heap.push(0, start)
  let guard = 0
  const cap = Math.min(n * 8, 1_200_000)
  while (heap.size && guard++ < cap) {
    const item = heap.pop()
    if (!item) break
    const { key, val: i } = item
    if (key > CLAIM_REACH) break
    if (i === goal) return key
    if (key > dist[i] + 1e-6) continue
    const x = i % w
    const y = (i - x) / w
    for (const [dx, dy] of N4) {
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (world.mask[ni] < threshold) continue
      const nd = key + claimStepCost(world, i, ni)
      if (!Number.isFinite(nd) || nd + 1e-6 >= dist[ni]) continue
      dist[ni] = nd
      heap.push(nd, ni)
    }
  }
  return dist[goal]
}

/**
 * How tightly the owning seat holds this cell, from travel cost.
 * Wild is unclaimed. Core is close, march is far but still inside the reach.
 */
export function marchOf(world: World, x: number, y: number): MarchBand {
  const { width: w, height: h } = world.meta
  if (y < 0 || y >= h || x < 0 || x >= w) return 'wild'
  const pid = world.polityId[idx(w, x, y)]
  if (pid < 0) return 'wild'
  const seat = seatOf(world, pid)
  if (!seat) return 'claimed'
  const cost = travelCost(world, seat.x, seat.y, x, y)
  if (!Number.isFinite(cost) || cost > CLAIM_REACH) return 'march'
  if (cost <= CORE_REACH) return 'core'
  if (cost <= CLAIMED_REACH) return 'claimed'
  return 'march'
}

function seatsOf(world: World): City[] {
  return world.cities.filter((c) => c.role === 'seat_of_power')
}

/** Grow countries from seats: watersheds and mountains cost more than plains. */
export function growPolities(world: World): void {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  if (world.polityId.length !== n) world.polityId = new Int16Array(n)
  world.polityId.fill(-1)
  const seats = seatsOf(world)
  if (!seats.length) {
    world.polities = []
    world.routes = []
    return
  }
  // Float64 + a visit cap: same reasons as `dijkstraPath`. Float32 rounding
  // past cost ~17 exceeds the 1e-6 stale-entry slop, so the heap keeps
  // pushing until `Array.push` throws RangeError: Invalid array length.
  const dist = new Float64Array(n).fill(1e9)
  const heap = new MinHeap()
  seats.forEach((seat, id) => {
    const i = idx(w, seat.x, seat.y)
    dist[i] = 0
    world.polityId[i] = id
    seat.polityId = id
    heap.push(0, i)
  })
  let guard = 0
  const cap = Math.min(n * 8, 1_200_000)
  while (heap.size && guard++ < cap) {
    const item = heap.pop()
    if (!item) break
    const { key, val: i } = item
    if (key > dist[i] + 1e-6) continue
    const x = i % w
    const y = (i - x) / w
    const pid = world.polityId[i]
    for (const [dx, dy] of N4) {
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (world.mask[ni] < threshold) continue
      const nd = key + claimStepCost(world, i, ni)
      if (!Number.isFinite(nd) || nd > CLAIM_REACH || nd + 1e-6 >= dist[ni]) continue
      dist[ni] = nd
      world.polityId[ni] = pid
      heap.push(nd, ni)
    }
  }
  for (let i = 0; i < n; i++) {
    if (world.mask[i] < threshold) {
      world.polityId[i] = -1
      continue
    }
    if (dist[i] > 90 && (world.biome[i] === 'ice' || world.elev[i] > 4200)) {
      world.polityId[i] = -1
    }
  }
  for (const city of world.cities) {
    const i = idx(w, city.x, city.y)
    const pid = world.polityId[i]
    city.polityId = pid >= 0 ? pid : undefined
  }
}

const GOODS: readonly TradeGood[] = [
  'grain',
  'livestock',
  'fish',
  'timber',
  'metals',
  'caravan',
  'forest',
]

function emptyGoods(): Record<TradeGood, number> {
  return {
    grain: 0,
    livestock: 0,
    fish: 0,
    timber: 0,
    metals: 0,
    caravan: 0,
    forest: 0,
  }
}

function addBiomeGoods(g: Record<TradeGood, number>, biome: string, wgt: number): void {
  if (biome === 'mediterranean' || biome === 'temperate-deciduous' || biome === 'steppe') g.grain += wgt
  if (biome === 'savanna' || biome === 'steppe') g.livestock += wgt
  if (biome === 'taiga' || biome === 'temperate-forest' || biome === 'temperate-deciduous') g.timber += wgt
  if (biome === 'rainforest') g.forest += wgt * 1.2
  if (biome === 'alpine') g.metals += wgt * 0.6
  if (biome === 'hot-desert' || biome === 'boreal-desert') g.caravan += wgt * 0.5
}

function addRoleGoods(g: Record<TradeGood, number>, city: City): void {
  switch (city.role) {
    case 'farmland':
      g.grain += 3
      break
    case 'pastoral':
      g.livestock += 3
      break
    case 'fishing':
      g.fish += 3
      break
    case 'hunting':
      g.timber += 2
      break
    case 'mining':
      g.metals += 3
      break
    case 'trade':
      g.caravan += 2
      if (city.port === 'sea') g.fish += 1
      break
    case 'seat_of_power':
      g.grain += 1
      g.caravan += 1
      break
    default:
      break
  }
  if (city.port === 'sea') g.fish += 1.5
  if (city.oasis) g.caravan += 2
}

function topGoods(g: Record<TradeGood, number>, side: 'hi' | 'lo'): TradeGood[] {
  const rows = GOODS.map((good) => ({ good, v: g[good] })).sort((a, b) =>
    side === 'hi' ? b.v - a.v : a.v - b.v,
  )
  const out: TradeGood[] = []
  for (const row of rows) {
    if (side === 'hi' && row.v <= 0.4) continue
    if (side === 'lo' && row.v >= 0) continue
    out.push(row.good)
    if (out.length >= 3) break
  }
  return out
}

function sampleHinterland(world: World, pid: number, max = 80): { x: number; y: number }[] {
  const { width: w, height: h } = world.meta
  const cells: { x: number; y: number }[] = []
  const step = Math.max(2, Math.floor(Math.sqrt((w * h) / 4000)))
  for (let y = 1; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (world.polityId[idx(w, x, y)] !== pid) continue
      cells.push({ x, y })
      if (cells.length >= max) return cells
    }
  }
  return cells
}

function summarizePolities(world: World): void {
  const { width: w, height: h } = world.meta
  const seats = seatsOf(world)
  const n = seats.length
  const landN = new Int32Array(Math.max(1, n))
  const prod = Array.from({ length: n }, () => emptyGoods())
  const demand = Array.from({ length: n }, () => emptyGoods())
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      const pid = world.polityId[i]
      if (pid < 0 || pid >= n) continue
      landN[pid]++
      addBiomeGoods(prod[pid], world.biome[i] ?? 'ocean', 0.004)
    }
  }
  for (const city of world.cities) {
    const pid = city.polityId
    if (pid === undefined || pid < 0 || pid >= n) continue
    addRoleGoods(prod[pid], city)
    for (const good of GOODS) demand[pid][good] += city.role === 'seat_of_power' ? 1.4 : 0.9
  }
  world.polities = seats.map((seat, id) => {
    const net = emptyGoods()
    let surplus = 0
    for (const good of GOODS) {
      net[good] = prod[id][good] - demand[id][good]
      if (net[good] > 0) surplus += net[good]
    }
    const analog = analogForCells(world, sampleHinterland(world, id), landN[id])
    const prev = world.polities.find((p) => p.id === id)
    const peopleCustom = Boolean(prev && prev.tradition !== prev.analog.tradition)
    return {
      id,
      name: prev?.name ?? seat.name,
      capitalX: seat.x,
      capitalY: seat.y,
      analog,
      tradition: peopleCustom && prev ? prev.tradition : analog.tradition,
      exports: topGoods(net, 'hi'),
      imports: topGoods(net, 'lo'),
      meltingPot: 0,
      mass: Math.max(0.25, (landN[id] / 80) * (1 + surplus)),
    }
  })
}

function coastDistField(world: World): Float32Array {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  const dist = new Float32Array(n).fill(1e5)
  const q: number[] = []
  for (let i = 0; i < n; i++) {
    if (world.mask[i] >= threshold) continue
    dist[i] = 0
    q.push(i)
  }
  let head = 0
  while (head < q.length) {
    const i = q[head++]
    const x = i % w
    const y = (i - x) / w
    const d = dist[i] + 1
    for (const [dx, dy] of N4) {
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (d >= dist[ni]) continue
      dist[ni] = d
      q.push(ni)
    }
  }
  return dist
}

function landDistField(world: World): Float32Array {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  const dist = new Float32Array(n).fill(1e5)
  const q: number[] = []
  for (let i = 0; i < n; i++) {
    if (world.mask[i] < threshold) continue
    dist[i] = 0
    q.push(i)
  }
  let head = 0
  while (head < q.length) {
    const i = q[head++]
    const x = i % w
    const y = (i - x) / w
    const d = dist[i] + 1
    for (const [dx, dy] of N4) {
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (d >= dist[ni]) continue
      dist[ni] = d
      q.push(ni)
    }
  }
  return dist
}

function dijkstraPath(
  world: World,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  kind: 'land' | 'sea',
  coast: Float32Array,
  land: Float32Array,
): { cost: number; path: { x: number; y: number }[] } | null {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  const start = idx(w, ax, ay)
  const goal = idx(w, bx, by)
  // Float64, not Float32: the stale-entry check compares stored distance
  // against float64 heap keys, and float32 rounding beyond cost ~17
  // exceeds the 1e-6 tolerance, silently discarding live heap entries.
  const dist = new Float64Array(n).fill(1e9)
  const prev = new Int32Array(n).fill(-1)
  const heap = new MinHeap()
  dist[start] = 0
  heap.push(0, start)
  const seaOk = (i: number): boolean => {
    if (world.mask[i] >= threshold) return i === start || i === goal
    if (world.summer[i] < -1.5) return false
    return true
  }
  const landOk = (i: number): boolean => world.mask[i] >= threshold
  const ok = kind === 'sea' ? seaOk : landOk
  const step = (from: number, to: number): number => {
    if (kind === 'land') return landStepCost(world, from, to)
    const cabotage = 1 + Math.min(10, land[to]) * 0.28
    return cabotage
  }
  let guard = 0
  const cap = Math.min(n * 8, 1_200_000)
  while (heap.size && guard++ < cap) {
    const item = heap.pop()
    if (!item) break
    const { key, val: i } = item
    if (i === goal) break
    if (key > dist[i] + 1e-6) continue
    const x = i % w
    const y = (i - x) / w
    for (const [dx, dy] of N4) {
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (!ok(ni)) continue
      const nd = key + step(i, ni)
      if (nd + 1e-6 >= dist[ni]) continue
      dist[ni] = nd
      prev[ni] = i
      heap.push(nd, ni)
    }
  }
  if (dist[goal] > 1e8) return null
  const path: { x: number; y: number }[] = []
  let cur = goal
  let hops = 0
  while (cur >= 0 && hops++ < n) {
    path.push({ x: cur % w, y: Math.floor(cur / w) })
    if (cur === start) break
    cur = prev[cur]
  }
  path.reverse()
  if (path.length < 2) return null
  const thin: { x: number; y: number }[] = []
  const stride = Math.max(1, Math.floor(path.length / 48))
  for (let i = 0; i < path.length; i += stride) thin.push(path[i])
  const last = path[path.length - 1]
  if (thin[thin.length - 1] !== last) thin.push(last)
  void coast
  return { cost: dist[goal], path: thin }
}

/** Why these two countries move this good. Does not change the gravity volume. */
function crossWhy(a: Polity, b: Polity, good: TradeGood): string {
  const label = TRADE_GOOD_LABEL[good]
  if (a.exports.includes(good) && b.imports.includes(good)) {
    return `${a.name} has surplus ${label}; ${b.name} wants it`
  }
  if (b.exports.includes(good) && a.imports.includes(good)) {
    return `${b.name} has surplus ${label}; ${a.name} wants it`
  }
  return `${a.name} can spare ${label}; ${b.name} takes a share`
}

function pairVolume(
  a: Polity,
  b: Polity,
  cityA: City,
  cityB: City,
  cost: number,
  kind: 'land' | 'sea',
): { v: number; good: TradeGood; why: string } {
  let best: TradeGood = 'grain'
  let want = 0.2
  for (const good of a.exports) {
    const w = b.imports.includes(good) ? 1 : 0.35
    if (w > want) {
      want = w
      best = good
    }
  }
  const massA = Math.max(0.25, a.mass ?? 1) * want
  const massB = Math.max(0.25, b.mass ?? 1)
  let v = gravityFlow(massA, massB, cost, kind)
  if (cityA.port === 'sea' && cityB.port === 'sea' && kind === 'sea') v *= 1.15
  if (cityA.role === 'trade' || cityB.role === 'trade') v *= 1.05
  return { v: Math.min(1, v), good: best, why: crossWhy(a, b, best) }
}

function isSeaPort(city: City): boolean {
  return city.port === 'sea'
}

function sameEndpoints(a: TradeRoute, b: TradeRoute): boolean {
  if (a.kind !== b.kind) return false
  return (
    (a.ax === b.ax && a.ay === b.ay && a.bx === b.bx && a.by === b.by) ||
    (a.ax === b.bx && a.ay === b.by && a.bx === b.ax && a.by === b.ay)
  )
}

function cityAt(world: World, x: number, y: number): City | undefined {
  return world.cities.find((c) => c.x === x && c.y === y)
}

function wrapDx(ax: number, bx: number, w: number): number {
  return Math.min(Math.abs(ax - bx), w - Math.abs(ax - bx))
}

function hubPairOk(a: City, b: City): boolean {
  return (
    a.role === 'seat_of_power' ||
    a.role === 'trade' ||
    a.port === 'sea' ||
    a.role === 'fishing' ||
    b.role === 'seat_of_power' ||
    b.role === 'trade' ||
    b.port === 'sea' ||
    b.role === 'fishing'
  )
}

function buildRoutes(world: World): void {
  const kept = (world.routes ?? []).filter((r) => r.author)
  world.routes = []
  const polities = world.polities
  if (polities.length < 1) {
    world.routes = kept
    refreshRouteFacts(world)
    return
  }
  const coast = coastDistField(world)
  const land = landDistField(world)
  const hubs = world.cities.filter(
    (c) =>
      c.role === 'seat_of_power' ||
      c.role === 'trade' ||
      c.port === 'sea' ||
      c.role === 'fishing',
  )
  const landCand: TradeRoute[] = []
  const seaCand: TradeRoute[] = []
  const { width: w } = world.meta
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const a = hubs[i]
      const b = hubs[j]
      if (a.polityId === undefined || b.polityId === undefined) continue
      const pa = polities[a.polityId]
      const pb = polities[b.polityId]
      if (!pa || !pb) continue
      const same = a.polityId === b.polityId
      const hop = Math.hypot(wrapDx(a.x, b.x, w), a.y - b.y)

      if (!same) {
        const landPath = dijkstraPath(world, a.x, a.y, b.x, b.y, 'land', coast, land)
        if (landPath) {
          const traded = pairVolume(pa, pb, a, b, landPath.cost, 'land')
          if (traded.v > 0.04) {
            landCand.push({
              kind: 'land',
              ax: a.x,
              ay: a.y,
              bx: b.x,
              by: b.y,
              volume: traded.v,
              good: traded.good,
              why: traded.why,
              path: landPath.path,
            })
          }
        }
      } else if (hubPairOk(a, b) && hop >= 10 && (a.role === 'seat_of_power' || b.role === 'seat_of_power')) {
        const landPath = dijkstraPath(world, a.x, a.y, b.x, b.y, 'land', coast, land)
        if (landPath) {
          const v = Math.min(1, gravityFlow(Math.max(0.25, pa.mass ?? 1), Math.max(0.2, pa.mass * 0.45), landPath.cost, 'land') * 0.55)
          if (v > 0.05) {
            const good = pa.exports[0] ?? 'grain'
            landCand.push({
              kind: 'land',
              ax: a.x,
              ay: a.y,
              bx: b.x,
              by: b.y,
              volume: v,
              good,
              why: `${pa.name} moves ${TRADE_GOOD_LABEL[good]} inland between ${a.name} and ${b.name}`,
              path: landPath.path,
            })
          }
        }
      }

      if (isSeaPort(a) && isSeaPort(b) && (!same || hop >= 14)) {
        const seaPath = dijkstraPath(world, a.x, a.y, b.x, b.y, 'sea', coast, land)
        if (seaPath) {
          const traded = same
            ? {
                v: Math.min(1, gravityFlow(Math.max(0.25, pa.mass ?? 1), Math.max(0.2, pa.mass * 0.4), seaPath.cost, 'sea') * 0.5),
                good: 'fish' as const,
                why: `${pa.name} sends fish by sea between ${a.name} and ${b.name}`,
              }
            : pairVolume(pa, pb, a, b, seaPath.cost, 'sea')
          const floor = same ? 0.03 : 0.03
          if (traded.v > floor) {
            seaCand.push({
              kind: 'sea',
              ax: a.x,
              ay: a.y,
              bx: b.x,
              by: b.y,
              volume: same ? traded.v : traded.v * 1.15,
              good: traded.good,
              why: traded.why,
              path: seaPath.path,
            })
          }
        }
      }
    }
  }
  landCand.sort((a, b) => b.volume - a.volume)
  seaCand.sort((a, b) => b.volume - a.volume)
  const maxV = Math.max(0.001, landCand[0]?.volume ?? 0, seaCand[0]?.volume ?? 0)
  const pack = (list: TradeRoute[], cap: number): TradeRoute[] =>
    list.slice(0, cap).map((r) => ({ ...r, volume: Math.max(0.08, Math.min(1, r.volume / maxV)) }))
  const generated = [...pack(landCand, 24), ...pack(seaCand, 20)]
  const extra = generated.filter((g) => !kept.some((k) => sameEndpoints(k, g)))
  world.routes = [...kept, ...extra]
  refreshRouteFacts(world)
}

export function tradeKindForOverlay(overlay: WorldOverlay): 'land' | 'sea' | null {
  if (overlay === 'caravans') return 'land'
  if (overlay === 'sea-lanes') return 'sea'
  return null
}

export function isSeaPortCity(city: City): boolean {
  return city.port === 'sea'
}

export function endpointName(world: World, x: number, y: number): string {
  return cityAt(world, x, y)?.name ?? `${x}, ${y}`
}

/** East-west km per cell at the equator: cells are slices of the planet's circumference. */
export function kmPerCell(world: World): number {
  const r = world.meta.planetRadiusKm > 0 ? world.meta.planetRadiusKm : 6371
  return (2 * Math.PI * r) / world.meta.width
}

/**
 * Route length in km along its path. Equirectangular grid, so east-west
 * cell width shrinks with cos(latitude); north-south stays constant.
 */
export function routeLengthKm(world: World, route: TradeRoute): number {
  const { width: w, height: h } = world.meta
  const k = kmPerCell(world)
  let km = 0
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1]
    const b = route.path[i]
    const midY = (a.y + b.y) / 2
    const lat = ((midY + 0.5) / h - 0.5) * Math.PI
    const dx = wrapDx(a.x, b.x, w) * Math.cos(lat)
    km += Math.hypot(dx, a.y - b.y) * k
  }
  return km
}

/** Historical overland caravan pace, km per day. */
const CARAVAN_KM_PER_DAY = 30
/** Coastal sailing pace with fair winds, km per day. */
const SHIP_KM_PER_DAY = 120
/** Packed routes sit at least this high. Below it, a spur is not a hub. */
const SIGNIFICANT_VOLUME = 0.08
/** Past this, a seat's patrols no longer watch the road. */
const FAR_LAND_KM = 400
/** Past this, a port no longer watches the lane. */
const FAR_SEA_KM = 900

const N8: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

function fmtKm(km: number): string {
  const rounded = km >= 100 ? Math.round(km / 10) * 10 : Math.round(km)
  return `${rounded.toLocaleString('en-US')} km`
}

function fmtDays(days: number): string {
  const n = Math.max(1, Math.round(days))
  return n === 1 ? '1 day' : `${n.toLocaleString('en-US')} days`
}

function cellDistanceKm(world: World, ax: number, ay: number, bx: number, by: number): number {
  const { width: w, height: h } = world.meta
  const k = kmPerCell(world)
  const midY = (ay + by) / 2
  const lat = ((midY + 0.5) / h - 0.5) * Math.PI
  const dx = wrapDx(ax, bx, w) * Math.cos(lat)
  return Math.hypot(dx, ay - by) * k
}

function polityAtPoint(world: World, x: number, y: number): Polity | undefined {
  const city = cityAt(world, x, y)
  const id = city?.polityId ?? world.polityId[idx(world.meta.width, x, y)]
  if (id === undefined || id < 0) return undefined
  return world.polities.find((p) => p.id === id)
}

function endpointKey(x: number, y: number): string {
  return `${x},${y}`
}

/** Cells the thinned path actually crosses, so a narrow country is not skipped. */
function routeCells(world: World, route: TradeRoute): { x: number; y: number }[] {
  const { width: w, height: h } = world.meta
  const cells: { x: number; y: number }[] = []
  const seen = new Set<number>()
  const push = (x: number, y: number) => {
    if (y < 0 || y >= h) return
    const xx = wrapX(x, w)
    const key = y * w + xx
    if (seen.has(key)) return
    seen.add(key)
    cells.push({ x: xx, y })
  }
  const pts = route.path
  if (!pts.length) return cells
  push(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    let dx = b.x - a.x
    if (dx > w / 2) dx -= w
    else if (dx < -w / 2) dx += w
    const x1 = a.x + dx
    const y1 = b.y
    let x = a.x
    let y = a.y
    const adx = Math.abs(x1 - x)
    const ady = Math.abs(y1 - y)
    const sx = x < x1 ? 1 : -1
    const sy = y < y1 ? 1 : -1
    let err = adx - ady
    const guard = adx + ady + 2
    for (let s = 0; s < guard; s++) {
      push(x, y)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 > -ady) {
        err -= ady
        x += sx
      }
      if (e2 < adx) {
        err += adx
        y += sy
      }
    }
  }
  return cells
}

function foreignCoast(world: World, x: number, y: number, home: Set<number>): Polity | undefined {
  const { width: w, height: h, threshold } = world.meta
  for (const [dx, dy] of N8) {
    const nx = wrapX(x + dx, w)
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    const i = idx(w, nx, ny)
    if (world.mask[i] < threshold) continue
    const pid = world.polityId[i]
    if (pid >= 0 && !home.has(pid)) return world.polities.find((p) => p.id === pid)
  }
  return undefined
}

function watchSeats(
  world: World,
  pa: Polity | undefined,
  pb: Polity | undefined,
): { x: number; y: number; name: string }[] {
  const out: { x: number; y: number; name: string }[] = []
  if (pa) out.push({ x: pa.capitalX, y: pa.capitalY, name: pa.name })
  if (pb && pb.id !== pa?.id) out.push({ x: pb.capitalX, y: pb.capitalY, name: pb.name })
  if (out.length) return out
  return world.polities.map((p) => ({ x: p.capitalX, y: p.capitalY, name: p.name }))
}

function assessRouteRisk(world: World, route: TradeRoute): { risk: RouteRisk; riskCause: string } {
  const pa = polityAtPoint(world, route.ax, route.ay)
  const pb = polityAtPoint(world, route.bx, route.by)
  const home = new Set<number>()
  if (pa) home.add(pa.id)
  if (pb) home.add(pb.id)
  let crossed: Polity | undefined
  for (const cell of routeCells(world, route)) {
    if (crossed) break
    const i = idx(world.meta.width, cell.x, cell.y)
    const onLand = world.mask[i] >= world.meta.threshold
    const pid = world.polityId[i]
    if (route.kind === 'land') {
      if (onLand && pid >= 0 && !home.has(pid)) crossed = world.polities.find((p) => p.id === pid)
      continue
    }
    if (onLand) {
      if (pid >= 0 && !home.has(pid)) crossed = world.polities.find((p) => p.id === pid)
    } else {
      crossed = foreignCoast(world, cell.x, cell.y, home)
    }
  }
  if (crossed) {
    return route.kind === 'sea'
      ? { risk: 'piracy', riskCause: `passes the coast of ${crossed.name}, outside either port's watch` }
      : { risk: 'banditry', riskCause: `crosses ${crossed.name}, beyond either seat's patrols` }
  }
  const watch = watchSeats(world, pa, pb)
  let farKm = 0
  let farName = watch[0]?.name ?? ''
  for (const p of route.path) {
    let best = Infinity
    let name = farName
    for (const s of watch) {
      const d = cellDistanceKm(world, p.x, p.y, s.x, s.y)
      if (d < best) {
        best = d
        name = s.name
      }
    }
    if (best < Infinity && best > farKm) {
      farKm = best
      farName = name
    }
  }
  const limit = route.kind === 'sea' ? FAR_SEA_KM : FAR_LAND_KM
  if (watch.length && farKm > limit) {
    const where = fmtKm(farKm)
    return route.kind === 'sea'
      ? { risk: 'piracy', riskCause: `the farthest stretch is about ${where} from ${farName}'s seat, in open water` }
      : { risk: 'banditry', riskCause: `the farthest stretch is about ${where} from ${farName}'s seat` }
  }
  if (!watch.length) {
    return {
      risk: 'safe',
      riskCause: route.kind === 'sea' ? 'no seat watches this water' : 'no seat watches this road',
    }
  }
  const names = [...new Set(watch.map((s) => s.name))].join(' and ')
  return { risk: 'safe', riskCause: `it stays within reach of ${names}` }
}

function whyForRoute(world: World, route: TradeRoute): string {
  const from = endpointName(world, route.ax, route.ay)
  const to = endpointName(world, route.bx, route.by)
  const label = TRADE_GOOD_LABEL[route.good]
  const pa = polityAtPoint(world, route.ax, route.ay)
  const pb = polityAtPoint(world, route.bx, route.by)
  if (pa && pb && pa.id !== pb.id) return crossWhy(pa, pb, route.good)
  if (pa && pb) {
    return route.kind === 'sea'
      ? `${pa.name} sends ${label} by sea between ${from} and ${to}`
      : `${pa.name} moves ${label} inland between ${from} and ${to}`
  }
  if (route.author) return `Writer traced ${label} from ${from} to ${to}`
  return `${label} moves from ${from} to ${to} because the path is cheap enough to carry`
}

function significantRoute(route: TradeRoute): boolean {
  return route.path.length >= 2 && route.volume >= SIGNIFICANT_VOLUME
}

function routeDegree(world: World): Map<string, { n: number; land: boolean; sea: boolean }> {
  const degree = new Map<string, { n: number; land: boolean; sea: boolean }>()
  for (const route of world.routes) {
    if (!significantRoute(route)) continue
    for (const [x, y] of [
      [route.ax, route.ay],
      [route.bx, route.by],
    ] as const) {
      const key = endpointKey(x, y)
      const row = degree.get(key) ?? { n: 0, land: false, sea: false }
      row.n += 1
      if (route.kind === 'land') row.land = true
      else row.sea = true
      degree.set(key, row)
    }
  }
  return degree
}

function markEntrepots(world: World): void {
  const degree = routeDegree(world)
  for (const city of world.cities) {
    const row = degree.get(endpointKey(city.x, city.y))
    const meets = (row?.n ?? 0) >= 2
    const portJoin = city.port === 'sea' && Boolean(row?.land) && Boolean(row?.sea)
    city.entrepot = meets || portJoin
  }
}

/** Entrepôt towns, busiest meeting-place first. */
export function entrepotHubs(world: World): City[] {
  const degree = routeDegree(world)
  return world.cities
    .filter((c) => c.entrepot)
    .sort((a, b) => {
      const d = (degree.get(endpointKey(b.x, b.y))?.n ?? 0) - (degree.get(endpointKey(a.x, a.y))?.n ?? 0)
      if (d !== 0) return d
      return a.name.localeCompare(b.name)
    })
}

function refreshRouteFacts(world: World): void {
  for (const route of world.routes) {
    const km = routeLengthKm(world, route)
    const pace = route.kind === 'sea' ? SHIP_KM_PER_DAY : CARAVAN_KM_PER_DAY
    route.days = km <= 0 ? undefined : Math.max(1, Math.ceil(km / pace))
    route.why = whyForRoute(world, route)
    const risk = assessRouteRisk(world, route)
    route.risk = risk.risk
    route.riskCause = risk.riskCause
  }
  markEntrepots(world)
}

function riskSentence(kind: 'land' | 'sea', risk: RouteRisk, cause: string): string {
  if (risk === 'banditry') return `Banditry: ${cause}.`
  if (risk === 'piracy') return `Piracy: ${cause}.`
  return kind === 'sea' ? `The lane is safe: ${cause}.` : `The road is safe: ${cause}.`
}

function hubClause(world: World, route: TradeRoute): string {
  const ends = [cityAt(world, route.ax, route.ay), cityAt(world, route.bx, route.by)]
  const hubs = ends.filter((c): c is City => Boolean(c?.entrepot))
  if (!hubs.length) return ''
  if (hubs.length === 1) return `Meets at ${hubs[0].name}, an entrepôt.`
  return `Meets at entrepôts ${hubs[0].name} and ${hubs[1].name}.`
}

function travelDays(world: World, route: TradeRoute): number {
  if (route.days && route.days > 0) return route.days
  const km = routeLengthKm(world, route)
  if (km <= 0) return 0
  const pace = route.kind === 'sea' ? SHIP_KM_PER_DAY : CARAVAN_KM_PER_DAY
  return Math.max(1, Math.ceil(km / pace))
}

export function routeCaption(world: World, route: TradeRoute): string {
  const good = TRADE_GOOD_LABEL[route.good]
  const from = endpointName(world, route.ax, route.ay)
  const to = endpointName(world, route.bx, route.by)
  const kind = route.kind === 'sea' ? 'Sea lane' : 'Caravan'
  const km = routeLengthKm(world, route)
  const days = travelDays(world, route)
  const safety =
    route.risk === 'banditry' ? 'banditry' : route.risk === 'piracy' ? 'piracy' : route.risk === 'safe' ? 'safe' : ''
  const core = `${kind}: ${good}, ${from} → ${to}`
  if (km <= 0) return safety ? `${core} · ${safety}` : core
  const tail = `${fmtKm(km)} · ${fmtDays(days)}`
  return safety ? `${core} · ${tail} · ${safety}` : `${core} · ${tail}`
}

/**
 * Inspector and gazetteer line: what moves, how far, how many days,
 * why this pair, and whether the road is watched. Not GDP.
 */
export function routeDossier(world: World, route: TradeRoute): string {
  const cap = routeCaption(world, route)
  const why = route.why?.trim() || whyForRoute(world, route)
  const assessed =
    route.risk && route.riskCause ? { risk: route.risk, riskCause: route.riskCause } : assessRouteRisk(world, route)
  const risk = riskSentence(route.kind, assessed.risk, assessed.riskCause)
  const hub = hubClause(world, route)
  const vol = Math.round(Math.max(0, Math.min(1, route.volume)) * 100)
  const provenance = route.author
    ? 'Writer-traced. Width follows surplus and path cost, not GDP.'
    : `Auto trade at ${vol}% of the busiest lane. Width is surplus × inverse path cost.`
  const whySentence = /[.!?]$/.test(why) ? why : `${why}.`
  return [cap.endsWith('.') ? cap : `${cap}.`, whySentence, risk, hub, provenance].filter((s) => s.length > 0).join(' ')
}

function pathDist(world: World, route: TradeRoute, x: number, y: number): number {
  const w = world.meta.width
  let best = 1e9
  for (const p of route.path) {
    const d = Math.hypot(wrapDx(p.x, x, w), p.y - y)
    if (d < best) best = d
  }
  return best
}

export function routeNearCell(
  world: World,
  x: number,
  y: number,
  kind?: 'land' | 'sea',
  maxDist = 2.4,
): TradeRoute | null {
  let best: TradeRoute | null = null
  let bestD = maxDist
  for (const r of world.routes) {
    if (kind && r.kind !== kind) continue
    if (r.path.length < 2) continue
    const d = pathDist(world, r, x, y)
    if (d <= bestD) {
      bestD = d
      best = r
    }
  }
  return best
}

export function removeRouteNearCell(
  world: World,
  x: number,
  y: number,
  kind?: 'land' | 'sea',
): TradeRoute | null {
  const hit = routeNearCell(world, x, y, kind, 4)
  if (!hit) return null
  world.routes = world.routes.filter((r) => r !== hit)
  markEntrepots(world)
  return hit
}

export function nearestTradeCity(world: World, x: number, y: number, maxChebyshev = 8): City | null {
  const w = world.meta.width
  let best: City | null = null
  let bestD = maxChebyshev + 1
  for (const c of world.cities) {
    const d = Math.max(wrapDx(c.x, x, w), Math.abs(c.y - y))
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/** Writer overlay: path between two towns. Does not rewrite climate. */
export function traceTradeRoute(
  world: World,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  kind: 'land' | 'sea',
): TradeRoute | null {
  const coast = coastDistField(world)
  const land = landDistField(world)
  const found = dijkstraPath(world, ax, ay, bx, by, kind, coast, land)
  if (!found) return null
  const cityA = cityAt(world, ax, ay)
  const cityB = cityAt(world, bx, by)
  const pa = cityA?.polityId !== undefined ? world.polities[cityA.polityId] : undefined
  const pb = cityB?.polityId !== undefined ? world.polities[cityB.polityId] : undefined
  let volume = 0.42
  let good: TradeGood = kind === 'sea' ? 'fish' : 'caravan'
  if (pa && pb && cityA && cityB) {
    if (pa.id === pb.id) {
      volume = Math.min(
        1,
        gravityFlow(Math.max(0.25, pa.mass ?? 1), Math.max(0.2, pa.mass * 0.45), found.cost, kind) * 0.6,
      )
      good = kind === 'sea' ? 'fish' : (pa.exports[0] ?? 'grain')
    } else {
      const pv = pairVolume(pa, pb, cityA, cityB, found.cost, kind)
      volume = Math.max(0.2, pv.v)
      good = pv.good
    }
  }
  const route: TradeRoute = {
    kind,
    ax,
    ay,
    bx,
    by,
    volume: Math.max(0.12, Math.min(1, volume)),
    good,
    path: found.path,
    author: true,
  }
  world.routes = world.routes.filter((r) => !sameEndpoints(r, route))
  world.routes.push(route)
  refreshRouteFacts(world)
  return route
}

function scoreMeltingPots(world: World): void {
  const incoming = new Float32Array(Math.max(1, world.polities.length))
  for (const r of world.routes) {
    const a = world.polityId[idx(world.meta.width, r.ax, r.ay)]
    const b = world.polityId[idx(world.meta.width, r.bx, r.by)]
    if (a >= 0) incoming[a] += r.volume
    if (b >= 0) incoming[b] += r.volume
  }
  for (const p of world.polities) {
    const samples = sampleHinterland(world, p.id, 60)
    const ids = new Set<string>()
    let elev = 0
    let coast = 0
    for (const c of samples) {
      const a = analogAt(world, c.x, c.y)
      if (a) ids.add(a.id)
      elev += world.elev[idx(world.meta.width, c.x, c.y)]
      const i = idx(world.meta.width, c.x, c.y)
      if (world.mask[i] >= world.meta.threshold) {
        /* land */
      }
    }
    for (const c of samples) {
      if (analogAt(world, c.x, c.y) && nearCoastQuick(world, c.x, c.y)) coast++
    }
    const capital = world.cities.find((c) => c.x === p.capitalX && c.y === p.capitalY)
    let mix = Math.min(1, Math.max(0, ids.size - 1) * 0.22)
    if (capital?.port === 'sea') mix += 0.28
    if (capital?.port === 'river') mix += 0.12
    mix += Math.min(0.25, incoming[p.id] * 0.12)
    const meanElev = samples.length ? elev / samples.length : 0
    if (meanElev > 1800 && coast < samples.length * 0.12) mix *= 0.55
    p.meltingPot = Math.max(0, Math.min(1, mix))
    if (capital) capital.meltingPot = p.meltingPot
  }
}

function nearCoastQuick(world: World, x: number, y: number): boolean {
  const { width: w, height: h } = world.meta
  for (let dy = -2; dy <= 2; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -2; dx <= 2; dx++) {
      if (!isLand(world, idx(w, wrapX(x + dx, w), ny))) return true
    }
  }
  return false
}

function refreshTrade(world: World): void {
  summarizePolities(world)
  buildRoutes(world)
  scoreMeltingPots(world)
}

/**
 * Place/keep the requested number of seats, grow borders, analogs, and routes.
 */
export function ensureWorldbuild(world: World, polityCount?: number): void {
  const n = clampPolityCount(polityCount ?? defaultPolityCount(world))
  ensureSeatCount(world, n)
  growPolities(world)
  refreshTrade(world)
  attachChronicle(world)
}

/** After the writer paints a claim: keep borders, rebuild goods and routes. */
export function refreshWorldbuildAfterPaint(world: World): void {
  refreshTrade(world)
}

export function paintClaim(
  world: World,
  cx: number,
  cy: number,
  radius: number,
  polityId: number,
): void {
  if (polityId < 0 || !world.polities.some((p) => p.id === polityId)) return
  const { width: w, height: h, threshold } = world.meta
  const r = Math.max(1, radius)
  const r2 = r * r
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy
    if (y < 0 || y >= h) continue
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue
      const x = wrapX(cx + dx, w)
      const i = idx(w, x, y)
      if (world.mask[i] < threshold) continue
      world.polityId[i] = polityId
    }
  }
}

export function nearestPolityId(world: World, x: number, y: number): number {
  const i = idx(world.meta.width, x, y)
  const here = world.polityId[i]
  if (here >= 0) return here
  let best = world.polities[0]?.id ?? 0
  let bestD = 1e9
  const w = world.meta.width
  for (const p of world.polities) {
    const dx = Math.min(Math.abs(p.capitalX - x), w - Math.abs(p.capitalX - x))
    const d = Math.hypot(dx, p.capitalY - y)
    if (d < bestD) {
      bestD = d
      best = p.id
    }
  }
  return best
}

export function polityAt(world: World, x: number, y: number): Polity | null {
  const id = world.polityId[idx(world.meta.width, x, y)]
  if (id < 0) return null
  return world.polities.find((p) => p.id === id) ?? null
}

export function meltingPotLabel(score: number): string {
  if (score >= 0.55) return 'Melting-pot capital — docks mix the hinterlands.'
  if (score >= 0.32) return 'A mixed town. The hinterland is still itself.'
  return 'Provincial seat. The hinterland sets the tone.'
}

export function economyLine(p: Polity): string {
  const ex = p.exports.map((g) => TRADE_GOOD_LABEL[g]).join(', ') || 'little surplus'
  const im = p.imports.map((g) => TRADE_GOOD_LABEL[g]).join(', ') || 'little want'
  return `Exports ${ex}. Wants ${im}.`
}

export { analogAt, PLACE_ANALOGS, TRADE_GOOD_LABEL }
