import { describe, it, expect } from 'vitest'
import { computeSuitability } from './suitability'
import { makeContinentWorld } from './__tests__/fixtures'

// ---------------------------------------------------------------------------
// Test fixture helper
// ---------------------------------------------------------------------------

interface TestContinent {
  width: number
  height: number
  biome: string[]
  flux: Float32Array
  rivers: Uint8Array
  mask: Float32Array
  summer: Float32Array
  winter: Float32Array
}

/**
 * Build a deterministic continent-shaped test world on top of `makeContinentWorld`.
 * The mask is copied so each test can mutate it without bleeding state.
 */
function buildContinent(biome = 'temperate forest'): TestContinent {
  const world = makeContinentWorld()
  const n = world.width * world.height
  return {
    width: world.width,
    height: world.height,
    biome: Array.from({ length: n }, () => biome),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    mask: new Float32Array(world.mask),
    summer: new Float32Array(n).fill(20),
    winter: new Float32Array(n).fill(0),
  }
}

function run(w: TestContinent) {
  return computeSuitability(
    w.biome,
    w.flux,
    w.rivers,
    w.mask,
    w.summer,
    w.winter,
    w.width,
    w.height,
    0.5,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeSuitability', () => {
  it('gives a temperate-forest cell suitability > 0.8 with default climate', () => {
    const w = buildContinent('temperate forest')
    const { suitability } = run(w)
    // Continental centre — interior cell, no river, no flux, mild winter.
    const ci = 16 * w.width + 32
    expect(suitability[ci]).toBeGreaterThan(0.8)
  })

  it('gives a tropical-desert cell suitability < 0.3', () => {
    const w = buildContinent('tropical desert')
    const { suitability } = run(w)
    const ci = 16 * w.width + 32
    expect(suitability[ci]).toBeLessThan(0.3)
  })

  it('gives an ice cell suitability = 0', () => {
    const w = buildContinent('ice')
    const { suitability } = run(w)
    const ci = 16 * w.width + 32
    expect(suitability[ci]).toBe(0)
  })

  it('boosts a cell adjacent to a river', () => {
    const w = buildContinent('temperate forest')
    // River at (3, 16) on the equator of the test continent — neighbour (4, 16) gets the bonus.
    w.rivers[16 * w.width + 3] = 1
    const { suitability } = run(w)
    const nearRiver = 16 * w.width + 4
    const farFromRiver = 16 * w.width + 16
    expect(suitability[nearRiver]).toBeGreaterThan(suitability[farFromRiver])
  })

  it('penalises cells with flux > 100 vs low-flux neighbours', () => {
    const w = buildContinent('temperate forest')
    // flux > 100 → both penalties (-0.5). flux = 0 → no penalty.
    w.flux[16 * w.width + 10] = 200
    w.flux[16 * w.width + 14] = 0
    const { suitability } = run(w)
    expect(suitability[16 * w.width + 10]).toBeLessThan(suitability[16 * w.width + 14])
  })

  it('keeps suitability in [0, 1] for every cell under mixed inputs', () => {
    const w = buildContinent('temperate forest')
    // Mix biomes across the continent.
    w.biome[0] = 'ice'
    w.biome[1] = 'tropical desert'
    w.biome[2] = 'tundra'
    w.biome[3] = 'rainforest'
    w.biome[4] = 'mediterranean'
    w.biome[5] = 'boreal desert'
    // Push flux, rivers, and winter to their extremes.
    w.flux[10] = 500
    w.flux[11] = 75
    w.rivers[20] = 1
    w.rivers[21] = 1
    w.rivers[22] = 1
    w.rivers[23] = 1
    w.rivers[24] = 1
    w.winter[30] = -50
    w.winter[31] = -10
    const { suitability } = run(w)
    for (let i = 0; i < suitability.length; i++) {
      expect(suitability[i]).toBeGreaterThanOrEqual(0)
      expect(suitability[i]).toBeLessThanOrEqual(1)
    }
  })
})