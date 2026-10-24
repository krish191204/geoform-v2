// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bakeLithologyRaster, toImageData, type RasterRGBA } from './geologyRaster'

const PALETTE: Record<number, string> = { 1: '#d08040', 2: '#4080d0' }

function px(r: RasterRGBA, x: number, y: number): [number, number, number, number] {
  const o = (y * r.width + x) * 4
  return [r.data[o], r.data[o + 1], r.data[o + 2], r.data[o + 3]]
}

function isInk([r, g, b, a]: [number, number, number, number]): boolean {
  return a > 0 && Math.max(r, g, b) < 90
}

function grid(w: number, h: number, code: (x: number, y: number) => number, land: (x: number, y: number) => number) {
  const lith = new Uint8Array(w * h)
  const mask = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      lith[y * w + x] = code(x, y)
      mask[y * w + x] = land(x, y)
    }
  }
  return { lith, mask }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bakeLithologyRaster', () => {
  it('outputs w*px by h*px pixels', () => {
    const { lith, mask } = grid(5, 3, () => 1, () => 1)
    const r4 = bakeLithologyRaster(lith, mask, 0.5, 5, 3, PALETTE)
    expect(r4.width).toBe(20)
    expect(r4.height).toBe(12)
    expect(r4.data.length).toBe(20 * 12 * 4)
    const r2 = bakeLithologyRaster(lith, mask, 0.5, 5, 3, PALETTE, 2)
    expect(r2.width).toBe(10)
    expect(r2.height).toBe(6)
    expect(r2.data.length).toBe(10 * 6 * 4)
  })

  it('leaves an all-ocean grid fully transparent', () => {
    const { lith, mask } = grid(6, 4, () => 0, () => 0)
    const r = bakeLithologyRaster(lith, mask, 0.5, 6, 4, PALETTE)
    for (let i = 3; i < r.data.length; i += 4) expect(r.data[i]).toBe(0)
  })

  it('paints both palette colours and an ink contact between two rock units', () => {
    const { lith, mask } = grid(4, 2, (x) => (x < 2 ? 1 : 2), () => 1)
    const r = bakeLithologyRaster(lith, mask, 0.5, 4, 2, PALETTE)
    const near = (c: [number, number, number, number], rgb: [number, number, number]) =>
      Math.abs(c[0] - rgb[0]) <= 2 && Math.abs(c[1] - rgb[1]) <= 2 && Math.abs(c[2] - rgb[2]) <= 2 && c[3] === 235
    let sawA = false
    let sawB = false
    let sawInk = false
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const c = px(r, x, y)
        if (near(c, [0xd0, 0x80, 0x40])) sawA = true
        if (near(c, [0x40, 0x80, 0xd0])) sawB = true
        if (isInk(c)) sawInk = true
      }
    }
    expect(sawA).toBe(true)
    expect(sawB).toBe(true)
    expect(sawInk).toBe(true)
    expect(isInk(px(r, 7, 2))).toBe(true)
    expect(isInk(px(r, 8, 2))).toBe(true)
    expect(isInk(px(r, 5, 2))).toBe(false)
  })

  it('does not mutate lith or mask', () => {
    const { lith, mask } = grid(4, 3, (x, y) => ((x + y) % 3), (x) => x / 3)
    const lithCopy = lith.slice()
    const maskCopy = mask.slice()
    bakeLithologyRaster(lith, mask, 0.4, 4, 3, PALETTE)
    expect(Array.from(lith)).toEqual(Array.from(lithCopy))
    expect(Array.from(mask)).toEqual(Array.from(maskCopy))
  })

  it('wraps across x so the x=0 cell reaches the right edge', () => {
    const palette = { 1: '#ff0000', 2: '#0000ff' }
    const { lith, mask } = grid(4, 1, (x) => (x === 0 ? 1 : 2), () => 1)
    const r = bakeLithologyRaster(lith, mask, 0.5, 4, 1, palette)
    const edge = px(r, 14, 1)
    expect(edge[3]).toBe(235)
    expect(edge[0]).toBeGreaterThan(10)
    expect(isInk(px(r, 15, 1))).toBe(true)
    expect(px(r, 1, 1)[2]).toBeGreaterThan(10)
  })

  it('bakes a 768x384 grid at 2 px per cell quickly', () => {
    const w = 768
    const h = 384
    const { lith, mask } = grid(
      w,
      h,
      (x, y) => 1 + (((x >> 4) + (y >> 3)) % 2),
      (x, y) => 0.5 + 0.5 * Math.sin(x * 0.05) * Math.cos(y * 0.07),
    )
    const t0 = performance.now()
    const r = bakeLithologyRaster(lith, mask, 0.5, w, h, PALETTE, 2)
    const ms = performance.now() - t0
    expect(r.width).toBe(w * 2)
    expect(ms).toBeLessThan(1000)
  })
})

describe('toImageData', () => {
  it('returns null when ImageData is undefined', () => {
    vi.stubGlobal('ImageData', undefined)
    const { lith, mask } = grid(2, 2, () => 1, () => 1)
    expect(toImageData(bakeLithologyRaster(lith, mask, 0.5, 2, 2, PALETTE))).toBeNull()
  })

  it('copies the raster into an ImageData when available', () => {
    class FakeImageData {
      data: Uint8ClampedArray
      constructor(public width: number, public height: number) {
        this.data = new Uint8ClampedArray(width * height * 4)
      }
    }
    vi.stubGlobal('ImageData', FakeImageData)
    const { lith, mask } = grid(2, 2, () => 1, () => 1)
    const raster = bakeLithologyRaster(lith, mask, 0.5, 2, 2, PALETTE)
    const image = toImageData(raster)
    expect(image).not.toBeNull()
    expect(image!.width).toBe(raster.width)
    expect(Array.from(image!.data)).toEqual(Array.from(raster.data))
  })
})
