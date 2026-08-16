/**
 * Canvas paint helpers for the editor shells.
 *
 * The authoritative state of the map lives in a `Float32Array` mask
 * (see `src/world/types.ts`). The HTML canvas is purely a view of that
 * mask — `renderMaskToCanvas` paints the entire mask onto the canvas
 * with one tile color per cell.
 *
 * Palette: paper-ink style `map-shell` theme. Pale blue for ocean,
 * soft tan for land. These matches the css `map-shell` background so
 * the canvas blends with the page.
 */

import type { WorldMeta } from '../world/types'

/** RGBA bytes for the land tile color (soft tan). */
const LAND_RGBA: readonly [number, number, number, number] = [0x8a, 0x7a, 0x5a, 0xff]
/** RGBA bytes for the ocean tile color (pale blue). */
const SEA_RGBA: readonly [number, number, number, number] = [0x8e, 0xb4, 0xc4, 0xff]

/**
 * Paint the full mask onto the canvas. One tile per cell, scaled to
 * the canvas's pixel dimensions. Cells below `meta.threshold` are
 * drawn as sea; cells at or above `meta.threshold` as land.
 *
 * No-op if the canvas has no 2D context. Callers should pass an
 * allocated mask; a null mask is treated as all-ocean.
 */
export function renderMaskToCanvas(
  canvas: HTMLCanvasElement,
  mask: Float32Array | null,
  meta: WorldMeta,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = meta.width
  const h = meta.height
  const cw = canvas.width
  const ch = canvas.height
  const cellW = cw / w
  const cellH = ch / h
  const fill = ctx.createImageData(cw, ch)
  const data = fill.data
  const threshold = meta.threshold
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const value = mask ? mask[i] : 0
      const c = value >= threshold ? LAND_RGBA : SEA_RGBA
      const px = Math.floor(x * cellW)
      const py = Math.floor(y * cellH)
      const pw = Math.ceil((x + 1) * cellW) - px
      const ph = Math.ceil((y + 1) * cellH) - py
      for (let dy = 0; dy < ph; dy++) {
        const row = py + dy
        const rowOff = row * cw
        for (let dx = 0; dx < pw; dx++) {
          const off = (rowOff + px + dx) * 4
          data[off] = c[0]
          data[off + 1] = c[1]
          data[off + 2] = c[2]
          data[off + 3] = c[3]
        }
      }
    }
  }
  ctx.putImageData(fill, 0, 0)
}

/**
 * True if any cell in the mask reaches `threshold`. Used to gate the
 * "Critique" button until the user has painted at least one dab of
 * land. A null mask is treated as "no land".
 */
export function hasAnyLand(mask: Float32Array | null, threshold: number): boolean {
  if (!mask) return false
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] >= threshold) return true
  }
  return false
}
