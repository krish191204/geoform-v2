/**
 * Auto-found towns on a derived World.
 *
 * Geoform 1's "Suggest settlements" (capital + mix by geography, spaced
 * across inhabitable land). v2 runs this once after Make sense so Worldbuild
 * is not an empty map. Each town's population is earned from the cell:
 * suitability, role, port, and rank — not a flat role guess.
 */

import type { CellBiome, City, SettlementPort, SettlementRank, SettlementRole, World } from '../world/types'
import { idx } from '../world/types'
import { cityNameGenerator } from './worldbuild'

export const SETTLEMENT_ROLE_LABEL: Record<SettlementRole, string> = {
  seat_of_power: 'Seat of power',
  farmland: 'Farmland',
  fishing: 'Fishing port',
  mining: 'Mine',
  hunting: 'Hunting camp',
  trade: 'Trade town',
  pastoral: 'Pastoral town',
}

export const SETTLEMENT_RANK_LABEL: Record<SettlementRank, string> = {
  village: 'Village',
  town: 'Town',
  seat: 'Seat',
}

export const SETTLEMENT_PORT_LABEL: Record<Exclude<SettlementPort, 'none'>, string> = {
  river: 'river port',
  sea: 'sea port',
}

const ROLES: readonly SettlementRole[] = [
  'seat_of_power',
  'farmland',
  'fishing',
  'mining',
  'hunting',
  'trade',
  'pastoral',
]

/** Auto-fill never founds a second throne. Weights scale to leftover slots. */
const MIX_PLAN: readonly { role: SettlementRole; weight: number }[] = [
  { role: 'farmland', weight: 2 },
  { role: 'fishing', weight: 1 },
  { role: 'mining', weight: 1 },
  { role: 'trade', weight: 1 },
  { role: 'pastoral', weight: 1 },
  { role: 'hunting', weight: 1 },
]

const NON_SEAT_ROLES: readonly SettlementRole[] = MIX_PLAN.map((p) => p.role)

const MIN_SUIT = 0.28
/** Below this, a non-seat stays a village — the land cannot feed a town. */
const POOR_SUIT = 0.46
/** Hunting and pastoral belong on land this modest or rougher. */
const MARGINAL_SUIT = 0.62
const ALPINE_M = 3500
const LOW_LAND_M = 900
const HIGH_LAND_M = 800
const ROUGH_RELIEF_M = 220
const MAX_TOWNS = 48
const MIN_SPACING = 4
const MAX_SPACING = 16
const DEFAULT_COVERAGE = 0.35
const MIX_FLOOR = 1 + MIX_PLAN.reduce((s, p) => s + p.weight, 0)

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function wrapDist(ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = Math.min(Math.abs(ax - bx), w - Math.abs(ax - bx))
  return Math.hypot(dx, ay - by)
}

function tooClose(cities: City[], x: number, y: number, w: number, spacing: number): boolean {
  return cities.some((c) => wrapDist(c.x, c.y, x, y, w) < spacing)
}

function isLand(world: World, i: number): boolean {
  return world.mask[i] >= world.meta.threshold
}

function nearOcean(world: World, x: number, y: number): boolean {
  const { width: w, height: h } = world.meta
  for (let dy = -3; dy <= 3; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -3; dx <= 3; dx++) {
      const nx = wrapX(x + dx, w)
      if (!isLand(world, idx(w, nx, ny))) return true
    }
  }
  return false
}

function riverAt(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  let best = world.flux[idx(w, x, y)]
  for (let dy = -2; dy <= 2; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -2; dx <= 2; dx++) {
      const f = world.flux[idx(w, wrapX(x + dx, w), ny)]
      if (f > best) best = f
    }
  }
  return best
}

function biomeAt(world: World, i: number): CellBiome {
  return world.biome[i] ?? 'ocean'
}

/** Tallest step to a neighbour, in metres. Rough land can hold a mine. */
function localRelief(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  const e = world.elev[idx(w, x, y)]
  let relief = 0
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const n = world.elev[idx(w, wrapX(x + dx, w), ny)]
      relief = Math.max(relief, Math.abs(n - e))
    }
  }
  return relief
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function roundPeople(n: number): number {
  const step = n >= 10000 ? 500 : n >= 1500 ? 100 : n >= 400 ? 50 : 10
  return Math.max(40, Math.round(n / step) * step)
}

/** How well this cell fits a role (0..1). Blocked cells score 0. */
export function scoreSettlementRole(
  world: World,
  x: number,
  y: number,
  role: SettlementRole,
): number {
  const { width: w } = world.meta
  const i = idx(w, x, y)
  if (!isLand(world, i)) return 0
  if (world.elev[i] >= ALPINE_M) return 0
  const suit = world.suitability[i]
  if (suit < MIN_SUIT) return 0

  const b = biomeAt(world, i)
  const coast = nearOcean(world, x, y)
  const river = riverAt(world, x, y)
  const e = world.elev[i]
  const oasis = isOasisSite(world, x, y)
  let score = suit * 0.35

  switch (role) {
    case 'seat_of_power':
      score += suit > 0.55 ? 0.32 : 0.1
      if (river > 8) score += 0.18
      if (coast) score += 0.12
      if (e < 800) score += 0.08
      break
    case 'farmland': {
      // Crops need suitable low land. High country and thin soil stay empty of farms.
      if (e >= LOW_LAND_M && !oasis) return 0
      if (suit < 0.5 && !oasis) return 0
      if (
        b === 'steppe' ||
        b === 'savanna' ||
        b === 'temperate-forest' ||
        b === 'temperate-deciduous' ||
        b === 'mediterranean' ||
        b === 'rainforest'
      ) {
        score += 0.28
      }
      if (oasis) score += 0.32
      if (river > 8) score += 0.12
      if (e < 500) score += 0.1
      break
    }
    case 'fishing':
      // A fishing port sits on the coast. An inland cell is not one.
      if (!coast) return 0
      score += 0.42
      if (e < 200) score += 0.08
      break
    case 'mining': {
      const high = e > HIGH_LAND_M || b === 'alpine'
      const rough = localRelief(world, x, y) >= ROUGH_RELIEF_M
      if (!high && !rough) return 0
      if (b === 'alpine' || (e > 1200 && e < ALPINE_M)) score += 0.34
      else if (high) score += 0.22
      if (rough) score += 0.16
      if (e > HIGH_LAND_M) score += 0.08
      break
    }
    case 'hunting': {
      const wild =
        b === 'taiga' || b === 'tundra' || b === 'temperate-forest' || b === 'temperate-deciduous'
      const marginal = suit < MARGINAL_SUIT || b === 'tundra' || b === 'taiga' || e > 1000
      const prime =
        suit >= 0.55 &&
        e < LOW_LAND_M &&
        (b === 'steppe' ||
          b === 'savanna' ||
          b === 'temperate-deciduous' ||
          b === 'mediterranean' ||
          b === 'rainforest')
      if ((!wild && !marginal) || prime) return 0
      if (wild) score += 0.3
      if (marginal) score += 0.12
      if (e > 200 && e < 1800) score += 0.08
      break
    }
    case 'trade':
      // Trade grows where boats can stop: coast, river, or an oasis road.
      if (!coast && river <= 8 && !oasis) return 0
      if (river > 8) score += 0.24
      if (coast) score += 0.22
      if (oasis) score += 0.2
      if (suit > 0.45) score += 0.08
      break
    case 'pastoral': {
      const grass = b === 'savanna' || b === 'steppe'
      const highPasture = e >= 700 && e < ALPINE_M
      const marginal = suit < MARGINAL_SUIT
      if (highPasture && (grass || b === 'alpine' || b === 'tundra' || marginal)) score += 0.36
      else if (grass && marginal) score += 0.34
      else return 0
      if (e < LOW_LAND_M) score += 0.06
      break
    }
  }
  return Math.max(0, Math.min(1, score))
}

export function worldHasSeat(world: World): boolean {
  return world.cities.some((c) => c.role === 'seat_of_power')
}

/**
 * Best-fit role at a cell. Auto-fill and Found city skip `seat_of_power`
 * once a capital already exists — otherwise argmax always picks the throne
 * because that role scores high on any decent site.
 */
export function inferSettlementRole(
  world: World,
  x: number,
  y: number,
  opts: { allowSeat?: boolean } = {},
): SettlementRole {
  const allowSeat = opts.allowSeat ?? !worldHasSeat(world)
  const roles = allowSeat ? ROLES : NON_SEAT_ROLES
  let best: SettlementRole = 'trade'
  let bestScore = -1
  for (const role of roles) {
    const s = scoreSettlementRole(world, x, y, role)
    if (s > bestScore) {
      bestScore = s
      best = role
    }
  }
  return best
}

/** Hinterland rank. Seat of power is always a seat; poor land stays a village. */
export function inferSettlementRank(
  world: World,
  x: number,
  y: number,
  role: SettlementRole,
): SettlementRank {
  if (role === 'seat_of_power') return 'seat'
  const { width: w } = world.meta
  const i = idx(w, x, y)
  const suit = world.suitability[i]
  if (!(suit >= POOR_SUIT)) return 'village'
  const port = inferSettlementPort(world, x, y)
  // Camps and herds on marginal land do not grow into towns.
  if ((role === 'hunting' || role === 'pastoral') && suit < MARGINAL_SUIT && port === 'none') {
    return 'village'
  }
  const river = riverAt(world, x, y)
  let hinterland = suit * 0.55 + Math.min(1, river / 40) * 0.15
  if (port === 'sea') hinterland += 0.28
  else if (port === 'river') hinterland += 0.16
  if (role === 'trade') hinterland += 0.08
  if (role === 'farmland' && world.elev[i] < LOW_LAND_M) hinterland += 0.08
  if (suit >= 0.7) hinterland += 0.1
  return hinterland >= 0.52 ? 'town' : 'village'
}

/** Sea if the cell sees ocean; river if flux is a real stream; else none. */
export function inferSettlementPort(world: World, x: number, y: number): SettlementPort {
  if (nearOcean(world, x, y)) return 'sea'
  return riverAt(world, x, y) > 8 ? 'river' : 'none'
}

/**
 * People and a one-line cause, from suitability, role, port, and rank.
 * Seats occupy the top band. A sea-port trade town beats an inland hunting
 * camp at the same suitability. Villages stay in the bottom band.
 */
export function earnSettlementSize(
  world: World,
  city: City,
): { population: number; sizeCause: string } {
  const { width: w } = world.meta
  const i = idx(w, city.x, city.y)
  const suit = clamp01(world.suitability[i] ?? city.seasonal ?? 0)
  const rank = city.rank ?? 'village'
  const role = city.role ?? 'trade'
  const port = city.port ?? 'none'
  const elev = world.elev[i] ?? 0

  const rolePull: Record<SettlementRole, number> = {
    seat_of_power: 1,
    trade: 0.9,
    farmland: 0.74,
    fishing: 0.66,
    mining: 0.5,
    pastoral: 0.4,
    hunting: 0.26,
  }
  let pull = rolePull[role]
  if (port === 'sea') pull += role === 'trade' || role === 'fishing' ? 0.28 : 0.1
  else if (port === 'river') pull += role === 'trade' || role === 'farmland' ? 0.16 : 0.06
  const t = clamp01(suit * 0.62 + Math.min(pull, 1.2) * 0.4)
  const band: readonly [number, number] =
    rank === 'seat' ? [14000, 42000] : rank === 'town' ? [1600, 11000] : [120, 1100]
  const population = roundPeople(band[0] + (band[1] - band[0]) * t)
  return { population, sizeCause: sizeCauseFor(city, suit, elev) }
}

/** Why this place is this large. One short geographic phrase. */
function sizeCauseFor(city: City, suit: number, elev: number): string {
  const role = city.role
  const port = city.port ?? 'none'
  if (role === 'seat_of_power') {
    return suit >= 0.55 ? 'seat on the best land' : 'seat on thin land'
  }
  if (role === 'fishing') return port === 'river' ? 'river port' : 'coastal fishery'
  if (role === 'trade' && port === 'sea') return 'sea-port trade'
  if (port === 'river' && (role === 'trade' || role === 'farmland')) return 'river port'
  if (role === 'mining') return elev > HIGH_LAND_M ? 'high mine' : 'rough-land mine'
  if (role === 'pastoral') return elev >= 700 ? 'high pasture' : 'open pasture'
  if (role === 'hunting') return 'inland hunting camp'
  if (suit < POOR_SUIT) return 'thin land'
  if (role === 'farmland') return 'low farmland'
  if (city.oasis) return 'oasis water'
  return 'workable land'
}

/** Inspector and gazetteer line. Null when the city has not been scored yet. */
export function formatSettlementPeople(city: { population?: number; sizeCause?: string }): string | null {
  if (typeof city.population !== 'number' || !Number.isFinite(city.population) || city.population <= 0) {
    return null
  }
  const people = `≈${Math.round(city.population).toLocaleString('en-US')} people`
  const cause = city.sizeCause?.trim()
  return cause ? `${people} — ${cause}` : people
}

/** Desert plus local moisture — an oasis, still one of the seven jobs. */
export function isOasisSite(world: World, x: number, y: number): boolean {
  const { width: w } = world.meta
  const i = idx(w, x, y)
  if (!isLand(world, i)) return false
  const b = biomeAt(world, i)
  if (b !== 'hot-desert' && b !== 'boreal-desert') return false
  return world.moistMean[i] > 0.22 || riverAt(world, x, y) > 4
}

/** Fill rank and port from geography. Infers role when missing. */
export function annotateSettlement(
  world: World,
  city: City,
  opts: { allowSeat?: boolean } = {},
): City {
  if (!city.role) city.role = inferSettlementRole(world, city.x, city.y, opts)
  city.port = inferSettlementPort(world, city.x, city.y)
  city.oasis = isOasisSite(world, city.x, city.y)
  city.rank = inferSettlementRank(world, city.x, city.y, city.role)
  if (city.role === 'seat_of_power') city.rank = 'seat'
  const earned = earnSettlementSize(world, city)
  city.population = earned.population
  city.sizeCause = earned.sizeCause
  return city
}

/** Largest-remainder mix of non-seat roles for `remaining` slots. */
export function mixQuotas(remaining: number): Record<SettlementRole, number> {
  const out = {} as Record<SettlementRole, number>
  for (const role of ROLES) out[role] = 0
  if (remaining <= 0) return out
  const totalW = MIX_PLAN.reduce((s, p) => s + p.weight, 0)
  const parts = MIX_PLAN.map((p) => {
    const exact = (remaining * p.weight) / totalW
    const n = Math.floor(exact)
    return { role: p.role, n, frac: exact - n }
  })
  let assigned = 0
  for (const p of parts) {
    out[p.role] = p.n
    assigned += p.n
  }
  const byFrac = [...parts].sort((a, b) => b.frac - a.frac)
  let i = 0
  while (assigned < remaining) {
    const p = byFrac[i % byFrac.length]
    out[p.role]++
    assigned++
    i++
  }
  return out
}

function countInhabitable(world: World): number {
  let n = 0
  for (let i = 0; i < world.mask.length; i++) {
    if (!isLand(world, i)) continue
    if (world.elev[i] >= ALPINE_M) continue
    if (world.suitability[i] < MIN_SUIT) continue
    n++
  }
  return n
}

function capacity(world: World): number {
  const n = countInhabitable(world)
  if (!n) return 0
  return Math.max(1, Math.min(MAX_TOWNS, Math.floor(n / (MIN_SPACING * MIN_SPACING))))
}

function collectCandidates(
  world: World,
  role: SettlementRole,
  step = 2,
): { x: number; y: number; score: number }[] {
  const { width: w, height: h } = world.meta
  const out: { x: number; y: number; score: number }[] = []
  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      const score = scoreSettlementRole(world, x, y, role)
      if (score < 0.22) continue
      out.push({ x, y, score })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

function collectSites(world: World): { x: number; y: number; score: number }[] {
  const { width: w, height: h } = world.meta
  const out: { x: number; y: number; score: number }[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      if (!isLand(world, i)) continue
      if (world.elev[i] >= ALPINE_M) continue
      if (world.suitability[i] < MIN_SUIT) continue
      out.push({ x, y, score: world.suitability[i] })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/**
 * Place a mix of towns covering `coverage` of inhabitable land.
 * `seatCount` thrones first (one per country), then farmland / fishing / mining / trade / pastoral / hunting.
 * Does not mutate `world.cities` — the caller appends.
 */
export function suggestSettlementsCovering(
  world: World,
  coverage = DEFAULT_COVERAGE,
  seatCount = 1,
): City[] {
  const packed = capacity(world)
  const thrones = Math.max(1, Math.min(24, Math.round(seatCount)))
  const target = Math.max(
    Math.min(MIX_FLOOR + thrones - 1, packed),
    Math.round(Math.max(0, Math.min(1, coverage)) * packed),
  )
  if (target <= 0 || countInhabitable(world) === 0) return []
  const inhabitable = countInhabitable(world)
  const spacing = Math.max(
    MIN_SPACING,
    Math.min(MAX_SPACING, Math.round(0.9 * Math.sqrt(inhabitable / target))),
  )
  const seatSpacing = Math.max(spacing + 2, Math.round(spacing * 1.7))
  const gen = cityNameGenerator(world.meta.seed + 91)
  const placed: City[] = []
  const scratch = [...world.cities]
  const w = world.meta.width
  const used = new Set(scratch.map((c) => c.name))
  const occupied = new Set(scratch.map((c) => `${c.x},${c.y}`))

  const nextName = (): string => {
    for (let i = 0; i < 400; i++) {
      const n = gen()
      if (!used.has(n)) return n
    }
    return `Town ${placed.length + 1}`
  }

  const take = (c: { x: number; y: number; score: number }, role: SettlementRole) => {
    const city: City = {
      x: c.x,
      y: c.y,
      name: nextName(),
      seasonal: c.score,
      role,
    }
    annotateSettlement(world, city, { allowSeat: role === 'seat_of_power' })
    city.role = role
    if (role === 'seat_of_power') city.rank = 'seat'
    used.add(city.name)
    occupied.add(`${c.x},${c.y}`)
    placed.push(city)
    scratch.push(city)
  }

  const tryPlace = (
    c: { x: number; y: number; score: number },
    role: SettlementRole,
    gap = spacing,
  ): boolean => {
    if (placed.length >= target) return false
    if (occupied.has(`${c.x},${c.y}`)) return false
    if (tooClose(scratch, c.x, c.y, w, gap)) return false
    take(c, role)
    return true
  }

  let seatsPlaced = scratch.filter((c) => c.role === 'seat_of_power').length
  if (seatsPlaced < thrones) {
    for (const c of collectCandidates(world, 'seat_of_power')) {
      if (seatsPlaced >= thrones) break
      if (tryPlace(c, 'seat_of_power', seatSpacing)) seatsPlaced++
    }
  }

  const quotas = mixQuotas(target - placed.length)
  for (const { role } of MIX_PLAN) {
    let need = quotas[role]
    if (need <= 0) continue
    for (const c of collectCandidates(world, role)) {
      if (need <= 0 || placed.length >= target) break
      if (tryPlace(c, role)) need--
    }
  }

  const fillWorld = { ...world, cities: scratch }
  for (const c of collectSites(world)) {
    if (placed.length >= target) break
    const role = inferSettlementRole(fillWorld, c.x, c.y, { allowSeat: false })
    if (scoreSettlementRole(world, c.x, c.y, role) < 0.22) continue
    if (tryPlace(c, role)) {
      fillWorld.cities = scratch
    }
  }
  capSeats(placed, world, thrones)
  return placed
}

/**
 * Keep at most `maxSeats` thrones. Extra seats become ordinary towns.
 */
export function capSeats(cities: City[], world: World, maxSeats = 1): void {
  const want = Math.max(1, Math.min(24, Math.round(maxSeats)))
  const view = { ...world, cities }
  const seats = cities.filter((c) => c.role === 'seat_of_power')
  if (seats.length > want) {
    const w = world.meta.width
    const keep: City[] = []
    const ranked = [...seats].sort(
      (a, b) => scoreSettlementRole(world, b.x, b.y, 'seat_of_power') - scoreSettlementRole(world, a.x, a.y, 'seat_of_power'),
    )
    for (const city of ranked) {
      if (keep.length >= want) {
        city.role = inferSettlementRole(view, city.x, city.y, { allowSeat: false })
        annotateSettlement(view, city, { allowSeat: false })
        continue
      }
      if (keep.some((k) => wrapDist(k.x, k.y, city.x, city.y, w) < 6)) {
        city.role = inferSettlementRole(view, city.x, city.y, { allowSeat: false })
        annotateSettlement(view, city, { allowSeat: false })
        continue
      }
      keep.push(city)
      annotateSettlement(view, city, { allowSeat: true })
      city.role = 'seat_of_power'
      city.rank = 'seat'
    }
  }
  if (!cities.some((c) => c.role === 'seat_of_power') && cities[0]) {
    cities[0].role = 'seat_of_power'
    annotateSettlement(view, cities[0], { allowSeat: true })
    cities[0].role = 'seat_of_power'
    cities[0].rank = 'seat'
  }
}

/** @deprecated alias — one throne unless `maxSeats` is passed. */
export function demoteExtraSeats(cities: City[], world: World, maxSeats = 1): void {
  capSeats(cities, world, maxSeats)
}

/**
 * Promote or found seats until `want` thrones exist; demote extras.
 */
export function ensureSeatCount(world: World, want: number): void {
  const n = Math.max(1, Math.min(24, Math.round(want)))
  capSeats(world.cities, world, n)
  let seats = world.cities.filter((c) => c.role === 'seat_of_power')
  const w = world.meta.width
  const farEnough = (x: number, y: number): boolean =>
    seats.every((s) => wrapDist(s.x, s.y, x, y, w) >= 6)

  if (seats.length < n) {
    const ranked = [...world.cities]
      .filter((c) => c.role !== 'seat_of_power')
      .sort(
        (a, b) =>
          scoreSettlementRole(world, b.x, b.y, 'seat_of_power') -
          scoreSettlementRole(world, a.x, a.y, 'seat_of_power'),
      )
    for (const city of ranked) {
      if (seats.length >= n) break
      if (!farEnough(city.x, city.y)) continue
      city.role = 'seat_of_power'
      annotateSettlement(world, city, { allowSeat: true })
      city.role = 'seat_of_power'
      city.rank = 'seat'
      seats.push(city)
    }
  }
  if (seats.length < n) {
    const gen = cityNameGenerator(world.meta.seed + 311)
    const used = new Set(world.cities.map((c) => c.name))
    for (const c of collectCandidates(world, 'seat_of_power')) {
      if (seats.length >= n) break
      if (world.cities.some((t) => t.x === c.x && t.y === c.y)) continue
      if (!farEnough(c.x, c.y)) continue
      let name = gen()
      while (used.has(name)) name = gen()
      const city: City = { x: c.x, y: c.y, name, seasonal: c.score, role: 'seat_of_power', rank: 'seat' }
      annotateSettlement(world, city, { allowSeat: true })
      city.role = 'seat_of_power'
      city.rank = 'seat'
      used.add(city.name)
      world.cities.push(city)
      seats.push(city)
    }
  }
  capSeats(world.cities, world, n)
}

/** Found towns if the world has none. Returns how many were added. */
export function seedSettlements(world: World, coverage = DEFAULT_COVERAGE, seatCount = 1): City[] {
  if (world.cities.length > 0) return []
  const added = suggestSettlementsCovering(world, coverage, seatCount)
  world.cities.push(...added)
  return added
}
