import { describe, expect, it } from 'vitest'
import { DEFAULT_META, emptyPolityState, type World } from '../world/types'
import {
  featuresAtZoom,
  FJORD_CAP,
  LAKE_CAP,
  LANDMASS_CAP,
  namePhysicalFeatures,
  RANGE_CAP,
  RIVER_CAP,
} from './featureNames'
import { RIVER_THRESHOLD } from '../pipeline/hydrology'

function world(width: number, height: number, seed = 7): World {
  const n = width * height
  return {
    meta: { ...DEFAULT_META, width, height, seed, threshold: 0.5, planetRadiusKm: 6371 },
    mask: new Float32Array(n),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n),
    seasons: 2,
    summer: new Float32Array(n),
    winter: new Float32Array(n),
    summerMoist: new Float32Array(n),
    winterMoist: new Float32Array(n),
    tempMean: new Float32Array(n),
    tempRange: new Float32Array(n),
    moistMean: new Float32Array(n),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome: Array.from({ length: n }, () => 'ocean' as const),
    suitability: new Float32Array(n),
    cities: [],
    ...emptyPolityState(n),
  }
}

function stampLand(w: World, x0: number, y0: number, x1: number, y1: number): void {
  const { width } = w.meta
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) w.mask[y * width + x] = 1
  }
}

describe('namePhysicalFeatures', () => {
  it('is deterministic for the same seed and feature key', () => {
    const a = world(24, 12, 42)
    const b = world(24, 12, 42)
    stampLand(a, 1, 1, 8, 6)
    stampLand(b, 1, 1, 8, 6)
    a.flux[3 * 24 + 4] = RIVER_THRESHOLD + 4
    b.flux[3 * 24 + 4] = RIVER_THRESHOLD + 4
    a.flux[4 * 24 + 4] = RIVER_THRESHOLD + 2
    b.flux[4 * 24 + 4] = RIVER_THRESHOLD + 2
    const left = namePhysicalFeatures(a).map((f) => `${f.kind}:${f.key}:${f.name}`)
    const right = namePhysicalFeatures(b).map((f) => `${f.kind}:${f.key}:${f.name}`)
    expect(left).toEqual(right)
    expect(left.length).toBeGreaterThan(0)
  })

  it('caps each catalog', () => {
    const w = world(40, 20, 3)
    for (let k = 0; k < 12; k++) {
      const x = 1 + (k % 6) * 6
      const y = k < 6 ? 1 : 12
      stampLand(w, x, y, x + 1 + (k % 3), y + 1)
    }
    for (let r = 0; r < 9; r++) {
      const x = 2 + r
      w.mask[8 * 40 + x] = 1
      w.flux[8 * 40 + x] = RIVER_THRESHOLD + 10 + r
      w.mask[10 * 40 + x] = 1
      w.flux[10 * 40 + x] = RIVER_THRESHOLD + 1
    }
    w.lakes = new Uint8Array(40 * 20)
    for (let k = 0; k < 6; k++) {
      w.lakes[15 * 40 + 2 + k * 3] = 1
    }
    for (let k = 0; k < 8; k++) {
      const x = 2 + k * 4
      const i = 4 * 40 + x
      w.mask[i] = 1
      w.elev[i] = 2000 + k
      w.plateId[i] = 1
      w.plateId[4 * 40 + x + 1] = 2
      w.mask[4 * 40 + x + 1] = 1
    }
    for (let k = 0; k < 6; k++) {
      const x = 2 + k * 5
      const i = 18 * 40 + x
      w.mask[i] = 1
      w.biome[i] = 'ice'
    }
    const names = namePhysicalFeatures(w)
    const count = (kind: string) => names.filter((f) => f.kind === kind).length
    expect(count('landmass')).toBeLessThanOrEqual(LANDMASS_CAP)
    expect(count('landmass')).toBe(LANDMASS_CAP)
    expect(count('river')).toBeLessThanOrEqual(RIVER_CAP)
    expect(count('lake')).toBeLessThanOrEqual(LAKE_CAP)
    expect(count('lake')).toBe(LAKE_CAP)
    expect(count('range')).toBeLessThanOrEqual(RANGE_CAP)
    expect(count('fjord')).toBeLessThanOrEqual(FJORD_CAP)
    expect(count('fjord')).toBeGreaterThan(0)
  })

  it('does not throw on an empty world and does not mutate the mask', () => {
    const empty = world(0, 0)
    expect(() => namePhysicalFeatures(empty)).not.toThrow()
    expect(namePhysicalFeatures(empty)).toEqual([])
    const bare = world(4, 2, 1)
    const before = bare.mask.slice()
    expect(namePhysicalFeatures(bare)).toEqual([])
    expect(Array.from(bare.mask)).toEqual(Array.from(before))
    const partial = { meta: { ...DEFAULT_META, width: 2, height: 2 } } as World
    expect(() => namePhysicalFeatures(partial)).not.toThrow()
  })

  it('skips lakes when the lake field is absent', () => {
    const w = world(8, 4, 9)
    stampLand(w, 1, 1, 3, 2)
    const names = namePhysicalFeatures(w)
    expect(names.some((f) => f.kind === 'lake')).toBe(false)
  })

  it('returns fewer names at low zoom than at high zoom', () => {
    const w = world(16, 8, 11)
    stampLand(w, 0, 0, 6, 5)
    stampLand(w, 10, 1, 14, 4)
    for (let x = 1; x <= 5; x++) w.flux[2 * 16 + x] = RIVER_THRESHOLD + x
    w.flux[4 * 16 + 12] = RIVER_THRESHOLD + 1
    w.flux[4 * 16 + 13] = RIVER_THRESHOLD + 1
    w.lakes = new Uint8Array(16 * 8)
    w.lakes[6 * 16 + 2] = 1
    w.lakes[6 * 16 + 3] = 1
    w.elev[1 * 16 + 3] = 2400
    w.plateId[1 * 16 + 3] = 1
    w.plateId[1 * 16 + 4] = 2
    w.biome[5 * 16 + 0] = 'ice'
    const all = namePhysicalFeatures(w)
    const low = featuresAtZoom(all, 1)
    const mid = featuresAtZoom(all, 4)
    const high = featuresAtZoom(all, 6)
    expect(low.length).toBeLessThan(high.length)
    expect(low.length).toBeLessThan(mid.length)
    expect(low.map((f) => f.kind).sort()).toEqual(['landmass', 'river'])
    expect(low.every((f) => f.rank === 0)).toBe(true)
    expect(mid.some((f) => f.kind === 'range')).toBe(true)
    expect(mid.some((f) => f.kind === 'lake')).toBe(true)
    expect(mid.some((f) => f.kind === 'river' && f.rank > 0)).toBe(false)
    expect(mid.some((f) => f.kind === 'fjord')).toBe(false)
    expect(high.some((f) => f.kind === 'fjord')).toBe(true)
    expect(high.some((f) => f.kind === 'river' && f.rank > 0)).toBe(true)
  })
})
