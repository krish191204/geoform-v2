/**
 * Stable physical names for a grounded world.
 *
 * Syllables match the city namer in worldbuild.ts. The seed is
 * `world.meta.seed` mixed with a feature key, so the same world always
 * prints the same short place-name. No lore.
 *
 * The caller does not mutate `world.mask`.
 */

import type { World } from '../world/types'
import { createRng } from '../world/types'
import { RIVER_THRESHOLD } from '../pipeline/hydrology'

/** Matches the atlas zoom cap in the shell. */
export const FEATURE_ZOOM_MAX = 6

export const LANDMASS_CAP = 8
export const RIVER_CAP = 6
export const RANGE_CAP = 6
export const LAKE_CAP = 4
export const FJORD_CAP = 4

/** High land, metres, before a boundary cluster counts as a range. */
const RANGE_ELEV_M = 1200

const PREFIX: readonly string[] = [
  'Bel', 'Cor', 'Dra', 'Fen', 'Gar', 'Hal', 'Ith', 'Jor', 'Kal', 'Lor',
  'Mor', 'Nes', 'Oth', 'Per', 'Quen', 'Ral', 'Str', 'Tor', 'Ul', 'Var',
  'Wen', 'Yor', 'Zar',
]

const SUFFIX: readonly string[] = [
  'mont', 'heim', 'gard', 'fen', 'rath', 'polis', 'mar', 'shire', 'dale',
  'crest', 'fell', 'wych', 'hold', 'run', 'minster', 'reach', 'brook',
  'keep', 'eyrie', 'fast',
]

export type FeatureKind = 'landmass' | 'river' | 'lake' | 'range' | 'fjord'

export interface FeatureName {
  kind: FeatureKind
  name: string
  /** Stable id mixed into the name seed. */
  key: string
  x: number
  y: number
  /** 0 is the largest or longest of this kind. */
  rank: number
  size: number
}

interface RawFeature {
  kind: FeatureKind
  key: string
  x: number
  y: number
  size: number
}

function mixSeed(seed: number, key: string): number {
  let h = (seed >>> 0) || 1
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x5bd1e995)
    h = (h ^ (h >>> 13)) >>> 0
  }
  return h >>> 0 || 1
}

function placeName(seed: number, key: string, used: Set<string>): string {
  const rng = createRng(mixSeed(seed, key))
  const prefix = PREFIX[Math.floor(rng() * PREFIX.length)] ?? 'Bel'
  let si = Math.floor(rng() * SUFFIX.length)
  let name = prefix + (SUFFIX[si] ?? 'mont')
  for (let n = 0; n < SUFFIX.length && used.has(name); n++) {
    si = (si + 1) % SUFFIX.length
    name = prefix + SUFFIX[si]
  }
  if (used.has(name)) name = `${name}${used.size + 2}`
  used.add(name)
  return name
}

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function isLand(mask: Float32Array, i: number, threshold: number): boolean {
  return mask[i] >= threshold
}

interface Component {
  cells: number[]
  minIndex: number
  size: number
  x: number
  y: number
  peak: number
  peakX: number
  peakY: number
}

function flood(
  width: number,
  height: number,
  accept: (i: number) => boolean,
  weight: (i: number) => number,
  eight: boolean,
): Component[] {
  const n = width * height
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  const out: Component[] = []
  for (let seed = 0; seed < n; seed++) {
    if (seen[seed] || !accept(seed)) continue
    let head = 0
    let tail = 0
    queue[tail++] = seed
    seen[seed] = 1
    const cells: number[] = []
    let minIndex = seed
    let size = 0
    const x0 = seed % width
    let sx = 0
    let sy = 0
    let peak = -Infinity
    let peakX = x0
    let peakY = Math.floor(seed / width)
    while (head < tail) {
      const i = queue[head++]
      cells.push(i)
      if (i < minIndex) minIndex = i
      const w = weight(i)
      size += w
      const x = i % width
      const y = (i - x) / width
      let dx = x - x0
      if (dx > width / 2) dx -= width
      if (dx < -width / 2) dx += width
      sx += dx
      sy += y
      if (w > peak) {
        peak = w
        peakX = x
        peakY = y
      }
      const steps = eight
        ? [
            [-1, 0], [1, 0], [0, -1], [0, 1],
            [-1, -1], [1, -1], [-1, 1], [1, 1],
          ]
        : [
            [-1, 0], [1, 0], [0, -1], [0, 1],
          ]
      for (const [ox, oy] of steps) {
        const ny = y + oy
        if (ny < 0 || ny >= height) continue
        const j = ny * width + wrapX(x + ox, width)
        if (seen[j] || !accept(j)) continue
        seen[j] = 1
        queue[tail++] = j
      }
    }
    const count = cells.length
    const cx = wrapX(x0 + sx / count, width)
    const cy = sy / count
    out.push({
      cells,
      minIndex,
      size,
      x: cx,
      y: cy,
      peak: Number.isFinite(peak) ? peak : 0,
      peakX,
      peakY,
    })
  }
  return out
}

function rank(raw: RawFeature[], cap: number): RawFeature[] {
  raw.sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return raw.slice(0, cap)
}

function landmasses(world: World): RawFeature[] {
  const { width, height, threshold } = world.meta
  const mask = world.mask
  const comps = flood(
    width,
    height,
    (i) => isLand(mask, i, threshold),
    () => 1,
    false,
  )
  return rank(
    comps.map((c) => ({
      kind: 'landmass' as const,
      key: `land:${c.minIndex}`,
      x: c.x,
      y: c.y,
      size: c.size,
    })),
    LANDMASS_CAP,
  )
}

function rivers(world: World): RawFeature[] {
  const { width, height, threshold } = world.meta
  const flux = world.flux
  const mask = world.mask
  if (!flux || flux.length < width * height) return []
  const comps = flood(
    width,
    height,
    (i) => isLand(mask, i, threshold) && flux[i] > RIVER_THRESHOLD,
    () => 1,
    true,
  )
  return rank(
    comps.map((c) => ({
      kind: 'river' as const,
      key: `river:${c.minIndex}`,
      x: c.peakX,
      y: c.peakY,
      size: c.size,
    })),
    RIVER_CAP,
  )
}

function lakes(world: World): RawFeature[] {
  const field = world.lakes
  const { width, height } = world.meta
  if (!field || field.length < width * height) return []
  const comps = flood(
    width,
    height,
    (i) => field[i] === 1,
    () => 1,
    false,
  )
  return rank(
    comps.map((c) => ({
      kind: 'lake' as const,
      key: `lake:${c.minIndex}`,
      x: c.x,
      y: c.y,
      size: c.size,
    })),
    LAKE_CAP,
  )
}

function nearPlateBoundary(world: World, i: number): boolean {
  const { width, height } = world.meta
  const plate = world.plateId
  if (!plate || plate.length < width * height) return false
  const mine = plate[i]
  const x = i % width
  const y = (i - x) / width
  const nbs = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ]
  for (const [nx, ny] of nbs) {
    if (ny < 0 || ny >= height) continue
    const j = ny * width + wrapX(nx, width)
    if (plate[j] !== mine) return true
  }
  return false
}

function ranges(world: World): RawFeature[] {
  const { width, height, threshold } = world.meta
  const plate = world.plateId
  const elev = world.elev
  if (!plate || plate.length < width * height || !elev || elev.length < width * height) return []
  const mask = world.mask
  const comps = flood(
    width,
    height,
    (i) =>
      isLand(mask, i, threshold) &&
      elev[i] >= RANGE_ELEV_M &&
      nearPlateBoundary(world, i),
    (i) => elev[i],
    false,
  )
  return rank(
    comps.map((c) => ({
      kind: 'range' as const,
      key: `range:${c.minIndex}`,
      x: c.peakX,
      y: c.peakY,
      size: c.peak,
    })),
    RANGE_CAP,
  )
}

function iceCell(world: World, i: number, n: number): boolean {
  if (world.biome && world.biome[i] === 'ice') return true
  const ice = (world as World & { ice?: Uint8Array }).ice
  return Boolean(ice && ice.length >= n && ice[i])
}

function coastCell(world: World, i: number): boolean {
  const { width, height, threshold } = world.meta
  const x = i % width
  const y = (i - x) / width
  const nbs = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ]
  for (const [nx, ny] of nbs) {
    if (ny < 0 || ny >= height) continue
    const j = ny * width + wrapX(nx, width)
    if (!isLand(world.mask, j, threshold)) return true
  }
  return false
}

function fjords(world: World): RawFeature[] {
  const { width, height, threshold } = world.meta
  const n = width * height
  if (!world.mask || world.mask.length < n) return []
  const mouths: number[] = []
  for (let i = 0; i < n; i++) {
    if (!isLand(world.mask, i, threshold)) continue
    if (!iceCell(world, i, n) || !coastCell(world, i)) continue
    mouths.push(i)
  }
  if (mouths.length === 0) return []
  // Short mouths: keep separated coastal ice cells, not a whole ice sheet.
  const picked: number[] = []
  const minSep = 3
  for (const i of mouths) {
    const x = i % width
    const y = (i - x) / width
    const crowded = picked.some((p) => {
      const px = p % width
      let dx = Math.abs(x - px)
      if (dx > width / 2) dx = width - dx
      const py = Math.floor(p / width)
      return Math.max(dx, Math.abs(y - py)) < minSep
    })
    if (crowded) continue
    picked.push(i)
    if (picked.length >= FJORD_CAP) break
  }
  return picked.map((i) => {
    const x = i % width
    const y = (i - x) / width
    return {
      kind: 'fjord' as const,
      key: `fjord:${i}`,
      x,
      y,
      size: 1,
    }
  })
}

/**
 * Catalog of physical names. Safe on an empty or partial world.
 * Does not write `world.mask` or any other field.
 */
export function namePhysicalFeatures(world: World): FeatureName[] {
  if (!world?.meta) return []
  const { width, height, seed } = world.meta
  if (!(width > 0) || !(height > 0)) return []
  const n = width * height
  if (!world.mask || world.mask.length < n) return []

  const raw = [
    ...landmasses(world),
    ...rivers(world),
    ...lakes(world),
    ...ranges(world),
    ...fjords(world),
  ]
  const used = new Set<string>()
  const byKind = new Map<FeatureKind, number>()
  return raw.map((f) => {
    const rank = byKind.get(f.kind) ?? 0
    byKind.set(f.kind, rank + 1)
    return {
      kind: f.kind,
      name: placeName(seed, f.key, used),
      key: f.key,
      x: f.x,
      y: f.y,
      rank,
      size: f.size,
    }
  })
}

/**
 * Zoom near 1 shows only the largest landmass and the longest river.
 * Toward {@link FEATURE_ZOOM_MAX}: ranges, lakes, then smaller rivers and bays.
 */
export function featureMinZoom(feature: FeatureName): number {
  if (feature.kind === 'landmass') return feature.rank === 0 ? 1 : 2.5
  if (feature.kind === 'river') return feature.rank === 0 ? 1 : 4.8
  if (feature.kind === 'range') return 2.2
  if (feature.kind === 'lake') return 3.4
  return 5.2
}

export function featuresAtZoom(features: readonly FeatureName[], zoom: number): FeatureName[] {
  const z = Number.isFinite(zoom) ? zoom : 1
  return features.filter((f) => z + 1e-6 >= featureMinZoom(f))
}
