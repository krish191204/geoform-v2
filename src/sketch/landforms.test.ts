import { describe, expect, it } from 'vitest'
import { DEFAULT_META } from '../world/types'
import {
  LANDFORM_OPTIONS,
  landformStats,
  stampLandform,
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
    expect(LANDFORM_OPTIONS.map((o) => o.id)).toEqual(['continents', 'mixed', 'islands'])
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
    const kinds: LandformKind[] = ['continents', 'mixed', 'islands']
    for (const kind of kinds) {
      const { meta, mask } = empty()
      stampLandform(mask, meta, kind, 5)
      const polar = polarLand(mask, meta.width, meta.height, meta.threshold)
      const land = landformStats(mask, meta).landCells
      expect(land).toBeGreaterThan(0)
      expect(polar / Math.max(1, land)).toBeLessThan(0.02)
    }
  })
})
