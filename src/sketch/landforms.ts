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

export type LandformKind = 'continents' | 'mixed' | 'islands'

export const LANDFORM_OPTIONS: readonly {
  id: LandformKind
  label: string
  desc: string
}[] = [
  {
    id: 'continents',
    label: 'Full continents',
    desc: 'A few large landmasses with gulfs',
  },
  {
    id: 'mixed',
    label: 'Continents & islands',
    desc: 'Big land plus smaller offshore islands',
  },
  {
    id: 'islands',
    label: 'Island world',
    desc: 'Scattered archipelagos',
  },
]

export function landformStampCopy(kind: LandformKind): string {
  if (kind === 'islands') return 'Island doodle stamped. Paint, erase, or Critique.'
  if (kind === 'mixed') return 'Continents and islands stamped. Paint, erase, or Critique.'
  return 'Continent doodle stamped. Paint, erase, or Critique.'
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
): void {
  const polarLo = Math.floor(h * 0.08)
  const polarHi = Math.ceil(h * 0.92)
  const padX = Math.ceil(rx * 2.2)
  const padY = Math.ceil(ry * 2.2)
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
      const e2 = (wx / Math.max(1, rx)) ** 2 + (wy / Math.max(1, ry)) ** 2
      const coast = fbm(x / 8, y / 8, seed + 63, 4)
      const gulfs = fbm(x / 6, y / 6, seed + 81, 3)
      const limit = 0.72 + coast * 0.55
      if (e2 > limit) continue
      if (gulfs > gulfCut && e2 > 0.28) continue
      const edge = Math.max(0, Math.min(1, (limit - e2) / 0.14))
      const v = 0.62 + 0.38 * edge
      const i = y * w + x
      if (v > mask[i]) mask[i] = v
    }
  }
}

function stampArchipelago(
  mask: Float32Array,
  w: number,
  h: number,
  seed: number,
  count: number,
  rxMin: number,
  rxMax: number,
  lon0 = 0,
  lon1 = 1,
): void {
  const rng = createRng(seed)
  const minR = Math.max(4, rxMin)
  const maxR = Math.max(minR + 1, rxMax)
  for (let n = 0; n < count; n++) {
    const cx = (lon0 + rng() * (lon1 - lon0)) * w
    const cy = (0.22 + rng() * 0.56) * h
    const rx = minR + rng() * (maxR - minR)
    const ry = rx * (0.55 + rng() * 0.5)
    stampBlob(mask, w, h, cx, cy, rx, ry, seed + n * 917, 0.9)
  }
}

/**
 * Add a landform doodle onto `mask` with Math.max (never wipes existing land).
 * Seeded from `seed` plus how much land is already there, so a second stamp
 * on the same ocean is a new mass instead of a no-op.
 */
export function stampLandform(
  mask: Float32Array,
  meta: WorldMeta,
  kind: LandformKind,
  seed: number,
): void {
  const w = meta.width
  const h = meta.height
  if (mask.length !== w * h || w < 8 || h < 8) return

  const salt = landCells(mask, meta.threshold)
  const s = (seed + salt * 1009) | 0

  if (kind === 'continents') {
    stampBlob(mask, w, h, 0.36 * w, 0.5 * h, 0.22 * w, 0.3 * h, s + 3, 0.78)
    stampBlob(mask, w, h, 0.72 * w, 0.42 * h, 0.13 * w, 0.2 * h, s + 17, 0.8)
    return
  }

  if (kind === 'mixed') {
    stampBlob(mask, w, h, 0.34 * w, 0.52 * h, 0.2 * w, 0.28 * h, s + 5, 0.78)
    stampArchipelago(mask, w, h, s + 41, 6, 0.018 * w, 0.04 * w, 0.58, 0.96)
    return
  }

  stampArchipelago(mask, w, h, s + 23, 11, 0.016 * w, 0.038 * w)
}

export function landformStats(
  mask: Float32Array,
  meta: WorldMeta,
): { landCells: number; components: number } {
  const stats = analyseComponents(mask, meta.width, meta.height, meta.threshold, 1)
  return { landCells: landCells(mask, meta.threshold), components: stats.areas.length }
}
