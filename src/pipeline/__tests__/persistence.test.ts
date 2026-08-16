// @vitest-environment happy-dom
/**
 * Persistence round-trip tests for the pipeline layer.
 *
 * These tests lock the contract between `MakeSenseResult` (the conductor's
 * output) and the `World` that gets shipped to the Worldbuild stage.
 * Nothing in Make-sense should mutate the soft mask; the JSON encoder
 * must invert cleanly; the typed arrays must come back as the right
 * concrete `ArrayBufferView` subclasses — not as plain arrays.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  serializeWorld,
  deserializeWorld,
  saveMask,
  loadMask,
  clearMask,
  hasMask,
  serializeMask,
  deserializeMask,
} from '../../world/persist'
import type { World, WorldMeta } from '../../world/types'
import type { CellBiome } from '../../world/types'
import { DEFAULT_META } from '../../world/types'
import { makeContinentWorld, makeTwinContinentWorld, makeSpeckleWorld } from './fixtures'
import type { TestWorld } from './fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a meta header from a `TestWorld` plus the seed/threshold knobs. */
function metaFromTest(tw: TestWorld, seed: number, threshold: number): WorldMeta {
  return {
    seed,
    width: tw.width,
    height: tw.height,
    planetRadiusKm: tw.planetRadiusKm,
    obliquityDeg: tw.obliquityDeg,
    seaLevel: 0.5,
    threshold,
  }
}

/** Build a complete `World` from a `MakeSenseResult` and an input `TestWorld`. */
function makeWorld(tw: TestWorld, seed: number, threshold: number): World {
  const meta = metaFromTest(tw, seed, threshold)
  const n = meta.width * meta.height
  return {
    meta,
    mask: new Float32Array(tw.mask),
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
    biome: new Array<CellBiome>(n).fill('ocean'),
    suitability: new Float32Array(n),
    cities: [],
  }
}

/** Stamp known values into a World's typed arrays so the round-trip has something to verify. */
function populateWorld(world: World): void {
  const n = world.meta.width * world.meta.height
  for (let i = 0; i < n; i++) {
    world.plateId[i] = i % 8
    world.plateVx[i] = (i * 0.001) - 0.5
    world.plateVy[i] = (i * 0.002) - 0.5
    world.elev[i] = (i * 0.013) % 6000
    world.summer[i] = 12 + Math.sin(i * 0.01) * 8
    world.winter[i] = -2 + Math.cos(i * 0.01) * 6
    world.summerMoist[i] = (Math.sin(i * 0.07) + 1) * 0.5
    world.winterMoist[i] = (Math.cos(i * 0.07) + 1) * 0.5
    world.tempMean[i] = (world.summer[i] + world.winter[i]) * 0.5
    world.tempRange[i] = world.summer[i] - world.winter[i]
    world.moistMean[i] = (world.summerMoist[i] + world.winterMoist[i]) * 0.5
    world.flux[i] = (i * 0.0001) % 50
    world.rivers[i] = i % 197 === 0 ? 1 : 0
    world.biome[i] =
    i % 5 === 0
      ? 'temperate-forest'
      : i % 5 === 1
        ? 'hot-desert'
        : i % 5 === 2
          ? 'tundra'
          : i % 5 === 3
            ? 'steppe'
            : 'ocean'
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('persistence: serializeWorld / deserializeWorld', () => {
  it('round-trips a fully-populated World byte-equivalently', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 42, 0.5)
    populateWorld(world)
    world.cities.push({ x: 5, y: 5, name: 'Bemont', seasonal: 0.7 })
    world.cities.push({ x: 25, y: 12, name: 'Corheim', seasonal: 0.55 })

    const json = serializeWorld(world)
    const restored = deserializeWorld(json)

    expect(restored).not.toBeNull()
    // Meta stays structurally identical.
    expect(restored!.meta).toEqual(world.meta)
    // Every typed array field is the right concrete type.
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
    // Element-wise equality for every typed array.
    expect(Array.from(restored!.mask)).toEqual(Array.from(world.mask))
    expect(Array.from(restored!.plateId)).toEqual(Array.from(world.plateId))
    expect(Array.from(restored!.elev)).toEqual(Array.from(world.elev))
    expect(Array.from(restored!.summer)).toEqual(Array.from(world.summer))
    expect(Array.from(restored!.winter)).toEqual(Array.from(world.winter))
    expect(Array.from(restored!.summerMoist)).toEqual(Array.from(world.summerMoist))
    expect(Array.from(restored!.winterMoist)).toEqual(Array.from(world.winterMoist))
    expect(Array.from(restored!.tempMean)).toEqual(Array.from(world.tempMean))
    expect(Array.from(restored!.tempRange)).toEqual(Array.from(world.tempRange))
    expect(Array.from(restored!.moistMean)).toEqual(Array.from(world.moistMean))
    expect(Array.from(restored!.flux)).toEqual(Array.from(world.flux))
    expect(Array.from(restored!.rivers)).toEqual(Array.from(world.rivers))
    expect(restored!.biome).toEqual(world.biome)
    expect(restored!.cities).toEqual(world.cities)
    expect(restored!.seasons).toBe(world.seasons)
  })

  it('round-trips the mask as a Float32Array', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 7, 0.5)
    populateWorld(world)
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(restored!.mask).toBeInstanceOf(Float32Array)
    expect(restored!.mask.length).toBe(world.meta.width * world.meta.height)
    // And every cell of the float mask survives the JSON round-trip.
    for (let i = 0; i < world.mask.length; i++) {
      expect(restored!.mask[i]).toBe(world.mask[i])
    }
  })

  it('round-trips the seasonal fields as Float32Arrays', () => {
    const tw = makeTwinContinentWorld()
    const world = makeWorld(tw, 99, 0.5)
    populateWorld(world)
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(restored!.summer).toBeInstanceOf(Float32Array)
    expect(restored!.winter).toBeInstanceOf(Float32Array)
    expect(restored!.summerMoist).toBeInstanceOf(Float32Array)
    expect(restored!.winterMoist).toBeInstanceOf(Float32Array)
    expect(Array.from(restored!.summer)).toEqual(Array.from(world.summer))
    expect(Array.from(restored!.winter)).toEqual(Array.from(world.winter))
    expect(Array.from(restored!.summerMoist)).toEqual(Array.from(world.summerMoist))
    expect(Array.from(restored!.winterMoist)).toEqual(Array.from(world.winterMoist))
  })

  it('round-trips the biome array as string[]', () => {
    const tw = makeSpeckleWorld()
    const world = makeWorld(tw, 1234, 0.5)
    populateWorld(world)
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(Array.isArray(restored!.biome)).toBe(true)
    expect(restored!.biome.length).toBe(world.meta.width * world.meta.height)
    for (let i = 0; i < world.biome.length; i++) {
      expect(typeof restored!.biome[i]).toBe('string')
      expect(restored!.biome[i]).toBe(world.biome[i])
    }
  })

  it('round-trips the cities array', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 17, 0.5)
    populateWorld(world)
    world.cities.push({ x: 10, y: 10, name: 'A', seasonal: 0.5 })
    world.cities.push({ x: 20, y: 20, name: 'B', seasonal: 0.6 })
    world.cities.push({ x: 30, y: 30, name: 'C', seasonal: 0.7 })
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(restored!.cities).toEqual(world.cities)
    expect(restored!.cities).toHaveLength(3)
  })

  it('round-trips an empty cities array', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    populateWorld(world)
    expect(world.cities).toHaveLength(0)
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(restored!.cities).toEqual([])
  })

  it('produces a JSON string that is content-deterministic for the same input', () => {
    const tw = makeContinentWorld()
    const w1 = makeWorld(tw, 5, 0.5)
    populateWorld(w1)
    const w2 = makeWorld(tw, 5, 0.5)
    populateWorld(w2)
    // Identical inputs -> identical JSON, byte for byte.
    expect(serializeWorld(w1)).toBe(serializeWorld(w2))
  })

  it('returns null on malformed JSON', () => {
    expect(deserializeWorld('{ not json')).toBeNull()
  })
})

describe('persistence: serializeMask / deserializeMask', () => {
  beforeEach(() => clearMask())

  it('round-trips a soft mask through the localStorage layer', () => {
    const tw = makeContinentWorld()
    const meta: WorldMeta = { ...DEFAULT_META, seed: 11, width: tw.width, height: tw.height }
    const mask = new Float32Array(tw.mask)
    expect(saveMask(meta, mask)).toBe(true)
    expect(hasMask()).toBe(true)
    const loaded = loadMask()
    expect(loaded).not.toBeNull()
    expect(loaded!.meta).toEqual(meta)
    expect(loaded!.mask).toBeInstanceOf(Float32Array)
    for (let i = 0; i < mask.length; i++) {
      expect(loaded!.mask[i]).toBe(mask[i])
    }
  })

  it('serializeMask -> deserializeMask is invertible', () => {
    const meta = { ...DEFAULT_META, seed: 101, width: 16, height: 8 }
    const mask = Float32Array.from({ length: meta.width * meta.height }, (_, i) => (i * 0.1) % 1)
    const json = serializeMask(meta, mask)
    const restored = deserializeMask(json)
    expect(restored).not.toBeNull()
    expect(restored!.meta).toEqual(meta)
    expect(restored!.mask).toBeInstanceOf(Float32Array)
    expect(Array.from(restored!.mask)).toEqual(Array.from(mask))
  })
})
