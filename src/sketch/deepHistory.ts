/**
 * Longue-durée eras earned from the grounded world: river cradles, upland ore,
 * sheltered harbours, dry margins, the widest country, and the longest road.
 *
 * Years count back from the present map, never an Earth calendar. Every line
 * cites a cell fact. Same world, same text. The world is read, never written.
 * Kingdom founding lines live in `chronicle.ts`; this is the deeper past.
 */

import type { City, TradeGood, TradeRoute, World } from '../world/types'
import { BIOME_BY_ID, createRng, hash2 } from '../world/types'

export interface HistoryEra {
  id: string
  title: string
  /** Years before the present map, `[start, end]`, start the larger. */
  yearsAgo: [number, number]
  places: { x: number; y: number; label: string }[]
  /** The cell facts behind the era. */
  why: string
  theme: 'cradle' | 'metal' | 'sea' | 'empire' | 'drought' | 'trade'
}

const PRE: readonly string[] = [
  'Aer', 'Bal', 'Cev', 'Dun', 'Eld', 'Fyr', 'Hes', 'Jun', 'Kel', 'Mev',
  'Nar', 'Ovr', 'Pel', 'Quel', 'Rhy', 'Sor', 'Tev', 'Vay', 'Wel', 'Yss', 'Zor',
]
const MID: readonly string[] = ['', 'a', 'e', 'i', 'o', 'an', 'el', 'ir']
const SUF: readonly string[] = [
  'dun', 'mere', 'thal', 'vos', 'rith', 'esh', 'lin', 'wick', 'dra', 'ven', 'sith', 'gast',
]

const CRADLE_TEMP_C = [10, 28] as const
/** Moist enough to farm, short of swamp. */
const CRADLE_MOIST = [0.25, 0.75] as const
/** Floodplains sit low. */
const CRADLE_MAX_ELEV_M = 500
/** Rain-fed fallback when no warm lowland river exists. */
const RAINFED_MAX_ELEV_M = 1500
const MAX_CRADLES = 3
/** Two cradles closer than this are one floodplain. */
const CRADLE_GAP_KM = 1200
const HIGHLAND_ELEV_M = [800, 2500] as const
const METAL_MAX_KM = 2000
const DRY_SEARCH_KM = 800
/** A dry margin must be this much drier than the river it borders. */
const DRY_MOIST_GAP = 0.08
const HARBOUR_RADIUS = 3

const ERA_YEARS: Readonly<Record<HistoryEra['theme'], [number, number]>> = {
  cradle: [6000, 4500],
  metal: [4500, 3200],
  sea: [3500, 2500],
  drought: [3200, 2900],
  empire: [2500, 1200],
  trade: [1200, 300],
}

interface Site {
  i: number
  x: number
  y: number
  score: number
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length] as T
}

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function cellAt(w: number, h: number, x: number, y: number): number {
  const yy = y < 0 ? 0 : y >= h ? h - 1 : y
  return yy * w + wrapX(x, w)
}

/** Small invented name, seeded by `meta.seed` and the cell. */
export function placeName(world: World, x: number, y: number): string {
  const { width: w, seed } = world.meta
  const mix = Math.floor(hash2(wrapX(Math.round(x), w), Math.round(y), (seed ^ 0x5bd1e995) | 0) * 4294967296)
  const rng = createRng(mix >>> 0 || 1)
  return pick(rng, PRE) + pick(rng, MID) + pick(rng, SUF)
}

function cellKm(world: World): number {
  return (2 * Math.PI * world.meta.planetRadiusKm) / world.meta.width
}

/** Great-circle-ish km on the equirectangular grid; x wraps. */
function distKm(world: World, ax: number, ay: number, bx: number, by: number): number {
  const { width: w, height: h } = world.meta
  let dx = Math.abs(ax - bx)
  if (dx > w / 2) dx = w - dx
  const lat = (0.5 - ((ay + by) / 2 + 0.5) / h) * Math.PI
  return Math.hypot(dx * Math.cos(lat), ay - by) * cellKm(world)
}

function isLand(world: World, i: number): boolean {
  return world.mask[i] >= world.meta.threshold && !world.lakes?.[i]
}

function isOcean(world: World, i: number): boolean {
  return world.mask[i] < world.meta.threshold
}

function isCoast(world: World, x: number, y: number): boolean {
  const { width: w, height: h } = world.meta
  if (!isLand(world, cellAt(w, h, x, y))) return false
  return (
    isOcean(world, cellAt(w, h, x + 1, y)) ||
    isOcean(world, cellAt(w, h, x - 1, y)) ||
    (y > 0 && isOcean(world, cellAt(w, h, x, y - 1))) ||
    (y < h - 1 && isOcean(world, cellAt(w, h, x, y + 1)))
  )
}

/** Largest elevation step, metres, to a land 4-neighbour. */
function reliefM(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const e = world.elev[cellAt(w, h, x, y)]
  let best = 0
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    const j = cellAt(w, h, x + dx, ny)
    if (!isLand(world, j)) continue
    best = Math.max(best, Math.abs(world.elev[j] - e))
  }
  return best
}

function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function niceKm(n: number): string {
  if (n >= 10000) return groupThousands(Math.round(n / 1000) * 1000)
  if (n >= 1000) return groupThousands(Math.round(n / 100) * 100)
  return groupThousands(Math.max(10, Math.round(n / 10) * 10))
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function findCradles(world: World): { sites: Site[]; riverFed: boolean } {
  const { width: w, height: h } = world.meta
  const n = w * h
  const choose = (riverFed: boolean): Site[] => {
    const cand: Site[] = []
    for (let i = 0; i < n; i++) {
      if (!isLand(world, i)) continue
      if (riverFed && world.rivers[i] !== 1) continue
      const t = world.tempMean[i]
      const m = world.moistMean[i]
      if (t < CRADLE_TEMP_C[0] || t > CRADLE_TEMP_C[1]) continue
      if (m < CRADLE_MOIST[0] || m > CRADLE_MOIST[1]) continue
      const b = world.biome[i]
      if (b === 'ocean' || b === 'wetland' || b === 'mangrove' || b === 'alpine') continue
      if (world.elev[i] > (riverFed ? CRADLE_MAX_ELEV_M : RAINFED_MAX_ELEV_M)) continue
      const flow = riverFed ? 1 + Math.log1p(Math.max(0, world.flux[i])) : 1
      cand.push({ i, x: i % w, y: Math.floor(i / w), score: world.suitability[i] * flow })
    }
    cand.sort((a, b) => b.score - a.score || a.i - b.i)
    const out: Site[] = []
    for (const c of cand) {
      if (out.length >= MAX_CRADLES) break
      const top = out[0]
      if (top && c.score < top.score * 0.6) break
      if (out.some((o) => distKm(world, o.x, o.y, c.x, c.y) < CRADLE_GAP_KM)) continue
      out.push(c)
    }
    return out
  }
  const river = choose(true)
  if (river.length) return { sites: river, riverFed: true }
  return { sites: choose(false), riverFed: false }
}

function fluxPercentile(world: World, flux: number): number {
  let below = 0
  let total = 0
  for (let i = 0; i < world.rivers.length; i++) {
    if (world.rivers[i] !== 1 || !isLand(world, i)) continue
    total++
    if (world.flux[i] < flux) below++
  }
  return total ? Math.round((100 * below) / total) : 0
}

function cradleEra(world: World, sites: readonly Site[], riverFed: boolean): HistoryEra {
  const first = sites[0] as Site
  const i = first.i
  const names = sites.map((s) => placeName(world, s.x, s.y))
  const t = Math.round(world.tempMean[i])
  const m = world.moistMean[i].toFixed(2)
  const e = Math.round(world.elev[i])
  const fall = Math.round(reliefM(world, first.x, first.y))
  const others = names.length > 1 ? ` ${listNames(names.slice(1))} repeat the pattern on their own floodplains.` : ''
  const why = riverFed
    ? `The river at ${names[0]} carries more water than ${fluxPercentile(world, world.flux[i])}% of the map's river cells, ` +
      (fall < 100
        ? `across flat ground at ${e} m (${fall} m of fall to the next cell), `
        : `along a valley floor at ${e} m (the valley side rises ${fall} m in one cell), `) +
      `${t} °C mean and moisture ${m}: ` +
      `warm enough for a long season, wet enough to farm, not so wet it drowns. ` +
      `Floods renew the silt, and one granary can feed many villages.${others}`
    : `No warm lowland river crosses this map, so the first surplus comes from rain-fed fields at ${names[0]}: ` +
      `${e} m, ${t} °C mean and moisture ${m}, suitability ${world.suitability[i].toFixed(2)}, the best open farmland on the map.${others}`
  return {
    id: 'cradle',
    title: 'First granaries',
    yearsAgo: [...ERA_YEARS.cradle],
    places: sites.map((s, k) => ({ x: s.x, y: s.y, label: names[k] as string })),
    why,
    theme: 'cradle',
  }
}

function metalEra(world: World, cradles: readonly Site[]): HistoryEra | null {
  const { width: w, height: h } = world.meta
  const best = cradles.map(() => ({ i: -1, km: Infinity }))
  for (let i = 0; i < w * h; i++) {
    if (!isLand(world, i)) continue
    const e = world.elev[i]
    if (e < HIGHLAND_ELEV_M[0] || e > HIGHLAND_ELEV_M[1]) continue
    const x = i % w
    const y = Math.floor(i / w)
    cradles.forEach((c, k) => {
      const km = distKm(world, x, y, c.x, c.y)
      const b = best[k]!
      if (km < b.km) {
        b.km = km
        b.i = i
      }
    })
  }
  const seen = new Set<number>()
  const hits: { i: number; km: number; cradle: Site }[] = []
  best.forEach((b, k) => {
    if (b.i < 0 || b.km > METAL_MAX_KM || seen.has(b.i)) return
    seen.add(b.i)
    hits.push({ i: b.i, km: b.km, cradle: cradles[k]! })
  })
  const lead = hits[0]
  if (!lead) return null
  const lx = lead.i % w
  const ly = Math.floor(lead.i / w)
  const hill = placeName(world, lx, ly)
  const valley = placeName(world, lead.cradle.x, lead.cradle.y)
  const fall = Math.round(reliefM(world, lx, ly))
  return {
    id: 'metal',
    title: 'Copper from the hills',
    yearsAgo: [...ERA_YEARS.metal],
    places: hits.map((hit) => {
      const x = hit.i % w
      const y = Math.floor(hit.i / w)
      return { x, y, label: placeName(world, x, y) }
    }),
    why:
      `${hill} rises to ${Math.round(world.elev[lead.i])} m only ${niceKm(lead.km)} km from ${valley}'s floodplain` +
      `${fall > 0 ? `, with ${fall} m of fall to the next cell` : ''}. ` +
      `Uplands like it expose rock where streams cut down and keep timber the valley has cleared, ` +
      `so ore and wood come down to the granaries and grain goes up.`,
    theme: 'metal',
  }
}

function seaEra(world: World, cradles: readonly Site[]): HistoryEra | null {
  const { width: w, height: h } = world.meta
  const r = HARBOUR_RADIUS
  const window = (2 * r + 1) ** 2 - 1
  let best: { x: number; y: number; km: number; near: number; sheltered: boolean; cradle: Site; cost: number } | null = null
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isCoast(world, x, y)) continue
      let near = 0
      let sx = 0
      let sy = 0
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          if (!dx && !dy) continue
          if (!isOcean(world, cellAt(w, h, x + dx, ny))) continue
          near++
          sx += dx
          sy += dy
        }
      }
      const len = Math.hypot(sx, sy)
      if (!near || !len) continue
      sx /= len
      sy /= len
      const landAt = (fx: number, fy: number): boolean => {
        const ry = Math.round(fy)
        return ry >= 0 && ry < h && isLand(world, cellAt(w, h, Math.round(fx), ry))
      }
      let sheltered = false
      for (let k = 1; k <= 2 && !sheltered; k++) {
        const cx = x + sx * k
        const cy = y + sy * k
        sheltered = landAt(cx - sy * 2, cy + sx * 2) && landAt(cx + sy * 2, cy - sx * 2)
      }
      let cradle = cradles[0]!
      let km = Infinity
      for (const c of cradles) {
        const d = distKm(world, x, y, c.x, c.y)
        if (d < km) {
          km = d
          cradle = c
        }
      }
      const cost = sheltered ? km : km * 2 + 200
      if (!best || cost < best.cost || (cost === best.cost && near > best.near)) {
        best = { x, y, km, near, sheltered, cradle, cost }
      }
    }
  }
  if (!best) return null
  const port = placeName(world, best.x, best.y)
  const valley = placeName(world, best.cradle.x, best.cradle.y)
  const where = best.km < cellKm(world) / 2 ? `${port}, where the floodplain meets the sea,` : `${port}, ${niceKm(best.km)} km from ${valley},`
  const why = best.sheltered
    ? `At ${where} land closes on both sides of the water: ` +
      `${best.near} of the ${window} cells around the shore are sea, yet arms of land break the swell. ` +
      `Boats can beach and load in calm water, so the valley's surplus first leaves by sea here.`
    : `No enclosed bay lies near the floodplains. The nearest shore, at ${port}, ${niceKm(best.km)} km from ${valley}, ` +
      `faces open water (${best.near} of ${window} nearby cells are sea), so landings stay seasonal and boats hug the coast.`
  return {
    id: 'sea',
    title: 'The first harbours',
    yearsAgo: [...ERA_YEARS.sea],
    places: [{ x: best.x, y: best.y, label: port }],
    why,
    theme: 'sea',
  }
}

function droughtEra(world: World, cradles: readonly Site[]): HistoryEra | null {
  const { width: w, height: h } = world.meta
  const reach = Math.min(16, Math.max(2, Math.ceil(DRY_SEARCH_KM / cellKm(world))))
  let best: { i: number; x: number; y: number; km: number; cradle: Site } | null = null
  for (const c of cradles) {
    const cm = world.moistMean[c.i]
    const cs = world.suitability[c.i]
    for (let dy = -reach; dy <= reach; dy++) {
      const y = c.y + dy
      if (y < 0 || y >= h) continue
      for (let dx = -reach; dx <= reach; dx++) {
        const x = wrapX(c.x + dx, w)
        const i = y * w + x
        if (!isLand(world, i) || world.rivers[i] === 1) continue
        if (world.moistMean[i] > cm - DRY_MOIST_GAP || world.suitability[i] >= cs) continue
        const km = distKm(world, x, y, c.x, c.y)
        if (km > DRY_SEARCH_KM) continue
        const drier =
          !best ||
          world.moistMean[i] < world.moistMean[best.i] ||
          (world.moistMean[i] === world.moistMean[best.i] &&
            (world.suitability[i] < world.suitability[best.i] ||
              (world.suitability[i] === world.suitability[best.i] && km < best.km)))
        if (drier) best = { i, x, y, km, cradle: c }
      }
    }
  }
  if (!best) return null
  const margin = placeName(world, best.x, best.y)
  const valley = placeName(world, best.cradle.x, best.cradle.y)
  const ci = best.cradle.i
  return {
    id: 'drought',
    title: 'The dry centuries',
    yearsAgo: [...ERA_YEARS.drought],
    places: [{ x: best.x, y: best.y, label: margin }],
    why:
      `${margin}, ${niceKm(best.km)} km from ${valley}, takes a moisture index of ${world.moistMean[best.i].toFixed(2)} ` +
      `against ${world.moistMean[ci].toFixed(2)} on the river, and suitability falls from ` +
      `${world.suitability[ci].toFixed(2)} to ${world.suitability[best.i].toFixed(2)}. ` +
      `Fields here farm at the dry edge: when the rains shift for a run of years, this margin fails first ` +
      `and its people fall back on the river. The map shows the risk, not a dated disaster.`,
    theme: 'drought',
  }
}

function seatTerrain(world: World, x: number, y: number): { where: string; reason: string } {
  const { width: w, height: h } = world.meta
  const i = cellAt(w, h, x, y)
  const e = Math.round(world.elev[i])
  const b = world.biome[i]
  const biome = b && b !== 'ocean' ? BIOME_BY_ID[b].label.toLowerCase() : 'open land'
  if (world.rivers[i] === 1) {
    return { where: `on a river at ${e} m in ${biome}`, reason: 'the river gathers the hinterland’s grain at one landing' }
  }
  if (isCoast(world, x, y)) {
    return { where: `on the shore at ${e} m in ${biome}`, reason: 'the coast lets the seat ship, and tax, by sea' }
  }
  if (e >= HIGHLAND_ELEV_M[0]) {
    return { where: `on high ground at ${e} m in ${biome}`, reason: 'height is easy to hold and slow to reach' }
  }
  return { where: `on open lowland at ${e} m in ${biome}`, reason: 'flat ground lets roads reach every side' }
}

function empireEra(world: World): HistoryEra | null {
  if (!world.polities.length) return null
  const counts = new Map<number, number>()
  for (let i = 0; i < world.polityId.length; i++) {
    const p = world.polityId[i]
    if (p >= 0) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  let lead = world.polities[0]!
  let cells = counts.get(lead.id) ?? 0
  for (const p of world.polities) {
    const c = counts.get(p.id) ?? 0
    if (c > cells || (c === cells && p.id < lead.id)) {
      lead = p
      cells = c
    }
  }
  if (!cells) return null
  const seat: Pick<City, 'x' | 'y' | 'name'> =
    world.cities.find((c) => c.role === 'seat_of_power' && c.polityId === lead.id) ??
    world.cities.find((c) => c.rank === 'seat' && c.polityId === lead.id) ?? {
      x: lead.capitalX,
      y: lead.capitalY,
      name: placeName(world, lead.capitalX, lead.capitalY),
    }
  const km2 = cells * cellKm(world) ** 2
  const terrain = seatTerrain(world, seat.x, seat.y)
  return {
    id: 'empire',
    title: 'The age of seats',
    yearsAgo: [...ERA_YEARS.empire],
    places: [{ x: seat.x, y: seat.y, label: seat.name }],
    why:
      `${lead.name} holds ${groupThousands(cells)} cells, about ${niceKm(km2)} km², the widest country on the map. ` +
      `Its seat, ${seat.name}, sits ${terrain.where}: ${terrain.reason}.`,
    theme: 'empire',
  }
}

const GOOD_WORD: Readonly<Record<TradeGood, string>> = {
  grain: 'grain',
  livestock: 'livestock',
  fish: 'fish',
  timber: 'timber',
  metals: 'metals',
  caravan: 'caravan goods',
  forest: 'forest goods',
}

function routeKm(world: World, r: TradeRoute): number {
  const pts = r.path.length >= 2 ? r.path : [{ x: r.ax, y: r.ay }, { x: r.bx, y: r.by }]
  let km = 0
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!
    const b = pts[k]!
    km += distKm(world, a.x, a.y, b.x, b.y)
  }
  return km
}

function nameAt(world: World, x: number, y: number): string {
  return world.cities.find((c) => c.x === x && c.y === y)?.name ?? placeName(world, x, y)
}

function tradeEra(world: World): HistoryEra | null {
  if (!world.routes.length) return null
  const { width: w, height: h } = world.meta
  let lead = world.routes[0]!
  let km = routeKm(world, lead)
  for (const r of world.routes) {
    const d = routeKm(world, r)
    if (d > km) {
      lead = r
      km = d
    }
  }
  const a = nameAt(world, lead.ax, lead.ay)
  const b = nameAt(world, lead.bx, lead.by)
  const pts = lead.path.length ? lead.path : [{ x: lead.ax, y: lead.ay }, { x: lead.bx, y: lead.by }]
  let top = -Infinity
  let water = 0
  for (const p of pts) {
    const i = cellAt(w, h, p.x, p.y)
    if (isOcean(world, i)) water++
    else top = Math.max(top, world.elev[i])
  }
  const sea = lead.kind === 'sea'
  const days = lead.days ? `, ${Math.round(lead.days)} days at ${sea ? 'ship' : 'caravan'} pace` : ''
  const lie = sea
    ? `It keeps to ${water} cells of open water between landings.`
    : `The road tops out at ${Math.round(top)} m${top >= HIGHLAND_ELEV_M[0] ? ', a pass it must cross' : ', staying in the lowlands'}.`
  return {
    id: 'trade',
    title: 'Roads and lanes',
    yearsAgo: [...ERA_YEARS.trade],
    places: [
      { x: lead.ax, y: lead.ay, label: a },
      { x: lead.bx, y: lead.by, label: b },
    ],
    why: `The longest ${sea ? 'sea lane' : 'caravan road'} runs about ${niceKm(km)} km from ${a} to ${b}, carrying ${GOOD_WORD[lead.good]}${days}. ${lie}`,
    theme: 'trade',
  }
}

/** 4–6 eras, oldest first, each earned from cells. Empty when the map has no land. */
export function deepHistory(world: World): HistoryEra[] {
  const n = world.meta.width * world.meta.height
  let anyLand = false
  for (let i = 0; i < n && !anyLand; i++) anyLand = isLand(world, i)
  if (!anyLand) return []
  const eras: HistoryEra[] = []
  const { sites, riverFed } = findCradles(world)
  if (sites.length) {
    eras.push(cradleEra(world, sites, riverFed))
    const metal = metalEra(world, sites)
    if (metal) eras.push(metal)
    const sea = seaEra(world, sites)
    if (sea) eras.push(sea)
    const drought = droughtEra(world, sites)
    if (drought) eras.push(drought)
  }
  const empire = empireEra(world)
  if (empire) eras.push(empire)
  const trade = tradeEra(world)
  if (trade) eras.push(trade)
  return eras.sort((a, b) => b.yearsAgo[0] - a.yearsAgo[0])
}

/** "c. 6000–4500 years before the map · First granaries — <why>" */
export function formatEra(e: HistoryEra): string {
  return `c. ${e.yearsAgo[0]}–${e.yearsAgo[1]} years before the map · ${e.title} — ${e.why}`
}
