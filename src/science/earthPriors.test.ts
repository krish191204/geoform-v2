/**
 * Synthetic worlds for Köppen area scores and Hack's law.
 * No Make-sense run.
 */

import { describe, expect, it } from 'vitest'
import { emptyPolityState, type CellBiome, type World, type WorldMeta } from '../world/types'
import { BIOME_KOPPEN, EARTH_KOPPEN_LAND_FRACTION, areaFractions, scoreBiomeMix } from './earthPriors'
import { scoreRiverLaws } from './riverLaws'

function worldOf(opts: {
  width: number
  height: number
  biome: CellBiome[]
  mask?: Float32Array
  flux?: Float32Array
  rivers?: Uint8Array
}): World {
  const n = opts.width * opts.height
  const meta: WorldMeta = {
    seed: 1,
    width: opts.width,
    height: opts.height,
    planetRadiusKm: 6371,
    obliquityDeg: 23.5,
    seaLevel: 0.5,
    threshold: 0.5,
  }
  const mask = opts.mask ?? new Float32Array(n).fill(1)
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
    flux: opts.flux ?? new Float32Array(n),
    rivers: opts.rivers ?? new Uint8Array(n),
    biome: opts.biome,
    suitability: new Float32Array(n),
    cities: [],
    ...emptyPolityState(n),
  }
}

describe('areaFractions', () => {
  it('maps every land biome onto a Peel group', () => {
    expect(BIOME_KOPPEN.rainforest).toBe('A')
    expect(BIOME_KOPPEN['hot-desert']).toBe('B')
    expect(BIOME_KOPPEN.mediterranean).toBe('C')
    expect(BIOME_KOPPEN.taiga).toBe('D')
    expect(BIOME_KOPPEN.tundra).toBe('E')
    expect(BIOME_KOPPEN.alpine).toBe('E')
    expect(BIOME_KOPPEN.mangrove).toBe('A')
    expect(BIOME_KOPPEN.wetland).toBe('D')
    const sum =
      EARTH_KOPPEN_LAND_FRACTION.A +
      EARTH_KOPPEN_LAND_FRACTION.B +
      EARTH_KOPPEN_LAND_FRACTION.C +
      EARTH_KOPPEN_LAND_FRACTION.D +
      EARTH_KOPPEN_LAND_FRACTION.E
    expect(sum).toBeCloseTo(1, 6)
  })

  it('scores a tropical continent as all group A', () => {
    const world = worldOf({
      width: 4,
      height: 1,
      biome: ['rainforest', 'savanna', 'mangrove', 'ocean'],
      mask: Float32Array.from([1, 1, 1, 0]),
    })
    const f = areaFractions(world)
    expect(f.A).toBeCloseTo(1, 6)
    expect(f.B + f.C + f.D + f.E).toBeCloseTo(0, 6)
  })

  it('weights equatorial land more than polar land', () => {
    const height = 5
    const width = 2
    const biome: CellBiome[] = new Array(width * height).fill('ocean')
    const mask = new Float32Array(width * height)
    for (const y of [0, 2]) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        mask[i] = 1
        biome[i] = y === 0 ? 'ice' : 'rainforest'
      }
    }
    const f = areaFractions(worldOf({ width, height, biome, mask }))
    expect(f.A).toBeGreaterThan(f.E)
  })

  it('returns zeros when there is no land', () => {
    const world = worldOf({
      width: 2,
      height: 2,
      biome: ['ocean', 'ocean', 'ocean', 'ocean'],
      mask: new Float32Array(4),
    })
    const f = areaFractions(world)
    expect(f).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 })
  })
})

describe('scoreBiomeMix', () => {
  it('reports absolute error and allows a one-continent miss', () => {
    const world = worldOf({
      width: 6,
      height: 1,
      biome: ['ice', 'ice', 'ice', 'ice', 'ice', 'ice'],
    })
    const before = world.biome.slice()
    const score = scoreBiomeMix(world)
    expect(world.biome).toEqual(before)
    expect(score.absError.E).toBeCloseTo(1 - EARTH_KOPPEN_LAND_FRACTION.E, 6)
    expect(score.absError.A).toBeCloseTo(EARTH_KOPPEN_LAND_FRACTION.A, 6)
    expect(score.note).toMatch(/one-continent/i)
    expect(score.note).toMatch(/allowed/i)
    expect(score.note).not.toMatch(/\n/)
  })

  it('does not excuse two continents that miss Earth', () => {
    const biome: CellBiome[] = ['ice', 'ice', 'ocean', 'ice', 'ice', 'ocean']
    const mask = Float32Array.from([1, 1, 0, 1, 1, 0])
    const score = scoreBiomeMix(worldOf({ width: 6, height: 1, biome, mask }))
    expect(score.note).toMatch(/misses/i)
    expect(score.note).not.toMatch(/allowed/i)
  })

  it('is quiet when the mix matches Peel fractions', () => {
    const counts: Record<CellBiome, number> = {
      ocean: 0,
      rainforest: 190,
      savanna: 0,
      mangrove: 0,
      'hot-desert': 302,
      steppe: 0,
      'boreal-desert': 0,
      mediterranean: 0,
      'temperate-forest': 134,
      'temperate-deciduous': 0,
      taiga: 246,
      wetland: 0,
      ice: 128,
      'polar-desert': 0,
      tundra: 0,
      alpine: 0,
    }
    const biome: CellBiome[] = []
    for (const [id, n] of Object.entries(counts) as [CellBiome, number][]) {
      for (let i = 0; i < n; i++) biome.push(id)
    }
    const score = scoreBiomeMix(worldOf({ width: biome.length, height: 1, biome }))
    for (const g of ['A', 'B', 'C', 'D', 'E'] as const) {
      expect(score.absError[g]).toBeLessThan(1e-9)
    }
    expect(score.note).toMatch(/near|close/i)
  })
})

describe('scoreRiverLaws', () => {
  it('does not apply when the river mask is a trickle', () => {
    const n = 8
    const rivers = new Uint8Array(n)
    const flux = new Float32Array(n)
    rivers[1] = 1
    rivers[2] = 1
    flux[1] = 2
    flux[2] = 4
    const score = scoreRiverLaws(
      worldOf({
        width: n,
        height: 1,
        biome: new Array(n).fill('temperate-forest'),
        rivers,
        flux,
      }),
    )
    expect(score.h).toBeNull()
    expect(score.note).toMatch(/does not apply yet/i)
    expect(score.note).toMatch(/too few river cells/i)
  })

  it('recovers h near 0.5 when area grows as length squared', () => {
    const width = 40
    const height = 5
    const n = width * height
    const rivers = new Uint8Array(n)
    const flux = new Float32Array(n)
    const stems = [
      { y: 0, cells: 4 },
      { y: 2, cells: 7 },
      { y: 4, cells: 10 },
    ]
    for (const stem of stems) {
      const length = stem.cells - 1
      for (let s = 0; s < stem.cells; s++) {
        const i = stem.y * width + s
        rivers[i] = 1
        flux[i] = s === stem.cells - 1 ? length * length : s + 1
      }
    }
    const world = worldOf({
      width,
      height,
      biome: new Array(n).fill('temperate-forest'),
      rivers,
      flux,
    })
    const riversBefore = Array.from(world.rivers)
    const score = scoreRiverLaws(world)
    expect(Array.from(world.rivers)).toEqual(riversBefore)
    expect(score.h).not.toBeNull()
    expect(score.h as number).toBeGreaterThanOrEqual(0.5)
    expect(score.h as number).toBeLessThanOrEqual(0.6)
    expect(score.note).toMatch(/Earth neighbourhood/)
  })
})
