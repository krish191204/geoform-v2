import { describe, expect, it } from 'vitest'
import { DEFAULT_META } from '../world/types'
import {
  LANDFORM_OPTIONS,
  landformStats,
  shrinkLandBlob,
  stampLandform,
  stampLandformAt,
  type LandformKind,
} from './landforms'

function empty(w = 96, h = 48) {
  const meta = { ...DEFAULT_META, width: w, height: h, seed: 7 }
  const mask = new Float32Array(w * h)
  return { meta, mask }
}

function polarLand(mask: Float32Array, w: number, h: number, threshold: number): number {
  let n = 0
  const lo = Math.floor(h * 0.08)
  const hi = Math.ceil(h * 0.92)
  for (let y = 0; y < h; y++) {
    if (y >= lo && y < hi) continue
    for (let x = 0; x < w; x++) if (mask[y * w + x] >= threshold) n++
  }
  return n
}

describe('LANDFORM_OPTIONS', () => {
  it('offers continents, mixed, and islands', () => {
    expect(LANDFORM_OPTIONS.map((o) => o.id)).toEqual([
      'continents',
      'elongated',
      'peninsula',
      'gulf',
      'mixed',
      'islands',
    ])
  })
})

describe('stampLandform', () => {
  it('continents put more land on the map than islands', () => {
    const a = empty()
    const b = empty()
    stampLandform(a.mask, a.meta, 'continents', 7)
    stampLandform(b.mask, b.meta, 'islands', 7)
    expect(landformStats(a.mask, a.meta).landCells).toBeGreaterThan(
      landformStats(b.mask, b.meta).landCells,
    )
  })

  it('islands split into more components than continents', () => {
    const a = empty()
    const b = empty()
    stampLandform(a.mask, a.meta, 'continents', 11)
    stampLandform(b.mask, b.meta, 'islands', 11)
    expect(landformStats(b.mask, b.meta).components).toBeGreaterThan(
      landformStats(a.mask, a.meta).components,
    )
    expect(landformStats(b.mask, b.meta).components).toBeGreaterThanOrEqual(4)
  })

  it('mixed has a continent plus extra scraps', () => {
    const continents = empty()
    const mixed = empty()
    stampLandform(continents.mask, continents.meta, 'continents', 3)
    stampLandform(mixed.mask, mixed.meta, 'mixed', 3)
    expect(landformStats(mixed.mask, mixed.meta).components).toBeGreaterThan(
      landformStats(continents.mask, continents.meta).components,
    )
  })

  it('is deterministic for the same seed on empty ocean', () => {
    const a = empty()
    const b = empty()
    stampLandform(a.mask, a.meta, 'continents', 42)
    stampLandform(b.mask, b.meta, 'continents', 42)
    expect(Array.from(a.mask)).toEqual(Array.from(b.mask))
  })

  it('adds onto existing land instead of wiping it', () => {
    const { meta, mask } = empty()
    mask[24 * 96 + 48] = 1
    stampLandform(mask, meta, 'islands', 9)
    expect(mask[24 * 96 + 48]).toBe(1)
    expect(landformStats(mask, meta).landCells).toBeGreaterThan(1)
  })

  it('keeps polar rows almost empty', () => {
    const kinds: LandformKind[] = ['continents', 'elongated', 'peninsula', 'gulf', 'mixed', 'islands']
    for (const kind of kinds) {
      const { meta, mask } = empty()
      stampLandform(mask, meta, kind, 5)
      const polar = polarLand(mask, meta.width, meta.height, meta.threshold)
      const land = landformStats(mask, meta).landCells
      expect(land).toBeGreaterThan(0)
      expect(polar / Math.max(1, land)).toBeLessThan(0.02)
    }
  })

  it('puts land at the drop cell instead of scattering it', () => {
    const { meta, mask } = empty(96, 48)
    stampLandformAt(mask, meta, 'continents', 5, 12, 24)
    const w = meta.width
    let near = 0
    let far = 0
    for (let y = 0; y < meta.height; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] < meta.threshold) continue
        const dx = Math.min(Math.abs(x - 12), w - Math.abs(x - 12))
        if (dx < w * 0.28) near++
        else far++
      }
    }
    expect(near).toBeGreaterThan(0)
    expect(near).toBeGreaterThan(far)
  })

  it('two drops at different longitudes stay on their own sides', () => {
    const { meta, mask } = empty(96, 48)
    stampLandformAt(mask, meta, 'continents', 5, 16, 24)
    stampLandformAt(mask, meta, 'continents', 5, 80, 24)
    const w = meta.width
    let west = 0
    let east = 0
    for (let y = 0; y < meta.height; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] < meta.threshold) continue
        if (x < w / 2) west++
        else east++
      }
    }
    expect(west).toBeGreaterThan(40)
    expect(east).toBeGreaterThan(40)
  })

  it('compact, long coast, peninsula, and gulf are different silhouettes', () => {
    const compact = empty(96, 48)
    const long = empty(96, 48)
    const arm = empty(96, 48)
    const bay = empty(96, 48)
    stampLandformAt(compact.mask, compact.meta, 'continents', 5, 48, 24)
    stampLandformAt(long.mask, long.meta, 'elongated', 5, 48, 24)
    stampLandformAt(arm.mask, arm.meta, 'peninsula', 5, 48, 24)
    stampLandformAt(bay.mask, bay.meta, 'gulf', 5, 48, 24)
    expect(Array.from(compact.mask)).not.toEqual(Array.from(long.mask))
    expect(Array.from(compact.mask)).not.toEqual(Array.from(arm.mask))
    expect(Array.from(compact.mask)).not.toEqual(Array.from(bay.mask))

    const box = (mask: Float32Array) => {
      let minX = 96
      let maxX = 0
      let minY = 48
      let maxY = 0
      for (let y = 0; y < 48; y++) {
        for (let x = 0; x < 96; x++) {
          if (mask[y * 96 + x] < 0.5) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      return { w: maxX - minX, h: maxY - minY }
    }
    const longBox = box(long.mask)
    const compactBox = box(compact.mask)
    expect(longBox.w / Math.max(1, longBox.h)).toBeGreaterThan(compactBox.w / Math.max(1, compactBox.h))
  })

  it('a smaller scale stamps fewer land cells', () => {
    const full = empty(96, 48)
    const small = empty(96, 48)
    stampLandformAt(full.mask, full.meta, 'continents', 5, 48, 24, 1)
    stampLandformAt(small.mask, small.meta, 'continents', 5, 48, 24, 0.5)
    expect(landformStats(small.mask, small.meta).landCells).toBeLessThan(
      landformStats(full.mask, full.meta).landCells,
    )
  })

  it('clicking a blob trims the outer cells', () => {
    const { meta, mask } = empty(96, 48)
    stampLandformAt(mask, meta, 'continents', 5, 48, 24)
    const before = landformStats(mask, meta).landCells
    expect(shrinkLandBlob(mask, meta.width, meta.height, meta.threshold, 48, 24)).toBe(true)
    expect(landformStats(mask, meta).landCells).toBeLessThan(before)
  })
})
