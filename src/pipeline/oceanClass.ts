/**
 * Inspector-first ocean classes from SST and coast distance.
 *
 * Biome keeps one ocean colour. Relief may tint shelf, ice-edge, and storms.
 */

import { idx, wrapX } from './helpers'

export type OceanClass = 'ice-edge' | 'shelf' | 'open'

/** Summer SST (°C) at or below which polar sea ice is plausible. */
export const ICE_EDGE_SST_C = 0

/** Cells of land within this Chebyshev radius count as continental shelf. */
export const SHELF_RADIUS = 3

export function classifyOcean(
  mask: Float32Array,
  summer: Float32Array,
  width: number,
  height: number,
  threshold: number,
  x: number,
  y: number,
): OceanClass | null {
  const i = idx(width, x, y)
  if (mask[i] >= threshold) return null
  if (summer[i] <= ICE_EDGE_SST_C) return 'ice-edge'
  for (let dy = -SHELF_RADIUS; dy <= SHELF_RADIUS; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= height) continue
    for (let dx = -SHELF_RADIUS; dx <= SHELF_RADIUS; dx++) {
      const nx = wrapX(x + dx, width)
      if (mask[idx(width, nx, ny)] >= threshold) return 'shelf'
    }
  }
  return 'open'
}
