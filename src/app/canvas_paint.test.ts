// @vitest-environment happy-dom
// happy-dom 15.x doesn't include ImageData in its global. Polyfill.
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  class ImageDataPolyfill {
    public data: Uint8ClampedArray
    public width: number
    public height: number
    public colorSpace = 'srgb' as const
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  }
  ;(globalThis as { ImageData: unknown }).ImageData = ImageDataPolyfill
}

/**
 * Tests for the canvas paint helpers.
 *
 * Covers the two public entry points:
 *   - `renderMaskToCanvas` — paints the mask onto the canvas.
 *   - `hasAnyLand` — true iff any cell reaches the threshold.
 *
 * The canvas is read back via `getImageData` to verify the correct
 * RGBA pane was written for each cell.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { renderMaskToCanvas, hasAnyLand } from './canvas_paint'
import { DEFAULT_META, type WorldMeta } from '../world/types'

/**
 * Build a small canvas (no DOM-mount) for testing.
 *
 * happy-dom 15.x does not implement `HTMLCanvasElement.getContext('2d')`,
 * so we install a minimal in-memory 2D context mock backed by a single
 * Uint8ClampedArray. The mock implements just enough of CanvasRenderingContext2D
 * to let `renderMaskToCanvas` write pixels via `createImageData` /
 * `putImageData` and let the test read them back via `getImageData`.
 */
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h

  // Single backing buffer for the whole canvas. putImageData writes into
  // it at (x, y); getImageData reads a slice back out.
  const buffer = new Uint8ClampedArray(w * h * 4)

  const makeImageData = (iw: number, ih: number) => ({
    data: new Uint8ClampedArray(iw * ih * 4),
    width: iw,
    height: ih,
    colorSpace: 'srgb' as const,
  })

  const ctx = {
    createImageData(iw: number, ih: number) {
      return makeImageData(iw, ih)
    },
    putImageData(
      img: { data: Uint8ClampedArray; width: number; height: number },
      x: number,
      y: number,
    ) {
      for (let row = 0; row < img.height; row++) {
        const dst = (y + row) * w * 4 + x * 4
        const src = row * img.width * 4
        // Copy a whole row of RGBA pixels in one shot.
        buffer.set(img.data.subarray(src, src + img.width * 4), dst)
      }
    },
    getImageData(x: number, y: number, iw: number, ih: number) {
      const out = new Uint8ClampedArray(iw * ih * 4)
      for (let row = 0; row < ih; row++) {
        const src = (y + row) * w * 4 + x * 4
        const dst = row * iw * 4
        out.set(buffer.subarray(src, src + iw * 4), dst)
      }
      return { data: out, width: iw, height: ih, colorSpace: 'srgb' as const }
    },
  }

  // Override the prototype method on this instance so `getContext('2d')`
  // returns our mock. happy-dom's default returns null, which causes
  // `pixelAt` to throw "no 2d context".
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext']
  return canvas
}

/** Read the rgba at (x, y) from the canvas. */
function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const d = ctx.getImageData(x, y, 1, 1).data
  return [d[0]!, d[1]!, d[2]!, d[3]!]
}

function rgba(values: readonly number[]): readonly [number, number, number, number] {
  return [values[0]!, values[1]!, values[2]!, values[3]!]
}

const LAND = rgba([0x8a, 0x7a, 0x5a, 0xff])
const SEA = rgba([0x8e, 0xb4, 0xc4, 0xff])

describe('renderMaskToCanvas', () => {
  let canvas: HTMLCanvasElement
  let meta: WorldMeta

  beforeEach(() => {
    canvas = makeCanvas(8, 4)
    meta = { ...DEFAULT_META, width: 4, height: 2, threshold: 0.5 }
  })

  it('paints a null mask as all ocean', () => {
    renderMaskToCanvas(canvas, null, meta)
    // sample (0, 0) — top-left cell
    expect(pixelAt(canvas, 0, 0)).toEqual([...SEA])
  })

  it('paints a mask with no land as all ocean', () => {
    const mask = new Float32Array(meta.width * meta.height) // all zeros
    renderMaskToCanvas(canvas, mask, meta)
    expect(pixelAt(canvas, 1, 1)).toEqual([...SEA])
  })

  it('paints a single land cell with the land color', () => {
    const mask = new Float32Array(meta.width * meta.height)
    mask[1] = 0.9 // cell (1, 0) — top row, second column
    renderMaskToCanvas(canvas, mask, meta)
    // cell (1, 0): width 8 px / 4 cols = 2 px per col, height 4 px / 2 rows = 2 px per row
    // top-left pixel of cell (1, 0) is (2, 0)
    expect(pixelAt(canvas, 2, 0)).toEqual([...LAND])
    // ensure neighbouring cells stay ocean
    expect(pixelAt(canvas, 0, 0)).toEqual([...SEA])
    expect(pixelAt(canvas, 2, 2)).toEqual([...SEA])
  })

  it('respects the threshold — values below stay sea', () => {
    const mask = new Float32Array(meta.width * meta.height)
    mask[0] = 0.49 // just below threshold 0.5
    renderMaskToCanvas(canvas, mask, meta)
    expect(pixelAt(canvas, 0, 0)).toEqual([...SEA])
  })

  it('tolerates a non-square canvas', () => {
    const wide = makeCanvas(100, 10)
    const m = new Float32Array(meta.width * meta.height)
    m[3] = 1.0 // cell (3, 0)
    renderMaskToCanvas(wide, m, meta)
    // cell (3, 0) maps to pixel x ∈ [75, 100), y ∈ [0, 5)
    expect(pixelAt(wide, 80, 2)).toEqual([...LAND])
  })
})

describe('hasAnyLand', () => {
  it('returns false for null mask', () => {
    expect(hasAnyLand(null, 0.5)).toBe(false)
  })
  it('returns false for an all-zero mask', () => {
    const mask = new Float32Array(16)
    expect(hasAnyLand(mask, 0.5)).toBe(false)
  })
  it('returns true when any cell meets the threshold', () => {
    const mask = new Float32Array(16)
    mask[7] = 0.6
    expect(hasAnyLand(mask, 0.5)).toBe(true)
  })
  it('returns false when all cells are below the threshold', () => {
    const mask = new Float32Array(16)
    mask.fill(0.4)
    expect(hasAnyLand(mask, 0.5)).toBe(false)
  })
  it('respects the threshold boundary', () => {
    const mask = new Float32Array(16)
    mask[0] = 0.5 // exactly at threshold
    expect(hasAnyLand(mask, 0.5)).toBe(true)
  })
})
