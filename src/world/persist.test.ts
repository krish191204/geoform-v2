// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  MASK_SAVE_KEY,
  WORLD_SAVE_KEY,
  serializeMask,
  deserializeMask,
  serializeWorld,
  deserializeWorld,
  saveMask,
  loadMask,
  clearMask,
  hasMask,
  saveWorld,
  loadWorld,
  clearWorld,
  hasWorld,
  readMaskFile,
  readWorldFile,
} from './persist'
import type { World, WorldMeta } from './types'

function makeMeta(seed = 42): WorldMeta {
  return {
    seed,
    width: 8,
    height: 6,
    planetRadiusKm: 6371,
    obliquityDeg: 23.4,
    seaLevel: 0.5,
    threshold: 0.55,
  }
}

function makeMask(meta: WorldMeta, value = 0.5): Float32Array {
  return Float32Array.from({ length: meta.width * meta.height }, () => value)
}

function makeWorld(seed = 42): World {
  const meta = makeMeta(seed)
  const n = meta.width * meta.height
  return {
    meta,
    mask: makeMask(meta, 0.6),
    plateId: Int16Array.from({ length: n }, (_, i) => i % 4),
    plateVx: Float32Array.from({ length: n }, () => 0.1),
    plateVy: Float32Array.from({ length: n }, () => -0.1),
    elev: Float32Array.from({ length: n }, (_, i) => (i % 5) * 0.1),
    seasons: 4,
    summer: Float32Array.from({ length: n }, () => 0.7),
    winter: Float32Array.from({ length: n }, () => 0.2),
    summerMoist: Float32Array.from({ length: n }, () => 0.6),
    winterMoist: Float32Array.from({ length: n }, () => 0.4),
    tempMean: Float32Array.from({ length: n }, () => 0.5),
    tempRange: Float32Array.from({ length: n }, () => 0.3),
    moistMean: Float32Array.from({ length: n }, () => 0.5),
    flux: Float32Array.from({ length: n }, () => 0),
    rivers: Uint8Array.from({ length: n }, () => 0),
    biome: ['ocean', 'temperate-forest', 'hot-desert', 'tundra'],
    suitability: Float32Array.from({ length: n }, () => 0.5),
    cities: [{ x: 2, y: 3, name: 'Testopolis', seasonal: 0.8 }],
  }
}

describe('persist: mask layer', () => {
  beforeEach(() => {
    clearMask()
  })

  it('serializeMask / deserializeMask round-trip', () => {
    const meta = makeMeta(7)
    const mask = Float32Array.from({ length: meta.width * meta.height }, (_, i) => i * 0.01)
    const json = serializeMask(meta, mask)
    const restored = deserializeMask(json)
    expect(restored).not.toBeNull()
    expect(restored!.meta).toEqual(meta)
    expect(Array.from(restored!.mask)).toEqual(Array.from(mask))
    // Rehydrated array must be a Float32Array, not a plain Array.
    expect(restored!.mask).toBeInstanceOf(Float32Array)
  })

  it('saveMask / loadMask round-trip through localStorage', () => {
    const meta = makeMeta(11)
    const mask = makeMask(meta, 0.42)
    expect(saveMask(meta, mask)).toBe(true)
    expect(hasMask()).toBe(true)
    const loaded = loadMask()
    expect(loaded).not.toBeNull()
    expect(loaded!.meta.seed).toBe(11)
    expect(loaded!.mask).toBeInstanceOf(Float32Array)
    expect(Array.from(loaded!.mask)).toEqual(Array.from(mask))
  })

  it('loadMask returns null on missing key', () => {
    clearMask()
    expect(loadMask()).toBeNull()
    expect(hasMask()).toBe(false)
  })

  it('loadMask returns null on malformed JSON', () => {
    localStorage.setItem(MASK_SAVE_KEY, '{not json')
    expect(loadMask()).toBeNull()
  })

  it('deserializeMask returns null on version mismatch', () => {
    const bad = JSON.stringify({ version: 1, meta: makeMeta(), mask: [] })
    expect(deserializeMask(bad)).toBeNull()
  })

  it('deserializeMask returns null on wrong-shape meta', () => {
    const bad = JSON.stringify({ version: 2, meta: { seed: 1 }, mask: [] })
    expect(deserializeMask(bad)).toBeNull()
  })

  it('deserializeMask returns null when mask length disagrees with meta', () => {
    const meta = makeMeta()
    const wrong = JSON.stringify({ version: 2, meta, mask: [0.1, 0.2] })
    expect(deserializeMask(wrong)).toBeNull()
  })

  it('readMaskFile rejects on non-conforming shape', async () => {
    const bad = JSON.stringify({ version: 2, meta: { seed: 1 }, mask: [] })
    const blob = new Blob([bad], { type: 'application/json' })
    const file = new File([blob], 'mask.json', { type: 'application/json' })
    expect(await readMaskFile(file)).toBeNull()
  })
})

describe('persist: world layer', () => {
  beforeEach(() => {
    clearWorld()
  })

  it('serializeWorld / deserializeWorld round-trip including typed-array rehydration', () => {
    const original = makeWorld(99)
    const json = serializeWorld(original)
    const restored = deserializeWorld(json)
    expect(restored).not.toBeNull()
    expect(restored!.meta.seed).toBe(99)
    expect(restored!.meta).toEqual(original.meta)
    expect(restored!.mask).toBeInstanceOf(Float32Array)
    expect(restored!.plateId).toBeInstanceOf(Int16Array)
    expect(restored!.plateVx).toBeInstanceOf(Float32Array)
    expect(restored!.plateVy).toBeInstanceOf(Float32Array)
    expect(restored!.elev).toBeInstanceOf(Float32Array)
    expect(restored!.summer).toBeInstanceOf(Float32Array)
    expect(restored!.winter).toBeInstanceOf(Float32Array)
    expect(restored!.summerMoist).toBeInstanceOf(Float32Array)
    expect(restored!.winterMoist).toBeInstanceOf(Float32Array)
    expect(restored!.tempMean).toBeInstanceOf(Float32Array)
    expect(restored!.tempRange).toBeInstanceOf(Float32Array)
    expect(restored!.moistMean).toBeInstanceOf(Float32Array)
    expect(restored!.flux).toBeInstanceOf(Float32Array)
    expect(restored!.rivers).toBeInstanceOf(Uint8Array)
    expect(Array.from(restored!.elev)).toEqual(Array.from(original.elev))
    expect(Array.from(restored!.plateId)).toEqual(Array.from(original.plateId))
    expect(Array.from(restored!.mask)).toEqual(Array.from(original.mask))
    expect(Array.from(restored!.summer)).toEqual(Array.from(original.summer))
    expect(Array.from(restored!.winter)).toEqual(Array.from(original.winter))
    expect(Array.from(restored!.summerMoist)).toEqual(Array.from(original.summerMoist))
    expect(Array.from(restored!.winterMoist)).toEqual(Array.from(original.winterMoist))
    expect(Array.from(restored!.tempMean)).toEqual(Array.from(original.tempMean))
    expect(Array.from(restored!.tempRange)).toEqual(Array.from(original.tempRange))
    expect(Array.from(restored!.moistMean)).toEqual(Array.from(original.moistMean))
    expect(Array.from(restored!.flux)).toEqual(Array.from(original.flux))
    expect(Array.from(restored!.rivers)).toEqual(Array.from(original.rivers))
    expect(restored!.biome).toEqual(original.biome)
    expect(restored!.cities).toEqual(original.cities)
    expect(restored!.seasons).toBe(4)
  })

  it('saveWorld / loadWorld round-trip through localStorage', () => {
    const w = makeWorld(13)
    expect(saveWorld(w)).toBe(true)
    expect(hasWorld()).toBe(true)
    const loaded = loadWorld()
    expect(loaded).not.toBeNull()
    expect(loaded!.meta.seed).toBe(13)
    expect(loaded!.elev).toBeInstanceOf(Float32Array)
  })

  it('loadWorld returns null on missing key', () => {
    clearWorld()
    expect(loadWorld()).toBeNull()
    expect(hasWorld()).toBe(false)
  })

  it('loadWorld returns null on malformed JSON', () => {
    localStorage.setItem(WORLD_SAVE_KEY, '{nope')
    expect(loadWorld()).toBeNull()
  })

  it('deserializeWorld returns null on version mismatch', () => {
    const bad = JSON.stringify({ version: 1, world: {} })
    expect(deserializeWorld(bad)).toBeNull()
  })

  it('deserializeWorld returns null on missing required field (no elev)', () => {
    const meta = makeMeta()
    const w = makeWorld()
    const partial: Record<string, unknown> = {
      version: 2,
      world: {
        meta,
        mask: Array.from(w.mask),
        plateId: Array.from(w.plateId),
        plateVx: Array.from(w.plateVx),
        plateVy: Array.from(w.plateVy),
        // elev intentionally omitted
        seasons: 4,
        summer: Array.from(w.summer),
        winter: Array.from(w.winter),
        summerMoist: Array.from(w.summerMoist),
        winterMoist: Array.from(w.winterMoist),
        tempMean: Array.from(w.tempMean),
        tempRange: Array.from(w.tempRange),
        moistMean: Array.from(w.moistMean),
        flux: Array.from(w.flux),
        rivers: Array.from(w.rivers),
        biome: w.biome,
        cities: w.cities,
      },
    }
    expect(deserializeWorld(JSON.stringify(partial))).toBeNull()
  })

  it('deserializeWorld returns null when an array length disagrees with meta', () => {
    const meta = makeMeta()
    const w = makeWorld()
    const badArr = Array.from(w.elev).slice(0, -1) // one short
    const partial: Record<string, unknown> = {
      version: 2,
      world: {
        meta,
        mask: Array.from(w.mask),
        plateId: Array.from(w.plateId),
        plateVx: Array.from(w.plateVx),
        plateVy: Array.from(w.plateVy),
        elev: badArr,
        seasons: 4,
        summer: Array.from(w.summer),
        winter: Array.from(w.winter),
        summerMoist: Array.from(w.summerMoist),
        winterMoist: Array.from(w.winterMoist),
        tempMean: Array.from(w.tempMean),
        tempRange: Array.from(w.tempRange),
        moistMean: Array.from(w.moistMean),
        flux: Array.from(w.flux),
        rivers: Array.from(w.rivers),
        biome: w.biome,
        cities: w.cities,
      },
    }
    expect(deserializeWorld(JSON.stringify(partial))).toBeNull()
  })

  it('deserializeWorld returns null when seasons is not 2 or 4', () => {
    const meta = makeMeta()
    const w = makeWorld()
    const partial: Record<string, unknown> = {
      version: 2,
      world: {
        meta,
        mask: Array.from(w.mask),
        plateId: Array.from(w.plateId),
        plateVx: Array.from(w.plateVx),
        plateVy: Array.from(w.plateVy),
        elev: Array.from(w.elev),
        seasons: 3,
        summer: Array.from(w.summer),
        winter: Array.from(w.winter),
        summerMoist: Array.from(w.summerMoist),
        winterMoist: Array.from(w.winterMoist),
        tempMean: Array.from(w.tempMean),
        tempRange: Array.from(w.tempRange),
        moistMean: Array.from(w.moistMean),
        flux: Array.from(w.flux),
        rivers: Array.from(w.rivers),
        biome: w.biome,
        cities: w.cities,
      },
    }
    expect(deserializeWorld(JSON.stringify(partial))).toBeNull()
  })

  it('readWorldFile rejects on non-JSON', async () => {
    const blob = new Blob(['not json at all'], { type: 'application/json' })
    const file = new File([blob], 'w.json', { type: 'application/json' })
    expect(await readWorldFile(file)).toBeNull()
  })

  it('readWorldFile rejects on non-conforming shape (missing version)', async () => {
    const blob = new Blob([JSON.stringify({ hello: 'world' })], { type: 'application/json' })
    const file = new File([blob], 'w.json', { type: 'application/json' })
    expect(await readWorldFile(file)).toBeNull()
  })
})

describe('persist: storage keys', () => {
  it('uses distinct v2 keys for mask and world', () => {
    expect(MASK_SAVE_KEY).toBe('geoform.mask.v2')
    expect(WORLD_SAVE_KEY).toBe('geoform.world.v2')
  })
})