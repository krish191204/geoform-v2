// @vitest-environment happy-dom
// happy-dom 15.x doesn't include ImageData in its global.
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

import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_META, groupedBiomeLegend } from '../world/types'
import {
  atlasBakeWidth,
  atlasSketchBakeCount,
  cellFromPointer,
  createIdleBakeScheduler,
  LAYER_CHIPS,
  paintAtlas,
  paintSketchNotesOnAtlas,
  resetAtlasSketchBakeCache,
  sizeCanvas,
  SKETCH_HD_IDLE_MS,
} from './atlas'

const TINY_META = { ...DEFAULT_META, width: 8, height: 4, seed: 7, threshold: 0.5 }

function stubRect(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect
}

function stubPaintCanvas(cssW = 320, cssH = 180): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  stubRect(canvas, cssW, cssH)
  const ctx = {
    fillStyle: '',
    fillRect() {},
    drawImage() {},
    putImageData() {},
    save() {},
    restore() {},
    translate() {},
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high' as ImageSmoothingQuality,
  }
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext']
  return canvas
}

function withDpr<T>(dpr: number, fn: () => T): T {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio')
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: dpr, configurable: true })
  try {
    return fn()
  } finally {
    if (prev) Object.defineProperty(globalThis, 'devicePixelRatio', prev)
    else delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio
  }
}

afterEach(() => {
  resetAtlasSketchBakeCache()
})

describe('atlasBakeWidth', () => {
  it('oversamples the Geoform 1 HD grid then caps at 4096', () => {
    expect(atlasBakeWidth(1600, 768)).toBe(3072)
    expect(atlasBakeWidth(5000, 768)).toBe(4096)
    expect(atlasBakeWidth(200, 64)).toBe(256)
    expect(atlasBakeWidth(1600, 768, true)).toBe(768)
  })

  it('preview is native grid; local HD is at least 4 px/cell', () => {
    expect(atlasBakeWidth(1600, 768, true)).toBe(768)
    expect(atlasBakeWidth(1600, 768)).toBeGreaterThanOrEqual(768 * 4)
    expect(atlasBakeWidth(200, 64, true)).toBe(64)
    expect(atlasBakeWidth(200, 64)).toBeGreaterThanOrEqual(64 * 4)
  })

  it('matches Geoform 1 published-build raster budget so Vercel stays interactive', () => {
    expect(atlasBakeWidth(1600, 768, { prod: true, gridH: 384 })).toBe(1536)
    expect(atlasBakeWidth(1600, 768, { preview: true, prod: true, gridH: 384 })).toBe(768)
  })
})

describe('sizeCanvas', () => {
  it('caps the sketch backing store at 1× CSS pixels even when dpr is 2', () => {
    withDpr(2, () => {
      const canvas = document.createElement('canvas')
      stubRect(canvas, 1600, 800)
      expect(sizeCanvas(canvas, { sketch: true })).toEqual({ width: 1600, height: 800 })
      expect(canvas.width).toBe(1600)
      expect(canvas.height).toBe(800)
    })
  })

  it('still allows a 2× world backing store in dev', () => {
    withDpr(2, () => {
      const canvas = document.createElement('canvas')
      stubRect(canvas, 1600, 800)
      expect(sizeCanvas(canvas, { sketch: false })).toEqual({ width: 3200, height: 1600 })
    })
  })
})

describe('cellFromPointer', () => {
  it('maps hits from the CSS letterbox, not the backing-store size', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3200
    canvas.height = 1600
    stubRect(canvas, 1600, 800)
    expect(cellFromPointer(canvas, 800, 400, 8, 4)).toEqual({ x: 4, y: 2 })
    expect(cellFromPointer(canvas, 0, 0, 8, 4)).toEqual({ x: 0, y: 0 })
  })
})

describe('sketch bake cache', () => {
  it('reuses the raster when mask epoch and bake size stay the same', () => {
    const canvas = stubPaintCanvas()
    const mask = new Float32Array(TINY_META.width * TINY_META.height)
    mask[10] = 1
    const opts = {
      world: null,
      mask,
      meta: TINY_META,
      layer: 'relief' as const,
      season: 'summer' as const,
      preview: true,
      sketchEpoch: 3,
    }
    paintAtlas(canvas, opts)
    paintAtlas(canvas, opts)
    expect(atlasSketchBakeCount()).toBe(1)
  })

  it('bakes again when the sketch epoch changes', () => {
    const canvas = stubPaintCanvas()
    const mask = new Float32Array(TINY_META.width * TINY_META.height)
    const base = {
      world: null,
      mask,
      meta: TINY_META,
      layer: 'relief' as const,
      season: 'summer' as const,
      preview: true,
    }
    paintAtlas(canvas, { ...base, sketchEpoch: 1 })
    paintAtlas(canvas, { ...base, sketchEpoch: 2 })
    expect(atlasSketchBakeCount()).toBe(2)
  })

  it('treats preview and HD as different bakes, then caches HD', () => {
    const canvas = stubPaintCanvas()
    const mask = new Float32Array(TINY_META.width * TINY_META.height)
    const base = {
      world: null,
      mask,
      meta: TINY_META,
      layer: 'relief' as const,
      season: 'summer' as const,
      sketchEpoch: 8,
    }
    paintAtlas(canvas, { ...base, preview: true })
    paintAtlas(canvas, { ...base, preview: false })
    paintAtlas(canvas, { ...base, preview: false })
    expect(atlasSketchBakeCount()).toBe(2)
  })

  it('bakes doodle notes through the cache without losing raster reuse', () => {
    const canvas = stubPaintCanvas()
    const mask = new Float32Array(TINY_META.width * TINY_META.height)
    mask[10] = 1
    const marks = new Uint8Array(TINY_META.width * TINY_META.height)
    marks[10] = 1
    const opts = {
      world: null,
      mask,
      meta: TINY_META,
      layer: 'relief' as const,
      season: 'summer' as const,
      preview: true,
      sketchEpoch: 4,
      marks,
    }
    paintAtlas(canvas, opts)
    paintAtlas(canvas, opts)
    expect(atlasSketchBakeCount()).toBe(1)
  })
})

describe('createIdleBakeScheduler', () => {
  it('defers the HD callback until idle and reschedules when a new stroke starts', () => {
    const timers: { id: number; fn: () => void; ms: number }[] = []
    let nextId = 1
    const clock = {
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++
        timers.push({ id, fn, ms })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout(id: ReturnType<typeof setTimeout>) {
        const i = timers.findIndex((t) => t.id === (id as unknown as number))
        if (i >= 0) timers.splice(i, 1)
      },
    }
    const hd = createIdleBakeScheduler(SKETCH_HD_IDLE_MS, clock)
    let fires = 0
    hd.afterStroke(() => {
      fires++
    })
    expect(hd.pending).toBe(true)
    expect(fires).toBe(0)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBeGreaterThanOrEqual(80)
    expect(timers[0].ms).toBeLessThanOrEqual(120)

    hd.afterStroke(() => {
      fires++
    })
    expect(timers).toHaveLength(1)
    expect(fires).toBe(0)

    const due = timers.pop()
    due?.fn()
    expect(fires).toBe(1)
    expect(hd.pending).toBe(false)

    hd.afterStroke(() => {
      fires++
    })
    hd.cancel()
    expect(hd.pending).toBe(false)
    expect(timers).toHaveLength(0)
    expect(fires).toBe(1)
  })
})

describe('sketch notes vs grounded atlas', () => {
  it('keeps doodle ticks off the derived world', () => {
    expect(paintSketchNotesOnAtlas(null)).toBe(true)
    expect(paintSketchNotesOnAtlas({} as import('../world/types').World)).toBe(false)
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
      expect(chip.caption.length).toBeGreaterThan(8)
    }
    expect(LAYER_CHIPS.find((c) => c.id === 'temperature')?.title).toMatch(/temperature/i)
    expect(LAYER_CHIPS.find((c) => c.id === 'elevation')?.title).toMatch(/metres/i)
    expect(LAYER_CHIPS.find((c) => c.id === 'biome')?.title).toMatch(/climate/i)
    expect(LAYER_CHIPS.find((c) => c.id === 'biome')?.title).not.toMatch(/Holdridge/i)
  })
})

describe('groupedBiomeLegend', () => {
  it('hides empty groups and lists subtypes under Forest / Dry / Cold / Wet', () => {
    const groups = groupedBiomeLegend(['ocean', 'tundra', 'hot-desert', 'rainforest', 'wetland'])
    expect(groups.map((g) => g.label)).toEqual(['Cold', 'Dry', 'Forest', 'Wet'])
    expect(groups.find((g) => g.label === 'Forest')?.entries.map((e) => e.id)).toEqual(['rainforest'])
  })
})
