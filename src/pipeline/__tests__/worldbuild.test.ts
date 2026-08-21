// @vitest-environment happy-dom
/**
 * Worldbuild stage tests.
 *
 * Pins the placement and removal rules of the user-visible city tool.
 * The hard rules are:
 *   - cell must be land (mask >= threshold)
 *   - cell suitability must be >= 0.4
 *   - no existing city within 5 cells (Chebyshev)
 *
 * Removal is a Chebyshev-ball around the click point; the closest city
 * within 8 cells wins.
 *
 * Names should stay unique against the cumulative set on the world.
 */

import { describe, it, expect } from 'vitest'
import {
  placeCity,
  removeNearestCity,
  cityNameGenerator,
} from '../../sketch/worldbuild'
import type { World, City, WorldMeta } from '../../world/types'
import type { CellBiome } from '../../world/types'
import { emptyPolityState } from '../../world/types'
import { makeContinentWorld } from './fixtures'
import type { TestWorld } from './fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a World where the central 20x12 patch is land and the rest is
 * ocean. The suitability array defaults to 1.0 on land cells and 0.0
 * elsewhere.
 */
function makeWorld(tw: TestWorld, seed: number, threshold: number): World {
  const meta = metaFromTest(tw, seed, threshold)
  const n = meta.width * meta.height
  const mask = new Float32Array(n)
  const suitability = new Float32Array(n)
  const cx = Math.floor(meta.width / 2)
  const cy = Math.floor(meta.height / 2)
  for (let y = cy - 6; y < cy + 6; y++) {
    for (let x = cx - 10; x < cx + 10; x++) {
      if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) continue
      const i = y * meta.width + x
      mask[i] = 1
      suitability[i] = 1
    }
  }
  return {
    meta,
    mask,
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
    cities: [],
    suitability,
    ...emptyPolityState(n),
  }
}

// ---------------------------------------------------------------------------
// placeCity
// ---------------------------------------------------------------------------

describe('placeCity', () => {
  it('places a city on a suitable land cell', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    const r = placeCity(world, cx, cy, 'Bemont')
    expect(r.mutated).toBe(true)
    expect(r.rejected).toBe(false)
    expect(r.city).not.toBeNull()
    expect(r.city!.x).toBe(cx)
    expect(r.city!.y).toBe(cy)
    expect(r.city!.name).toBe('Bemont')
    expect(world.cities).toHaveLength(1)
    expect(world.cities[0].name).toBe('Bemont')
  })

  it('rejects a city placed on an ocean cell', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    // (0, 0) is outside the 20x12 land patch.
    const r = placeCity(world, 0, 0, 'Atlantis')
    expect(r.mutated).toBe(false)
    expect(r.rejected).toBe(true)
    expect(r.city).toBeNull()
    expect(world.cities).toHaveLength(0)
  })

  it('rejects out-of-bounds clicks', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const r1 = placeCity(world, -1, 5, 'NegativeX')
    expect(r1.mutated).toBe(false)
    expect(r1.rejected).toBe(true)
    const r2 = placeCity(world, world.meta.width, world.meta.height, 'OutOfBounds')
    expect(r2.mutated).toBe(false)
    expect(r2.rejected).toBe(true)
    expect(world.cities).toHaveLength(0)
  })

  it('rejects cities too close to an existing city (within 5 cells)', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    const first = placeCity(world, cx, cy, 'Bemont')
    expect(first.mutated).toBe(true)
    const r = placeCity(world, cx + 3, cy, 'Corheim')
    expect(r.mutated).toBe(false)
    expect(r.rejected).toBe(true)
    expect(world.cities).toHaveLength(1)
  })

  it('accepts a city placed exactly 5 cells away', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    placeCity(world, cx, cy, 'Bemont')
    const r = placeCity(world, cx + 5, cy, 'Corheim')
    expect(r.mutated).toBe(true)
    expect(r.rejected).toBe(false)
    expect(world.cities).toHaveLength(2)
  })

  it('records seasonal = suitability[i] on the new city', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    const suit = (world as World & { suitability: Float32Array }).suitability
    const i = cy * world.meta.width + cx
    suit[i] = 0.72
    const r = placeCity(world, cx, cy, 'Bemont')
    expect(r.city!.seasonal).toBeCloseTo(0.72, 5)
  })

  it('rejects a city placed on land with low suitability (< 0.4)', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    const suit = (world as World & { suitability: Float32Array }).suitability
    const i = cy * world.meta.width + cx
    suit[i] = 0.1
    const r = placeCity(world, cx, cy, 'Lasthope')
    expect(r.mutated).toBe(false)
    expect(r.rejected).toBe(true)
    expect(world.cities).toHaveLength(0)
  })

  it('accepts suitability exactly at 0.4 (boundary)', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    const suit = (world as World & { suitability: Float32Array }).suitability
    const i = cy * world.meta.width + cx
    suit[i] = 0.4
    const r = placeCity(world, cx, cy, 'Edgewater')
    expect(r.mutated).toBe(true)
    expect(r.rejected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// removeNearestCity
// ---------------------------------------------------------------------------

describe('removeNearestCity', () => {
  it('removes the nearest city within 8 cells', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    placeCity(world, cx - 5, cy, 'A')
    placeCity(world, cx + 5, cy, 'B')
    placeCity(world, cx, cy + 4, 'C')
    const r = removeNearestCity(world, cx - 4, cy)
    expect(r.matched).toBe(true)
    expect(r.removed!.name).toBe('A')
    expect(world.cities.map((c: City) => c.name)).toEqual(['B', 'C'])
  })

  it('chooses the closer city when two are in range', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    placeCity(world, cx - 1, cy, 'Near')
    placeCity(world, cx + 7, cy, 'Far')
    const r = removeNearestCity(world, cx, cy)
    expect(r.matched).toBe(true)
    expect(r.removed!.name).toBe('Near')
    expect(world.cities).toHaveLength(1)
  })

  it('picks within a Chebyshev ball of radius 8 (corners count)', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    placeCity(world, cx, cy, 'CornerCity')
    const r = removeNearestCity(world, cx + 8, cy + 8)
    expect(r.matched).toBe(true)
    expect(r.removed!.name).toBe('CornerCity')
  })

  it('returns matched=false when no city is within 8 cells', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    placeCity(world, cx, cy, 'Isolated')
    const r = removeNearestCity(world, cx + 9, cy)
    expect(r.matched).toBe(false)
    expect(r.removed).toBeNull()
    expect(world.cities).toHaveLength(1)
  })

  it('returns matched=false on an empty world', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const r = removeNearestCity(world, 0, 0)
    expect(r.matched).toBe(false)
    expect(r.removed).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// City names uniqueness
// ---------------------------------------------------------------------------

describe('city names are unique', () => {
  it('cityNameGenerator is deterministic for the same seed', () => {
    const a = cityNameGenerator(42)
    const b = cityNameGenerator(42)
    for (let i = 0; i < 5; i++) {
      expect(a()).toBe(b())
    }
  })

  it('cityNameGenerator produces non-empty names', () => {
    const gen = cityNameGenerator(99)
    for (let i = 0; i < 10; i++) {
      expect(gen().length).toBeGreaterThan(0)
    }
  })

  it('cities on the same world have unique names', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const cx = Math.floor(world.meta.width / 2)
    const cy = Math.floor(world.meta.height / 2)
    const names = new Set<string>()
    const gen = cityNameGenerator(world.meta.seed)
    const placed: string[] = []
    for (let i = 0; i < 5; i++) {
      const x = cx - 6 + i * 6
      const y = cy
      const result = placeCity(world, x, y, gen(names))
      if (result.mutated) {
        names.add(result.city!.name)
        placed.push(result.city!.name)
      }
    }
    expect(placed.length).toBeGreaterThan(1)
    expect(new Set(placed).size).toBe(placed.length)
  })

  it('a world with manually-set cities has unique names', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    world.cities.push({ x: 1, y: 1, name: 'A', seasonal: 0.5 })
    world.cities.push({ x: 2, y: 2, name: 'B', seasonal: 0.5 })
    world.cities.push({ x: 3, y: 3, name: 'C', seasonal: 0.5 })
    const names = world.cities.map((c: City) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
})