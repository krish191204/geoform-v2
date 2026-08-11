import { describe, it, expect } from 'vitest'
import {
  classifyBiome,
  recomputeClimate,
  recomputeHydrology,
  recomputeBiomes,
  evaluateSuitability,
  recomputeSuitability,
} from './climate'
import { generateWorld } from './generate'

const idx = (w: number, x: number, y: number) => y * w + x

describe('climate', () => {
  it('classifyBiome distinguishes ocean/coast/land biomes', () => {
    expect(classifyBiome(0.1, 0.4, 0.5, 0.5)).toBe('ocean')
    expect(classifyBiome(0.39, 0.4, 0.5, 0.5)).toBe('coast')
    expect(classifyBiome(0.6, 0.4, 0.5, 0.5)).toMatch(/desert|grassland|forest|savanna|alpine/)
    expect(classifyBiome(0.85, 0.4, 0.5, 0.5)).toBe('alpine')
  })

  it('recomputeClimate fills temp and moist for every cell', () => {
    const world = generateWorld(24, 12, 1)
    // Reset so we can see recompute fills cells.
    world.temp.fill(0)
    world.moist.fill(0)
    recomputeClimate(world)
    for (let i = 0; i < world.width * world.height; i++) {
      expect(world.temp[i]).toBeGreaterThanOrEqual(0)
      expect(world.temp[i]).toBeLessThanOrEqual(1)
      expect(world.moist[i]).toBeGreaterThanOrEqual(0)
      expect(world.moist[i]).toBeLessThanOrEqual(1)
    }
  })

  it('recomputeHydrology produces zero or positive flux', () => {
    const world = generateWorld(20, 16, 7)
    world.flux.fill(-1)
    recomputeHydrology(world)
    for (let i = 0; i < world.flux.length; i++) {
      expect(world.flux[i]).toBeGreaterThanOrEqual(0)
    }
  })

  it('recomputeBiomes labels every cell', () => {
    const world = generateWorld(16, 12, 3)
    recomputeBiomes(world)
    for (let i = 0; i < world.biome.length; i++) {
      expect(world.biome[i]).toBeTruthy()
      expect(typeof world.biome[i]).toBe('string')
    }
  })

  it('evaluateSuitability returns a 0..1 score with reasons', () => {
    const world = generateWorld(32, 24, 11)
    const result = evaluateSuitability(world, 16, 12)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(1)
    expect(Array.isArray(result.reasons)).toBe(true)
    expect(typeof result.ok).toBe('boolean')
  })

  it('recomputeSuitability fills suitability for every cell', () => {
    const world = generateWorld(20, 16, 21)
    world.suitability.fill(-1)
    recomputeSuitability(world)
    for (let i = 0; i < world.suitability.length; i++) {
      const s = world.suitability[i]
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })

  it('ocean cells have low suitability', () => {
    const world = generateWorld(24, 16, 5)
    // Force an ocean cell by setting elevation below sea level.
    const w = world.width
    const ci = idx(w, 0, 0)
    world.elev[ci] = world.seaLevel - 0.1
    recomputeSuitability(world)
    expect(world.suitability[ci]).toBe(0)
    expect(evaluateSuitability(world, 0, 0).ok).toBe(false)
  })
})
