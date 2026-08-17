/**
 * Auto-found towns on a derived World.
 *
 * Geoform 1's "Suggest settlements" (capital + mix by geography, spaced
 * across inhabitable land). v2 runs this once after Make sense so Worldbuild
 * is not an empty map.
 */

import type { CellBiome, City, SettlementRole, World } from '../world/types'
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
const ALPINE_M = 3500
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
  let score = suit * 0.35

  switch (role) {
    case 'seat_of_power':
      score += suit > 0.55 ? 0.32 : 0.1
      if (river > 8) score += 0.18
      if (coast) score += 0.12
      if (e < 800) score += 0.08
      break
    case 'farmland':
      if (
        b === 'steppe' ||
        b === 'savanna' ||
        b === 'temperate-forest' ||
        b === 'mediterranean' ||
        b === 'rainforest'
      ) {
        score += 0.28
      }
      if (river > 8) score += 0.12
      if (e < 1200) score += 0.1
      break
    case 'fishing':
      if (coast) score += 0.4
      if (river > 8 && e < 200) score += 0.18
      break
    case 'mining':
      if (b === 'alpine' || (e > 1200 && e < ALPINE_M)) score += 0.32
      if (e > 800) score += 0.12
      break
    case 'hunting':
      if (b === 'taiga' || b === 'tundra' || b === 'temperate-forest') score += 0.3
      if (e > 200 && e < 1800) score += 0.1
      break
    case 'trade':
      if (river > 8) score += 0.22
      if (coast) score += 0.18
      if (suit > 0.45) score += 0.1
      break
    case 'pastoral':
      if (b === 'savanna' || b === 'steppe') score += 0.34
      if (e < 900) score += 0.1
      break
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
 * One seat of power, then farmland / fishing / mining / trade / pastoral / hunting.
 * Does not mutate `world.cities` — the caller appends.
 */
export function suggestSettlementsCovering(world: World, coverage = DEFAULT_COVERAGE): City[] {
  const packed = capacity(world)
  const target = Math.max(
    Math.min(MIX_FLOOR, packed),
    Math.round(Math.max(0, Math.min(1, coverage)) * packed),
  )
  if (target <= 0 || countInhabitable(world) === 0) return []
  const inhabitable = countInhabitable(world)
  const spacing = Math.max(
    MIN_SPACING,
    Math.min(MAX_SPACING, Math.round(0.9 * Math.sqrt(inhabitable / target))),
  )
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
    used.add(city.name)
    occupied.add(`${c.x},${c.y}`)
    placed.push(city)
    scratch.push(city)
  }

  const tryPlace = (c: { x: number; y: number; score: number }, role: SettlementRole): boolean => {
    if (placed.length >= target) return false
    if (occupied.has(`${c.x},${c.y}`)) return false
    if (tooClose(scratch, c.x, c.y, w, spacing)) return false
    take(c, role)
    return true
  }

  if (!worldHasSeat({ ...world, cities: scratch })) {
    for (const c of collectCandidates(world, 'seat_of_power')) {
      if (tryPlace(c, 'seat_of_power')) break
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
    if (tryPlace(c, inferSettlementRole(fillWorld, c.x, c.y, { allowSeat: false }))) {
      fillWorld.cities = scratch
    }
  }
  return placed
}

/** Found towns if the world has none. Returns how many were added. */
export function seedSettlements(world: World, coverage = DEFAULT_COVERAGE): City[] {
  if (world.cities.length > 0) return []
  const added = suggestSettlementsCovering(world, coverage)
  world.cities.push(...added)
  return added
}
