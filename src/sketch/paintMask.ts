/**
 * Mask brush primitive: stamp a soft circular dab onto a Float32 mask.
 *
 * This is the only brush logic in v1. The mask is "is land" — heights are
 * derived downstream by Make-sense, never painted here.
 */

export type PaintMode = 'draw-land' | 'erase-land'

export interface PaintResult {
  /** Number of cells whose mask value actually changed. */
  mutatedCells: number
  /** Absolute sum of the per-cell mask deltas (for coach provenance). */
  maskDelta: number
}

/**
 * Paint a circular dab onto `mask`.
 *
 * - `cx`, `cy` are pixel coordinates (floats; nearest-pixel center).
 * - `radius` is in pixels.
 * - `strength` is 0..1; multiplied by a smooth falloff before being
 *   added or subtracted from the mask.
 * - Cells outside `[0, width) × [0, height)` are skipped.
 *
 * Falloff is cosine: smooth, easy to invert, no ringing.
 */
export function paintMask(
  mask: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  mode: PaintMode,
): PaintResult {
  const r = Math.max(0, radius)
  if (r === 0 || strength <= 0) {
    return { mutatedCells: 0, maskDelta: 0 }
  }

  const xMin = Math.max(0, Math.floor(cx - r))
  const xMax = Math.min(width - 1, Math.ceil(cx + r))
  const yMin = Math.max(0, Math.floor(cy - r))
  const yMax = Math.min(height - 1, Math.ceil(cy + r))

  if (xMin > xMax || yMin > yMax) {
    return { mutatedCells: 0, maskDelta: 0 }
  }

  let mutatedCells = 0
  let maskDelta = 0

  for (let y = yMin; y <= yMax; y++) {
    const dy = y - cy
    for (let x = xMin; x <= xMax; x++) {
      const dx = x - cx
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > r) continue

      // Cosine falloff: 1 at center, 0 at radius, C1-continuous at the edge.
      const t = dist / r // 0..1
      const falloff = 0.5 * (1 + Math.cos(Math.PI * t))

      const delta = falloff * strength
      const i = y * width + x
      const before = mask[i]
      let after: number

      if (mode === 'draw-land') {
        after = Math.min(1, before + delta)
      } else {
        after = Math.max(0, before - delta)
      }

      const change = after - before
      if (change !== 0) {
        mask[i] = after
        mutatedCells++
        maskDelta += Math.abs(change)
      }
    }
  }

  return { mutatedCells, maskDelta }
}