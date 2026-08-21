/**
 * Sketch-stage landform stamps — continent / island doodles the writer
 * can pick instead of painting every cell by hand.
 *
 * This is mask-only. Make sense still derives plates, mountains, climate.
 * Sketch may import `world/`; pipeline must not import this file.
 */

import { createRng, fbm } from '../world/noise'
import type { WorldMeta } from '../world/types'
import { analyseComponents } from './countBigComponents'

export const DEFAULT_CONTINENT_COUNT = 4
export const MIN_CONTINENT_COUNT = 1
export const MAX_CONTINENT_COUNT = 7

export function clampContinentCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONTINENT_COUNT
  return Math.max(MIN_CONTINENT_COUNT, Math.min(MAX_CONTINENT_COUNT, Math.round(n)))
}

export type LandformKind =
  | 'continents'
  | 'elongated'
  | 'peninsula'
  | 'gulf'
  | 'mixed'
  | 'islands'

export const LANDFORM_OPTIONS: readonly {
  id: LandformKind
  label: string
  desc: string
}[] = [
  {
    id: 'continents',
    label: 'Compact',
    desc: 'A round landmass',
  },
  {
    id: 'elongated',
    label: 'Long coast',
    desc: 'An east–west belt',
  },
  {
    id: 'peninsula',
    label: 'Peninsula',
    desc: 'A body with an arm',
  },
  {
    id: 'gulf',
    label: 'Gulf',
    desc: 'A C-shape with a bay',
  },
  {
    id: 'mixed',
    label: 'Continent & islands',
    desc: 'A mass with nearby islands',
  },
  {
    id: 'islands',
    label: 'Islands',
    desc: 'An archipelago',
  },
]

export function isLandformKind(value: string): value is LandformKind {
  return LANDFORM_OPTIONS.some((opt) => opt.id === value)
}

export function landformStampCopy(kind: LandformKind): string {
  void kind
  return 'Placed. Click it to shrink the same shape.'
}

function wrapDx(dx: number, w: number): number {
  if (dx > w / 2) dx -= w
  if (dx < -w / 2) dx += w
  return dx
}

function landCells(mask: Float32Array, threshold: number): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] >= threshold) n++
  return n
}

/**
 * Stamp one irregular land blob. Longitude wraps; polar bands stay ocean.
 * `shape` picks a silhouette; coast noise still raggeds the shore.
 */
function stampBlob(
  mask: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  gulfCut: number,
  shape: LandformKind = 'continents',
): void {
  const polarLo = Math.floor(h * 0.08)
  const polarHi = Math.ceil(h * 0.92)
  const padX = Math.ceil(rx * 2.4)
  const padY = Math.ceil(ry * 2.4)
  const y0 = Math.max(polarLo, Math.floor(cy - padY))
  const y1 = Math.min(polarHi, Math.ceil(cy + padY))
  const cxr = Math.round(cx)

  for (let y = y0; y < y1; y++) {
    for (let ox = -padX; ox <= padX; ox++) {
      const x = ((cxr + ox) % w + w) % w
      const dx = wrapDx(x - cx, w)
      const dy = y - cy
      const wx = dx + (fbm(x / 16, y / 14, seed + 11, 4) - 0.5) * rx * 1.15
      const wy = dy + (fbm(x / 14, y / 16, seed + 29, 4) - 0.5) * ry * 0.95
      const nx = wx / Math.max(1, rx)
      const ny = wy / Math.max(1, ry)
      const coast = fbm(x / 8, y / 8, seed + 63, 4)
      const gulfs = fbm(x / 6, y / 6, seed + 81, 3)
      if (!shapeHit(nx, ny, shape, coast, gulfs, gulfCut)) continue
      const e2 = nx * nx + ny * ny
      const edge = Math.max(0, Math.min(1, (1.05 - e2) / 0.18))
      const v = 0.62 + 0.38 * edge
      const i = y * w + x
      if (v > mask[i]) mask[i] = v
    }
  }
}

function shapeHit(
  nx: number,
  ny: number,
  shape: LandformKind,
  coast: number,
  gulfs: number,
  gulfCut: number,
): boolean {
  const e2 = nx * nx + ny * ny
  const ragged = 0.72 + coast * 0.55
  if (shape === 'elongated') {
    const e = nx * nx + ny * ny * 3.2
    return e < ragged && !(gulfs > gulfCut && e > 0.32)
  }
  if (shape === 'peninsula') {
    const body = nx * nx * 1.35 + ny * ny * 0.72 < ragged * 0.82
    const arm = ((nx - 0.52) / 0.58) ** 2 + ((ny - 0.58) / 1.05) ** 2 < 0.95 + coast * 0.2
    return body || arm
  }
  if (shape === 'gulf') {
    const bite = nx > 0.02 && nx < 1.05 && Math.abs(ny) < 0.4 + coast * 0.08 && e2 > 0.06
    return e2 < ragged && !bite && !(gulfs > gulfCut && e2 > 0.42)
  }
  return e2 < ragged && !(gulfs > gulfCut && e2 > 0.28)
}

function stampArchipelagoAround(
  mask: Float32Array,
  w: number,
  h: number,
  seed: number,
  cx: number,
  cy: number,
  count: number,
  rxMin: number,
  rxMax: number,
  orbit: number,
): void {
  const rng = createRng(seed)
  const minR = Math.max(4, rxMin)
  const maxR = Math.max(minR + 1, rxMax)
  const ring = Math.max(orbit, maxR * 2.4)
  for (let n = 0; n < count; n++) {
    const ang = (n / Math.max(1, count)) * Math.PI * 2 + rng() * 0.35
    const dist = ring * (0.85 + rng() * 0.45)
    const ix = ((cx + Math.cos(ang) * dist) % w + w) % w
    const iy = Math.max(h * 0.12, Math.min(h * 0.88, cy + Math.sin(ang) * dist * 0.62))
    const rx = minR + rng() * (maxR - minR)
    const ry = rx * (0.55 + rng() * 0.5)
    stampBlob(mask, w, h, ix, iy, rx, ry, seed + n * 917, 0.9, 'continents')
  }
}

/**
 * Place one landform doodle at `(cx, cy)`. Math.max onto existing land.
 * Does not scatter masses around the globe — the writer chooses the spot.
 */
/** Freeze the silhouette RNG so shrinking scale does not pick a new type. */
export function landformStampSeed(mask: Float32Array, threshold: number, planetSeed: number): number {
  return (planetSeed + landCells(mask, threshold) * 1009) | 0
}

export function stampLandformAt(
  mask: Float32Array,
  meta: WorldMeta,
  kind: LandformKind,
  seed: number,
  cx: number,
  cy: number,
  scale = 1,
  stampSeed?: number,
): void {
  const w = meta.width
  const h = meta.height
  if (mask.length !== w * h || w < 8 || h < 8) return
  const x = ((Math.round(cx) % w) + w) % w
  const y = Math.max(0, Math.min(h - 1, Math.round(cy)))
  const s = stampSeed ?? landformStampSeed(mask, meta.threshold, seed)
  const rng = createRng(s + 71)
  const k = Math.max(0.28, Math.min(1.4, scale))

  if (kind === 'continents') {
    const rx = (0.16 + rng() * 0.04) * w * k
    const ry = (0.22 + rng() * 0.05) * h * k
    stampBlob(mask, w, h, x, y, rx, ry, s, 0.76 + rng() * 0.08, 'continents')
    return
  }

  if (kind === 'elongated') {
    const rx = (0.24 + rng() * 0.04) * w * k
    const ry = (0.1 + rng() * 0.03) * h * k
    stampBlob(mask, w, h, x, y, rx, ry, s, 0.82, 'elongated')
    return
  }

  if (kind === 'peninsula') {
    const rx = (0.14 + rng() * 0.03) * w * k
    const ry = (0.24 + rng() * 0.04) * h * k
    stampBlob(mask, w, h, x, y, rx, ry, s, 0.88, 'peninsula')
    return
  }

  if (kind === 'gulf') {
    const rx = (0.17 + rng() * 0.03) * w * k
    const ry = (0.2 + rng() * 0.04) * h * k
    stampBlob(mask, w, h, x, y, rx, ry, s, 0.84, 'gulf')
    return
  }

  if (kind === 'mixed') {
    const rx = (0.12 + rng() * 0.04) * w * k
    const ry = (0.18 + rng() * 0.05) * h * k
    stampBlob(mask, w, h, x, y, rx, ry, s, 0.8 + rng() * 0.06, 'continents')
    stampArchipelagoAround(mask, w, h, s + 41, x, y, 4, 0.014 * w * k, 0.032 * w * k, rx * 1.55)
    return
  }

  stampArchipelagoAround(mask, w, h, s + 23, x, y, 6, 0.016 * w * k, 0.038 * w * k, 0.07 * w * k)
}

/** True if `(tx, ty)` sits in the same land blob as the click. */
export function landBlobContains(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): boolean {
  const w = width
  const h = height
  const start = ((Math.round(sx) % w) + w) % w + Math.max(0, Math.min(h - 1, Math.round(sy))) * w
  const goal = ((Math.round(tx) % w) + w) % w + Math.max(0, Math.min(h - 1, Math.round(ty))) * w
  if (start < 0 || start >= mask.length || mask[start] < threshold) return false
  if (mask[goal] < threshold) return false
  if (start === goal) return true
  const seen = new Uint8Array(mask.length)
  const queue = [start]
  seen[start] = 1
  while (queue.length) {
    const i = queue.pop() as number
    if (i === goal) return true
    const x = i % w
    const y = (i - x) / w
    const nbrs = [y * w + ((x + 1) % w), y * w + ((x - 1 + w) % w)]
    if (y > 0) nbrs.push((y - 1) * w + x)
    if (y < h - 1) nbrs.push((y + 1) * w + x)
    for (const j of nbrs) {
      if (seen[j] || mask[j] < threshold) continue
      seen[j] = 1
      queue.push(j)
    }
  }
  return false
}

/**
 * Shrink the land blob under `(sx, sy)` toward its centroid. Returns
 * false if the click missed land or the blob is already a speck.
 */
export function shrinkLandBlob(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  sx: number,
  sy: number,
  factor = 0.82,
): boolean {
  const w = width
  const h = height
  const seed = ((Math.round(sx) % w) + w) % w + Math.max(0, Math.min(h - 1, Math.round(sy))) * w
  if (seed < 0 || seed >= mask.length || mask[seed] < threshold) return false

  const seen = new Uint8Array(mask.length)
  const cells: number[] = []
  const queue = [seed]
  seen[seed] = 1
  let sumX = 0
  let sumY = 0
  while (queue.length) {
    const i = queue.pop() as number
    cells.push(i)
    const x = i % w
    const y = (i - x) / w
    sumX += x
    sumY += y
    const nbrs = [y * w + ((x + 1) % w), y * w + ((x - 1 + w) % w)]
    if (y > 0) nbrs.push((y - 1) * w + x)
    if (y < h - 1) nbrs.push((y + 1) * w + x)
    for (const j of nbrs) {
      if (seen[j] || mask[j] < threshold) continue
      seen[j] = 1
      queue.push(j)
    }
  }
  if (cells.length < 24) return false
  const cx = sumX / cells.length
  const cy = sumY / cells.length
  let maxD = 1
  const dist = new Float32Array(cells.length)
  for (let n = 0; n < cells.length; n++) {
    const i = cells[n]
    const x = i % w
    const y = (i - x) / w
    let dx = x - cx
    if (dx > w / 2) dx -= w
    if (dx < -w / 2) dx += w
    const d = Math.hypot(dx, y - cy)
    dist[n] = d
    if (d > maxD) maxD = d
  }
  const keep = maxD * Math.max(0.45, Math.min(0.95, factor))
  let cut = 0
  for (let n = 0; n < cells.length; n++) {
    if (dist[n] <= keep) continue
    mask[cells[n]] = Math.min(mask[cells[n]], threshold - 0.2)
    cut++
  }
  return cut > 0
}

/**
 * Stamp a landform at the map centre. Prefer `stampLandformAt` when the
 * writer has chosen a cell.
 */
export function stampLandform(
  mask: Float32Array,
  meta: WorldMeta,
  kind: LandformKind,
  seed: number,
  _continentCount: number = DEFAULT_CONTINENT_COUNT,
): void {
  void _continentCount
  stampLandformAt(mask, meta, kind, seed, meta.width / 2, meta.height / 2)
}

export function landformStats(
  mask: Float32Array,
  meta: WorldMeta,
): { landCells: number; components: number } {
  const stats = analyseComponents(mask, meta.width, meta.height, meta.threshold, 1)
  return { landCells: landCells(mask, meta.threshold), components: stats.areas.length }
}
