/**
 * Named landmasses the writer can open and build.
 * A continent is one connected land blob. Building it adds towns
 * only on that blob; the rest of the plate stays as it was.
 */

import type { City, SettlementRole, World } from '../world/types'
import { idx } from '../world/types'
import { labelLandmasses } from './countBigComponents'
import { cityNameGenerator } from './worldbuild'
import { annotateSettlement } from './settlements'

export interface Continent {
  id: number
  name: string
  cells: number
  /** Area-weighted centre, longitude wrapped. */
  x: number
  y: number
  /** Cells across, for framing the atlas. */
  span: number
  /** Aged surfaces on this land. Zero until the age pass has run. */
  mirror: number
  spring: number
  terrace: number
  hoodoo: number
  slot: number
}

const MIN_CELLS = 80
const MAX_LIST = 8
const TOWN_SPACING = 3
const MAX_EXTRA = 28

export function listContinents(world: World): Continent[] {
  const { width: w, height: h, threshold } = world.meta
  if (w <= 0 || h <= 0 || world.mask.length !== w * h) return []
  const labels = labelLandmasses(world.mask, w, h, threshold)
  const sites = world.sites
  const countSites = sites != null && sites.length === labels.id.length
  const acc: { sin: number; cos: number; sy: number; n: number; mirror: number; spring: number; terrace: number; hoodoo: number; slot: number }[] = []
  for (let i = 0; i < labels.id.length; i++) {
    const id = labels.id[i]
    if (id < 0) continue
    let row = acc[id]
    if (!row) {
      row = { sin: 0, cos: 0, sy: 0, n: 0, mirror: 0, spring: 0, terrace: 0, hoodoo: 0, slot: 0 }
      acc[id] = row
    }
    const x = i % w
    const y = (i - x) / w
    const ang = (x / w) * Math.PI * 2
    row.sin += Math.sin(ang)
    row.cos += Math.cos(ang)
    row.sy += y
    row.n++
    if (!countSites || !sites) continue
    const code = sites[i]
    if (code === 1) row.mirror++
    else if (code === 2) row.spring++
    else if (code === 3) row.terrace++
    else if (code === 4) row.hoodoo++
    else if (code === 5) row.slot++
  }
  const out: Continent[] = []
  for (let id = 0; id < labels.area.length && out.length < MAX_LIST; id++) {
    const cells = labels.area[id] ?? 0
    const row = acc[id]
    if (cells < MIN_CELLS || !row || !row.n) continue
    const ang = Math.atan2(row.sin, row.cos)
    out.push({
      id,
      name: labels.name[id] ?? 'The land',
      cells,
      x: ((ang / (Math.PI * 2)) * w + w) % w,
      y: row.sy / row.n,
      span: Math.max(12, Math.ceil(2.4 * Math.sqrt(cells / Math.PI))),
      mirror: row.mirror,
      spring: row.spring,
      terrace: row.terrace,
      hoodoo: row.hoodoo,
      slot: row.slot,
    })
  }
  return out
}

/** One line the gazetteer can print. Counts are cells, not place names. */
export function groundSentence(land: Continent): string {
  const bits: string[] = []
  if (land.mirror) bits.push(`${land.mirror} mirror`)
  if (land.spring) bits.push(`${land.spring} spring`)
  if (land.terrace) bits.push(`${land.terrace} terrace`)
  if (land.hoodoo) bits.push(`${land.hoodoo} hoodoo`)
  if (land.slot) bits.push(`${land.slot} slot`)
  return bits.length ? bits.join(' · ') : 'No aged surface on this land'
}

function nearTown(world: World, x: number, y: number, gap: number): boolean {
  const w = world.meta.width
  for (const c of world.cities) {
    const dx = Math.min(Math.abs(c.x - x), w - Math.abs(c.x - x))
    if (Math.max(dx, Math.abs(c.y - y)) < gap) return true
  }
  return false
}

function roleFor(world: World, x: number, y: number, n: number): SettlementRole {
  const { width: w, height: h, threshold } = world.meta
  const elev = world.elev[idx(w, x, y)] ?? 0
  if (elev > 1600) return 'mining'
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = (x + dx + w) % w
    const ny = y + dy
    if (ny < 0 || ny >= h || world.mask[idx(w, nx, ny)] < threshold) return 'fishing'
  }
  return n % 2 === 0 ? 'farmland' : 'trade'
}

/**
 * Found extra towns on one landmass. Does not touch other continents.
 * Returns how many towns were added.
 */
export function fillContinent(world: World, id: number): number {
  const { width: w, height: h, threshold } = world.meta
  const labels = labelLandmasses(world.mask, w, h, threshold)
  const cells = labels.area[id] ?? 0
  if (cells < MIN_CELLS) return 0
  const cap = Math.min(MAX_EXTRA, Math.max(6, Math.floor(cells / 50)))
  const gen = cityNameGenerator(world.meta.seed + 700 + id)
  const used = new Set(world.cities.map((c) => c.name))
  const nextName = (): string => {
    for (let i = 0; i < 400; i++) {
      const name = gen()
      if (!used.has(name)) return name
    }
    return `Hold ${world.cities.length + 1}`
  }
  const sites: { x: number; y: number; score: number }[] = []
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = idx(w, x, y)
      if (labels.id[i] !== id) continue
      if (world.mask[i] < threshold) continue
      const score = world.suitability[i] ?? 0
      if (score < 0.22) continue
      if ((world.elev[i] ?? 0) >= 3500) continue
      sites.push({ x, y, score })
    }
  }
  sites.sort((a, b) => b.score - a.score)
  let added = 0
  for (const site of sites) {
    if (added >= cap) break
    if (nearTown(world, site.x, site.y, TOWN_SPACING)) continue
    const city: City = {
      x: site.x,
      y: site.y,
      name: nextName(),
      seasonal: site.score,
      role: roleFor(world, site.x, site.y, added),
      rank: 'village',
    }
    annotateSettlement(world, city, { allowSeat: false })
    if (city.rank === 'seat') city.rank = 'town'
    used.add(city.name)
    world.cities.push(city)
    added++
  }
  return added
}
