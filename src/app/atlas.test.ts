if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  class ImageDataPolyfill {
    public data: Uint8ClampedArray
    public width: number
    public height: number
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
      this.data = new Uint8ClampedArray(width * height * 4)
    }
  }
  ;(globalThis as { ImageData: unknown }).ImageData = ImageDataPolyfill
}

import { describe, expect, it } from 'vitest'
import { DEFAULT_META } from '../world/types'
import { atlasBakeWidth, bakeSketchMaskImageData, LAYER_CHIPS } from './atlas'

function rgb(image: ImageData, x: number, y: number): [number, number, number] {
  const i = (y * image.width + x) * 4
  return [image.data[i], image.data[i + 1], image.data[i + 2]]
}

describe('atlasBakeWidth', () => {
  it('oversamples the Geoform 1 HD grid then caps at 4096', () => {
    expect(atlasBakeWidth(1600, 768)).toBe(3072)
    expect(atlasBakeWidth(5000, 768)).toBe(4096)
    expect(atlasBakeWidth(200, 64)).toBe(256)
    expect(atlasBakeWidth(1600, 768, true)).toBe(768)
  })

  it('matches Geoform 1 published-build raster budget so Vercel stays interactive', () => {
    expect(atlasBakeWidth(1600, 768, { prod: true, gridH: 384 })).toBe(1536)
    expect(atlasBakeWidth(1600, 768, { preview: true, prod: true, gridH: 384 })).toBe(768)
  })
})

describe('LAYER_CHIPS', () => {
  it('states one message per layer so chips do not hide climate under prettier green', () => {
    expect(LAYER_CHIPS.map((c) => c.id)).toEqual([
      'relief',
      'biome',
      'moisture',
      'temperature',
      'suitability',
      'plates',
      'elevation',
    ])
    for (const chip of LAYER_CHIPS) {
      expect(chip.title.length).toBeGreaterThan(8)
    }
    expect(LAYER_CHIPS.find((c) => c.id === 'temperature')?.title).toMatch(/temperature/i)
    expect(LAYER_CHIPS.find((c) => c.id === 'elevation')?.title).toMatch(/metres/i)
  })
})

describe('Sketch mask bake', () => {
  const meta = { ...DEFAULT_META, width: 8, height: 4, threshold: 0.5 }

  it('keeps empty Sketch ocean dark, varied, and deterministic', () => {
    const first = bakeSketchMaskImageData(null, meta, 64, 32)
    const second = bakeSketchMaskImageData(null, meta, 64, 32)
    expect(second.data).toEqual(first.data)

    const colours = new Set<string>()
    for (let y = 4; y < 28; y += 4) {
      for (let x = 4; x < 60; x += 4) colours.add(rgb(first, x, y).join(','))
    }
    expect(colours.size).toBeGreaterThan(8)
    const centre = rgb(first, 32, 16)
    expect(centre[0] + centre[1] + centre[2]).toBeLessThan(180)
  })

  it('antialiases the authored edge while keeping land a flat paper mask', () => {
    const mask = new Float32Array(meta.width * meta.height)
    for (let y = 0; y < meta.height; y++) {
      for (let x = 0; x < meta.width / 2; x++) mask[y * meta.width + x] = 1
    }
    const image = bakeSketchMaskImageData(mask, meta, 64, 32)
    const land = rgb(image, 12, 16)
    const edge = rgb(image, 31, 16)
    const ocean = rgb(image, 52, 16)
    expect(edge).not.toEqual(land)
    expect(edge).not.toEqual(ocean)
    expect(land[0]).toBeGreaterThan(land[2])
    expect(ocean[2]).toBeGreaterThan(ocean[0])
  })
})
