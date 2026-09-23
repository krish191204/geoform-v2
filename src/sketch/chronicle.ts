/**
 * Kingdom history derived from a grounded World.
 *
 * Ages, origins, and a few ruins are copy for the gazetteer. They are not a
 * second polity grid and they do not grow continents. The sketch mask is read
 * only. Same seed, same countries, same chronicle.
 */

import type { ChronicleEntry, ChronicleRuin, Polity, World, WorldChronicle } from '../world/types'
import { hash2, idx } from '../world/types'
import { labelLandmasses } from './countBigComponents'
import { findWonders } from './wonders'

/** Abandoned sites, not a ruin in every poor cell. */
export const MAX_RUINS = 6

const CLEAR_EDGE = 4
const MIN_RUIN_SPACING = 5
const RUIN_POOL = 96
const POOR_SUIT = 0.28

const RUIN_A = ['Ash', 'Old', 'Grey', 'Salt', 'High', 'Red', 'Low', 'Broken', 'Lost', 'Quiet'] as const
const RUIN_B = ['barrow', 'hold', 'haven', 'wick', 'stead', 'cairn', 'ford', 'mere', 'wall', 'gate'] as const

const N4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function wrapDist(ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = Math.min(Math.abs(ax - bx), w - Math.abs(ax - bx))
  return Math.hypot(dx, ay - by)
}

function peopleLead(tradition: string | undefined): string {
  return (tradition ?? '').trim().replace(/\.+$/g, '')
}

function originSentence(
  people: string,
  kind: 'highland' | 'coast' | 'split' | 'hold',
  neighbour?: string,
): string {
  const who = peopleLead(people)
  if (kind === 'highland') {
    return who ? `${who} kept a highland hold.` : 'A highland hold was kept above the plains.'
  }
  if (kind === 'coast') {
    return who ? `${who} planted a seat on an empty coast.` : 'A seat was planted on an empty coast.'
  }
  if (kind === 'split' && neighbour) {
    return who ? `${who} split from ${neighbour}.` : `The crown split from ${neighbour}.`
  }
  return who
    ? `${who} held this ground before the borders were drawn.`
    : 'This ground was held before the borders were drawn.'
}

/** One gazetteer line: age, origin, and a cut or a wonder when the land has one. */
export function foundingLine(entry: ChronicleEntry): string {
  const unit = entry.yearsAgo === 1 ? 'year' : 'years'
  const parts = [`Founded ${entry.yearsAgo} ${unit} ago.`, entry.origin]
  if (entry.border) parts.push(entry.border)
  if (entry.wonder) parts.push(entry.wonder)
  return parts.join(' ')
}

function emptyChronicle(): WorldChronicle {
  return { entries: [], ruins: [] }
}

function gridReady(world: World): world is World & { meta: World['meta'] } {
  if (!world?.meta) return false
  const { width: w, height: h } = world.meta
  if (!w || !h || w < 0 || h < 0) return false
  const n = w * h
  if (!world.mask || world.mask.length !== n) return false
  if (!world.polityId || world.polityId.length !== n) return false
  return true
}

function isLand(world: World, i: number): boolean {
  return world.mask[i] >= world.meta.threshold
}

function nearSea(world: World, x: number, y: number, rad: number): boolean {
  const { width: w, height: h } = world.meta
  for (let dy = -rad; dy <= rad; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -rad; dx <= rad; dx++) {
      const i = ny * w + wrapX(x + dx, w)
      if (!isLand(world, i)) return true
    }
  }
  return false
}

function poorCell(world: World, i: number): boolean {
  const suit = world.suitability && world.suitability.length === world.mask.length ? world.suitability[i] : 0.5
  if (Number.isFinite(suit) && suit < POOR_SUIT) return true
  const b = world.biome?.[i]
  return b === 'ice' || b === 'polar-desert' || b === 'tundra' || b === 'hot-desert' || b === 'boreal-desert' || b === 'alpine'
}

function yearsBeforeNow(seed: number, polityId: number, cells: number, meanSuit: number): number {
  const richness = Number.isFinite(meanSuit) ? Math.max(0, Math.min(1, meanSuit)) : 0
  const span = richness * Math.sqrt(Math.max(0, cells)) * 6
  const s = seed >>> 0
  const calendar = 220 + Math.floor(hash2(1, 1, s) * 160)
  const tie = Math.floor(hash2(polityId + 1, 7, s ^ 0x9e3779b9) * 16)
  const years = Math.round(calendar + span + tie)
  return Number.isFinite(years) ? Math.max(1, years) : calendar
}

interface Tally {
  cells: number
  suit: number
  elev: number
}

interface Neighbour {
  id: number
  edges: number
}

function safeWonders(world: World): { x: number; y: number; name: string }[] {
  if (!world.elev || !world.biome || !world.flux || !world.moistMean || !world.tempMean) return []
  if (!world.summerMoist || !world.winterMoist || !world.rivers) return []
  if (world.elev.length !== world.mask.length) return []
  return findWonders(world).map((w) => ({ x: w.x, y: w.y, name: w.name }))
}

function ruinName(x: number, y: number, seed: number): string {
  const s = seed >>> 0
  const a = RUIN_A[Math.floor(hash2(x, y, s ^ 0xa11) * RUIN_A.length)] ?? 'Old'
  const b = RUIN_B[Math.floor(hash2(x + 3, y + 9, s ^ 0xb22) * RUIN_B.length)] ?? 'barrow'
  return `${a}${b}`
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base} ${n}`)) n++
  const name = `${base} ${n}`
  used.add(name)
  return name
}

/**
 * Read the grounded world and return founding lines plus at most {@link MAX_RUINS} ruins.
 * Does not write `world.mask`, `world.polityId`, or `world.polities`.
 */
export function buildChronicle(world: World): WorldChronicle {
  if (!gridReady(world)) return emptyChronicle()
  const { width: w, height: h, seed } = world.meta
  const n = w * h
  const polities = world.polities ?? []
  const byId = new Map<number, Polity>()
  for (const p of polities) byId.set(p.id, p)

  const tally = new Map<number, Tally>()
  const edges = new Map<number, Map<number, number>>()
  const touch = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b) return
    let row = edges.get(a)
    if (!row) {
      row = new Map()
      edges.set(a, row)
    }
    row.set(b, (row.get(b) ?? 0) + 1)
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!isLand(world, i)) continue
      const pid = world.polityId[i]
      if (pid >= 0) {
        let t = tally.get(pid)
        if (!t) {
          t = { cells: 0, suit: 0, elev: 0 }
          tally.set(pid, t)
        }
        t.cells++
        const suit = world.suitability && world.suitability.length === n ? world.suitability[i] : 0
        const elev = world.elev && world.elev.length === n ? world.elev[i] : 0
        t.suit += Number.isFinite(suit) ? suit : 0
        t.elev += Number.isFinite(elev) ? elev : 0
      }
      const nx = x === w - 1 ? 0 : x + 1
      const ni = y * w + nx
      if (isLand(world, ni)) touch(pid, world.polityId[ni])
      if (y + 1 < h) {
        const ni = (y + 1) * w + x
        if (isLand(world, ni)) touch(world.polityId[i], world.polityId[ni])
      }
    }
  }

  // touch() already records one direction. Mirror so each kingdom sees the cut.
  for (const [a, row] of [...edges]) {
    for (const [b, count] of row) {
      let back = edges.get(b)
      if (!back) {
        back = new Map()
        edges.set(b, back)
      }
      if (!back.has(a)) back.set(a, count)
    }
  }

  const years = new Map<number, number>()
  for (const p of polities) {
    const t = tally.get(p.id)
    const cells = t?.cells ?? 0
    const mean = cells > 0 && t ? t.suit / cells : 0
    years.set(p.id, yearsBeforeNow(seed, p.id, cells, mean))
  }

  const neighboursOf = (id: number): Neighbour[] => {
    const row = edges.get(id)
    if (!row) return []
    const list: Neighbour[] = []
    for (const [nid, count] of row) {
      if (!byId.has(nid)) continue
      list.push({ id: nid, edges: count })
    }
    list.sort((a, b) => b.edges - a.edges || a.id - b.id)
    return list
  }

  const nameOf = (id: number): string => byId.get(id)?.name || 'a neighbour'

  const wonders = safeWonders(world)
  const wonderByPolity = new Map<number, string>()
  for (const wonder of wonders) {
    if (wonder.x < 0 || wonder.y < 0 || wonder.x >= w || wonder.y >= h) continue
    const pid = world.polityId[idx(w, wonder.x, wonder.y)]
    if (pid < 0 || wonderByPolity.has(pid)) continue
    wonderByPolity.set(pid, `${wonder.name} stands in this country.`)
  }

  const entries: ChronicleEntry[] = polities.map((p) => {
    const t = tally.get(p.id)
    const cells = t?.cells ?? 0
    const meanElev = cells > 0 && t ? t.elev / cells : 0
    const capI = p.capitalX >= 0 && p.capitalY >= 0 && p.capitalX < w && p.capitalY < h
      ? idx(w, p.capitalX, p.capitalY)
      : -1
    const capElev = capI >= 0 && world.elev && world.elev.length === n ? world.elev[capI] : 0
    const capBiome = capI >= 0 ? world.biome?.[capI] : undefined
    const highland =
      p.analog?.id === 'highland-plateau' ||
      capBiome === 'alpine' ||
      (Number.isFinite(capElev) && capElev >= 1600) ||
      (Number.isFinite(meanElev) && meanElev >= 1400)
    const coastal = capI >= 0 && nearSea(world, p.capitalX, p.capitalY, 2)
    const list = neighboursOf(p.id)
    const mine = years.get(p.id) ?? 0
    let older: Neighbour | null = null
    for (const nbor of list) {
      const ny = years.get(nbor.id) ?? 0
      if (ny <= mine) continue
      if (!older || ny > (years.get(older.id) ?? 0) || (ny === (years.get(older.id) ?? 0) && nbor.edges > older.edges)) {
        older = nbor
      }
    }
    const people = peopleLead(p.tradition)
    let origin: string
    if (highland) origin = originSentence(people, 'highland')
    else if (older) origin = originSentence(people, 'split', nameOf(older.id))
    else if (coastal) origin = originSentence(people, 'coast')
    else origin = originSentence(people, 'hold')

    const cut = list.find((nbor) => nbor.edges >= CLEAR_EDGE)
    const border = cut ? `The border was cut where ${nameOf(cut.id)} took the adjoining land.` : null
    return {
      polityId: p.id,
      yearsAgo: mine,
      origin,
      people,
      border,
      wonder: wonderByPolity.get(p.id) ?? null,
    }
  })

  const ruins = pickRuins(world, byId, nameOf)
  return { entries, ruins }
}

interface RuinCand {
  i: number
  score: number
  other: number
}

function pickRuins(world: World, byId: Map<number, Polity>, nameOf: (id: number) => string): ChronicleRuin[] {
  const { width: w, height: h, seed } = world.meta
  const n = w * h
  const blocked = new Uint8Array(n)
  for (const city of world.cities ?? []) {
    if (city.x < 0 || city.y < 0 || city.x >= w || city.y >= h) continue
    for (let dy = -1; dy <= 1; dy++) {
      const ny = city.y + dy
      if (ny < 0 || ny >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        blocked[ny * w + wrapX(city.x + dx, w)] = 1
      }
    }
  }

  const best: RuinCand[] = []
  const consider = (cand: RuinCand): void => {
    if (best.length < RUIN_POOL) {
      best.push(cand)
      return
    }
    let worst = 0
    for (let k = 1; k < best.length; k++) {
      if (best[k].score < best[worst].score || (best[k].score === best[worst].score && best[k].i > best[worst].i)) {
        worst = k
      }
    }
    if (cand.score > best[worst].score || (cand.score === best[worst].score && cand.i < best[worst].i)) {
      best[worst] = cand
    }
  }

  for (let i = 0; i < n; i++) {
    if (blocked[i] || !isLand(world, i)) continue
    const x = i % w
    const y = (i - x) / w
    const pid = world.polityId[i]
    let other = -1
    for (const [dx, dy] of N4) {
      const nx = wrapX(x + dx, w)
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const np = world.polityId[ny * w + nx]
      if (np < 0 || np === pid || !isLand(world, ny * w + nx)) continue
      const own = pid >= 0 ? byId.get(pid) : undefined
      const nb = byId.get(np)
      if (!own || !nb) continue
      const dOwn = wrapDist(x, y, own.capitalX, own.capitalY, w)
      const dNb = wrapDist(x, y, nb.capitalX, nb.capitalY, w)
      if (dNb + 0.5 < dOwn) other = np
    }
    const poor = poorCell(world, i)
    if (!poor && other < 0) continue
    if (pid >= 0) {
      const own = byId.get(pid)
      if (own && wrapDist(x, y, own.capitalX, own.capitalY, w) < 3) continue
    }
    const suit = world.suitability && world.suitability.length === n ? world.suitability[i] : 0.5
    let score = hash2(x, y, (seed >>> 0) ^ 0x51) * 0.05
    if (other >= 0) score += 5
    if (poor) score += 3
    if (Number.isFinite(suit) && suit < 0.12) score += 1
    consider({ i, score, other })
  }

  best.sort((a, b) => b.score - a.score || a.i - b.i)
  const picked: RuinCand[] = []
  for (const cand of best) {
    if (picked.length >= MAX_RUINS) break
    const x = cand.i % w
    const y = (cand.i - x) / w
    let spaced = true
    for (const prev of picked) {
      const px = prev.i % w
      const py = (prev.i - px) / w
      if (wrapDist(x, y, px, py, w) < MIN_RUIN_SPACING) {
        spaced = false
        break
      }
    }
    if (spaced) picked.push(cand)
  }
  if (!picked.length) return []

  const labels = labelLandmasses(world.mask, w, h, world.meta.threshold)
  const used = new Set<string>()
  return picked.map((cand) => {
    const x = cand.i % w
    const y = (cand.i - x) / w
    const pid = world.polityId[cand.i]
    const massId = labels.id[cand.i] ?? -1
    return {
      name: uniqueName(ruinName(x, y, seed), used),
      x,
      y,
      cause: ruinCause(world, cand.i, x, y, pid, cand.other, nameOf),
      landmass: massId >= 0 ? (labels.name[massId] ?? 'The land') : 'The land',
      polityId: pid,
    }
  })
}

function ruinCause(
  world: World,
  i: number,
  x: number,
  y: number,
  pid: number,
  other: number,
  nameOf: (id: number) => string,
): string {
  const { width: w } = world.meta
  if (pid >= 0) {
    const seat = (world.polities ?? []).find((p) => p.id === pid)
    if (seat && seat.capitalX >= 0 && seat.capitalY >= 0 && seat.capitalX < w && seat.capitalY < world.meta.height) {
      const si = idx(w, seat.capitalX, seat.capitalY)
      const seatRiver = (world.flux?.[si] ?? 0) > 12 || (world.rivers?.[si] ?? 0) > 0
      const hereRiver = (world.flux?.[i] ?? 0) > 12 || (world.rivers?.[i] ?? 0) > 0
      if (seatRiver && !hereRiver) return 'The seat moved to the river.'
    }
  }
  if (other >= 0) return `The border left it in ${nameOf(other)}.`
  const b = world.biome?.[i]
  if (b === 'hot-desert' || b === 'boreal-desert' || b === 'polar-desert') return 'The wells failed and the town was left.'
  if (b === 'ice' || b === 'alpine' || b === 'tundra') return 'The cold closed the road and the town was left.'
  if (nearSea(world, x, y, 1)) return 'The harbour silted and the town was left.'
  return 'The land went thin and the people left.'
}

/** Stamp `world.chronicle`. Does not touch the mask or the country grid. */
export function attachChronicle(world: World): void {
  world.chronicle = buildChronicle(world)
}
