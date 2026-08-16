// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { draw, inspectCell, screenToCell } from './draw'
import { biomeColor, type CellBiome, type World, type WorldMeta } from '../world/types'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TestWorldOpts {
  width?: number
  height?: number
  seed?: number
  /** Per-cell summer temperature, °C. Default: linear ramp across rows. */
  summer?: number[] | ((x: number, y: number) => number)
  /** Per-cell winter temperature, °C. Default: zero. */
  winter?: number[] | ((x: number, y: number) => number)
  /** Per-cell summer moisture, 0..1. Default: 0.5. */
  summerMoist?: number[] | ((x: number, y: number) => number)
  /** Per-cell winter moisture, 0..1. Default: 0.5. */
  winterMoist?: number[] | ((x: number, y: number) => number)
  /** Per-cell annual mean moisture, 0..1. Default: 0.5. */
  moistMean?: number[] | ((x: number, y: number) => number)
  /** Per-cell elevation in metres. Default: 500 (land). */
  elev?: number[] | ((x: number, y: number) => number)
  /** Per-cell biome. Default: 'ocean'. */
  biome?: CellBiome[]
  /** Set a specific cell's summer temp to NaN for the NaN test. */
  nanCell?: { x: number; y: number }
}

function resolveArr<T>(
  v: T[] | ((x: number, y: number) => T) | undefined,
  fallback: T,
  width: number,
  height: number,
): T[] {
  const n = width * height
  if (v === undefined) return Array.from({ length: n }, () => fallback)
  if (Array.isArray(v)) {
    const arr = v.slice()
    while (arr.length < n) arr.push(fallback)
    return arr.slice(0, n)
  }
  const fn = v as (x: number, y: number) => T
  const out: T[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.push(fn(x, y))
  }
  return out
}

function makeWorld(opts: TestWorldOpts = {}): World {
  const width = opts.width ?? 20
  const height = opts.height ?? 20
  const seed = opts.seed ?? 1
  const meta: WorldMeta = {
    seed,
    width,
    height,
    planetRadiusKm: 6371,
    obliquityDeg: 23.5,
    seaLevel: 0,
    threshold: 0.5,
  }
  const n = width * height

  const elev = resolveArr<number>(opts.elev, 500, width, height)
  // Default summer: row gradient 0 → 30 °C.
  const summer = resolveArr<number>(
    opts.summer,
    (x, y) => ((x + y) / Math.max(1, width + height - 2)) * 30,
    width,
    height,
  )
  const winter = resolveArr<number>(opts.winter, 0, width, height)
  const summerMoist = resolveArr<number>(opts.summerMoist, 0.5, width, height)
  const winterMoist = resolveArr<number>(opts.winterMoist, 0.5, width, height)
  const moistMean = resolveArr<number>(opts.moistMean, 0.5, width, height)
  const biome: CellBiome[] = opts.biome
    ? [...opts.biome]
    : Array.from({ length: n }, () => 'ocean' as CellBiome)

  if (opts.nanCell) {
    const { x, y } = opts.nanCell
    summer[y * width + x] = Number.NaN
  }

  return {
    meta,
    mask: Float32Array.from({ length: n }, () => 0.6),
    plateId: Int16Array.from({ length: n }, (_, i) => i % 12),
    plateVx: Float32Array.from({ length: n }, () => 0),
    plateVy: Float32Array.from({ length: n }, () => 0),
    elev: Float32Array.from(elev),
    seasons: 2,
    summer: Float32Array.from(summer),
    winter: Float32Array.from(winter),
    summerMoist: Float32Array.from(summerMoist),
    winterMoist: Float32Array.from(winterMoist),
    tempMean: Float32Array.from({ length: n }, (_, i) => summer[i] * 0.5),
    tempRange: Float32Array.from({ length: n }, (_, i) => summer[i] - winter[i]),
    moistMean: Float32Array.from(moistMean),
    flux: Float32Array.from({ length: n }, () => 0),
    rivers: Uint8Array.from({ length: n }, () => 0),
    biome,
    suitability: Float32Array.from({ length: n }, () => 0.5),
    cities: [],
  }
}

/** Read the RGB triple for a pixel in an ImageData. */
function pixel(img: ImageData, x: number, y: number): [number, number, number] {
  const o = (y * img.width + x) * 4
  return [img.data[o], img.data[o + 1], img.data[o + 2]]
}

// ---------------------------------------------------------------------------
// draw()
// ---------------------------------------------------------------------------

describe('draw', () => {
  it('renders a temperature gradient when layer=temperature and season=summer', () => {
    const world = makeWorld({ width: 8, height: 4 })
    const img = draw(world, 'summer', 'temperature')

    // ImageData dimensions match the grid 1:1 when no scale is given.
    expect(img.width).toBe(8)
    expect(img.height).toBe(4)

    // Distinct temperatures must produce distinct RGB triples.
    const cold = pixel(img, 0, 0)
    const hot = pixel(img, 7, 3)
    expect(cold).not.toEqual(hot)
  })

  it('renders a temperature gradient when layer=temperature and season=winter', () => {
    // Winter set to a row gradient; summer uniform.
    const world = makeWorld({
      width: 8,
      height: 4,
      summer: () => 0,
      winter: (_x, y) => y * 5,
    })
    const img = draw(world, 'winter', 'temperature')
    const top = pixel(img, 4, 0)
    const bottom = pixel(img, 4, 3)
    expect(top).not.toEqual(bottom)
  })

  it('renders biomes per cell when layer=biome', () => {
    const width = 4
    const height = 1
    const biome: CellBiome[] = ['ocean', 'rainforest', 'hot-desert', 'ice']
    const world = makeWorld({ width, height, biome })

    const img = draw(world, 'summer', 'biome')
    expect(img.width).toBe(width)
    expect(img.height).toBe(height)

    for (let x = 0; x < width; x++) {
      const expected = hexToRgb(biomeColor(biome[x]))
      expect(pixel(img, x, 0)).toEqual(expected)
    }
  })

  it('renders a moisture gradient when layer=moisture and the chosen season has a ramp', () => {
    const world = makeWorld({
      width: 8,
      height: 2,
      summerMoist: (x) => x / 7,
      winterMoist: () => 0,
    })
    const summerImg = draw(world, 'summer', 'moisture')
    const winterImg = draw(world, 'winter', 'moisture')

    expect(pixel(summerImg, 0, 0)).not.toEqual(pixel(summerImg, 7, 0))
    // Winter is uniform → all cells identical.
    expect(pixel(winterImg, 0, 0)).toEqual(pixel(winterImg, 7, 0))
  })

  it('renders relief with hillshade and respects showRivers=false', () => {
    const world = makeWorld({
      width: 6,
      height: 3,
      elev: (_x, _y) => 1500,
    })
    world.rivers[1] = 1

    const withRivers = draw(world, 'summer', 'relief', { showRivers: true })
    const withoutRivers = draw(world, 'summer', 'relief', { showRivers: false })

    expect(pixel(withRivers, 1, 1)).not.toEqual(pixel(withoutRivers, 1, 1))
  })

  it('up-scales with the scale option (nearest-neighbour)', () => {
    const world = makeWorld({ width: 4, height: 4 })
    const img = draw(world, 'summer', 'temperature', { scale: 3 })
    expect(img.width).toBe(12)
    expect(img.height).toBe(12)
    // (0,0) and (1,0) at scale=3 land on the same source pixel → same colour.
    expect(pixel(img, 0, 0)).toEqual(pixel(img, 2, 0))
  })

  it('respects the elevation-only contract: no hillshade, no rivers', () => {
    const world = makeWorld({ width: 4, height: 4, elev: () => 1500 })
    world.rivers[0] = 1
    const img = draw(world, 'summer', 'elevation')
    // All cells are at the same elevation → uniform colour.
    expect(pixel(img, 0, 0)).toEqual(pixel(img, 3, 3))
  })
})

// ---------------------------------------------------------------------------
// inspectCell()
// ---------------------------------------------------------------------------

describe('inspectCell', () => {
  it('reads every field at (x, y) from the seasonal arrays', () => {
    const world = makeWorld({ width: 20, height: 20 })
    const view = inspectCell(world, 10, 10)

    const i = 10 * 20 + 10
    expect(view.elev).toBe(world.elev[i])
    expect(view.plateId).toBe(world.plateId[i])
    expect(view.tempSummer).toBe(world.summer[i])
    expect(view.tempWinter).toBe(world.winter[i])
    expect(view.tempRange).toBe(world.tempRange[i])
    expect(view.moistSummer).toBe(world.summerMoist[i])
    expect(view.moistWinter).toBe(world.winterMoist[i])
    expect(view.biome).toBe(world.biome[i])
  })

  it('shows "—" for NaN fields in the display block', () => {
    const world = makeWorld({
      width: 8,
      height: 8,
      nanCell: { x: 3, y: 3 },
    })
    const view = inspectCell(world, 3, 3)

    expect(Number.isNaN(view.tempSummer)).toBe(true)
    expect(view.display.tempSummer).toBe('—')
    // Unrelated fields still render their numbers.
    expect(view.display.elev).toBe('500 m')
  })

  it('shows "—" when a biome entry is missing/empty', () => {
    const world = makeWorld({ width: 4, height: 4, biome: ['ocean'] })
    // biome length is 1 but grid is 16 — overflow cells are undefined.
    const view = inspectCell(world, 2, 2)
    expect(view.biome).toBe('—')
    expect(view.display.biome).toBe('—')
  })

  it('formats temperatures as whole degrees Celsius', () => {
    const world = makeWorld({
      width: 4,
      height: 4,
      summer: () => 27.6,
      winter: () => -4.3,
    })
    const view = inspectCell(world, 0, 0)
    expect(view.display.tempSummer).toBe('28°C')
    expect(view.display.tempWinter).toBe('-4°C')
  })

  it('formats moisture to two decimals', () => {
    const world = makeWorld({
      width: 4,
      height: 4,
      summerMoist: () => 0.456,
      winterMoist: () => 0.123,
    })
    const view = inspectCell(world, 0, 0)
    expect(view.display.moistSummer).toBe('0.46')
    expect(view.display.moistWinter).toBe('0.12')
  })
})

// ---------------------------------------------------------------------------
// screenToCell()
// ---------------------------------------------------------------------------

describe('screenToCell', () => {
  it('maps cursor coordinates into grid space', () => {
    const world = makeWorld({ width: 20, height: 10 })
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => '',
      }) as DOMRect
    // 50% width → x=10, 30% height → y=3.
    expect(screenToCell(canvas, 100, 30, world)).toEqual({ x: 10, y: 3 })
  })

  it('returns null for cursors outside the canvas', () => {
    const world = makeWorld({ width: 20, height: 10 })
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => '',
      }) as DOMRect
    expect(screenToCell(canvas, -10, 5, world)).toBeNull()
    expect(screenToCell(canvas, 500, 500, world)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}