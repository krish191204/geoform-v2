/**
 * Public API for the Sketch stage.
 *
 * Sketch is mask-only: the writer paints "this cell is land" or
 * "this cell is sea." Heights are derived downstream by Make-sense
 * and are not user-paintable in v1.
 *
 * The shell holds one `MaskBrushes` instance per sketch. The brushes
 * keep a reference to the in-flight mask (set via `bindMask`) so
 * top-level actions like `clearSea` don't need the shell to thread
 * the mask through every call.
 */

import type { WorldMeta } from '../world/types'
import { DEFAULT_META } from '../world/types'
import { paintMask } from './paintMask'
import type { PaintMode, PaintResult } from './paintMask'
import { clearSea } from './eraseMask'
import { countBigComponents } from './countBigComponents'

export interface DabArgs {
  mask: Float32Array
  meta: WorldMeta
  cx: number
  cy: number
  /** 1..64 pixels. */
  brushSize: number
  /** 0..1. */
  strength: number
  tool: PaintMode
}

export interface MaskBrushes {
  /** Stamp a single brush dab into the mask. */
  dab(args: DabArgs): PaintResult

  /** Bulk action: clear everything below the threshold. */
  clearSea(): { clearedCells: number; autopilotTriggered: boolean }

  /** The mask threshold used by `clearSea` and component counting. */
  pickThreshold(): number

  /** Set the mask threshold (default 0.5). */
  setThreshold(value: number): void

  /** Coach hook fired on every brush dab (for live provenance). */
  onBrushDab?: (e: {
    x: number
    y: number
    brushSize: number
    maskDelta: number
  }) => void

  /** Coach hook fired when Sketch commits. */
  onCommit?: (e: {
    metaSeed: number
    metaWidth: number
    metaHeight: number
    maskArea: number
    bigComponents: number
    threshold: number
  }) => void
}

/** Coercion helper: clamp brush size into the documented 1..64 range. */
function clampBrushSize(size: number): number {
  if (size < 1) return 1
  if (size > 64) return 64
  return size
}

/** Coercion helper: clamp strength into 0..1. */
function clampStrength(s: number): number {
  if (s < 0) return 0
  if (s > 1) return 1
  return s
}

/** Coercion helper: clamp threshold into 0..1. */
function clampThreshold(t: number): number {
  if (t < 0) return 0
  if (t > 1) return 1
  return t
}

/** Default minimum "big" component area, in pixels. About a 10×10 blob. */
export const DEFAULT_MIN_BIG_AREA = 100

/** Mutable state shared between a brushes instance and its bind helper. */
interface BrushesState {
  threshold: number
  minBigArea: number
  mask: Float32Array | null
}

/**
 * Factory: build a `MaskBrushes` instance. Returns the brushes plus a
 * `bindMask` function the shell calls once per sketch session to attach
 * the in-flight mask.
 */
export function createMaskBrushes(): {
  brushes: MaskBrushes
  bindMask: (mask: Float32Array) => void
} {
  const state: BrushesState = {
    threshold: DEFAULT_META.threshold,
    minBigArea: DEFAULT_MIN_BIG_AREA,
    mask: null,
  }

  const brushes: MaskBrushes = {
    dab({ mask, meta, cx, cy, brushSize, strength, tool }) {
      const size = clampBrushSize(brushSize)
      const s = clampStrength(strength)
      const result = paintMask(
        mask,
        meta.width,
        meta.height,
        cx,
        cy,
        size,
        s,
        tool,
      )
      if (result.mutatedCells > 0 && brushes.onBrushDab) {
        brushes.onBrushDab({
          x: cx,
          y: cy,
          brushSize: size,
          maskDelta: result.maskDelta,
        })
      }
      return result
    },

    clearSea() {
      if (!state.mask) {
        return { clearedCells: 0, autopilotTriggered: false }
      }
      return clearSea(state.mask, state.threshold)
    },

    pickThreshold() {
      return state.threshold
    },

    setThreshold(value: number) {
      state.threshold = clampThreshold(value)
    },

    onBrushDab: undefined,
    onCommit: undefined,
  }

  const bindMask = (mask: Float32Array): void => {
    state.mask = mask
  }

  return { brushes, bindMask }
}

/**
 * Compute the mask area at or above the threshold.
 * Convenience helper used by the commit hook.
 */
export function maskAreaAbove(
  mask: Float32Array,
  threshold: number,
): number {
  let area = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] >= threshold) area++
  }
  return area
}

/**
 * Fire the `onCommit` coach hook with the standard payload.
 */
export function fireCommitHook(
  brushes: MaskBrushes,
  meta: WorldMeta,
  mask: Float32Array,
): void {
  const area = maskAreaAbove(mask, brushes.pickThreshold())
  const big = countBigComponents(
    mask,
    meta.width,
    meta.height,
    brushes.pickThreshold(),
    DEFAULT_MIN_BIG_AREA,
  )
  brushes.onCommit?.({
    metaSeed: meta.seed,
    metaWidth: meta.width,
    metaHeight: meta.height,
    maskArea: area,
    bigComponents: big,
    threshold: brushes.pickThreshold(),
  })
}

export { countBigComponents }