/**
 * Countries, landscape analogs, and trade on a derived World.
 *
 * Runs after Make sense. Does not mutate the sketch mask or climate.
 * Borders follow relief and water; goods and routes are guesses with reasons.
 */

import type { City, Polity, TradeGood, TradeRoute, World } from '../world/types'
import { idx } from '../world/types'
import { analogAt, analogForCells, PLACE_ANALOGS, TRADE_GOOD_LABEL } from './analogs'
import { ensureSeatCount } from './settlements'
import { gravityFlow } from '../science/gravity'

export const MIN_POLITIES = 1
export const MAX_POLITIES = 12

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
  return clampPolityCount(Math.max(1, Math.round(n / 1800)))
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
  let c = 1 + de / 480
  const b = world.biome[to]
  if (b === 'ice' || b === 'alpine') c += 7
  if (b === 'hot-desert' || b === 'polar-desert') c += 2.2
  if (b === 'tundra') c += 1.4
  if (world.elev[to] > 2800) c += 2
  const riverTo = world.flux[to] > 12 || world.rivers[to] > 0
  const riverFrom = world.flux[from] > 12 || world.rivers[from] > 0
  if (world.flux[to] > 20 && !riverTo && !riverFrom) c += 1.3
  if (world.suitability[to] < 0.2) c += 0.8
  return c
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
  const dist = new Float32Array(n).fill(1e9)
  const heap = new MinHeap()
  seats.forEach((seat, id) => {
    const i = idx(w, seat.x, seat.y)
    dist[i] = 0
    world.polityId[i] = id
    seat.polityId = id
    heap.push(0, i)
  })
  while (heap.size) {
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
      const nd = key + landStepCost(world, i, ni)
      if (nd + 1e-6 >= dist[ni]) continue
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
    return {
      id,
      name: seat.name,
      capitalX: seat.x,
      capitalY: seat.y,
      analog,
      tradition: analog.tradition,
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
  const dist = new Float32Array(n).fill(1e9)
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
  const cap = Math.min(n * 4, 400_000)
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
      const hx = Math.min(Math.abs(nx - bx), w - Math.abs(nx - bx))
      heap.push(nd + Math.hypot(hx, ny - by) * 0.15, ni)
    }
  }
  if (dist[goal] > 1e8) return null
  const path: { x: number; y: number }[] = []
  let cur = goal
  let hops = 0
  while (cur >= 0 && hops++ < w + h) {
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

function pairVolume(
  a: Polity,
  b: Polity,
  cityA: City,
  cityB: City,
  cost: number,
  kind: 'land' | 'sea',
): { v: number; good: TradeGood } {
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
  return { v: Math.min(1, v), good: best }
}

function buildRoutes(world: World): void {
  world.routes = []
  const polities = world.polities
  if (polities.length < 2) return
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
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const a = hubs[i]
      const b = hubs[j]
      if (a.polityId === undefined || b.polityId === undefined) continue
      if (a.polityId === b.polityId) continue
      const pa = polities[a.polityId]
      const pb = polities[b.polityId]
      if (!pa || !pb) continue
      const landPath = dijkstraPath(world, a.x, a.y, b.x, b.y, 'land', coast, land)
      if (landPath) {
        const { v, good } = pairVolume(pa, pb, a, b, landPath.cost, 'land')
        if (v > 0.04) {
          landCand.push({
            kind: 'land',
            ax: a.x,
            ay: a.y,
            bx: b.x,
            by: b.y,
            volume: v,
            good,
            path: landPath.path,
          })
        }
      }
      if (a.port === 'sea' && b.port === 'sea') {
        const seaPath = dijkstraPath(world, a.x, a.y, b.x, b.y, 'sea', coast, land)
        if (seaPath) {
          const { v, good } = pairVolume(pa, pb, a, b, seaPath.cost, 'sea')
          if (v > 0.05) {
            seaCand.push({
              kind: 'sea',
              ax: a.x,
              ay: a.y,
              bx: b.x,
              by: b.y,
              volume: v * 1.15,
              good,
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
  world.routes = [...pack(landCand, 24), ...pack(seaCand, 16)]
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
