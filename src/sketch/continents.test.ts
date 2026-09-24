import { describe, expect, it } from 'vitest'
import { fillContinent, listContinents } from './continents'
import { DEFAULT_META, emptyPolityState, type World } from '../world/types'

function plate(paint: (mask: Float32Array, w: number, h: number) => void): World {
  const width = 40
  const height = 20
  const n = width * height
  const mask = new Float32Array(n)
  paint(mask, width, height)
  return {
    meta: { ...DEFAULT_META, seed: 9, width, height, threshold: 0.5 },
    mask,
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n).fill(80),
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
    biome: new Array(n).fill('temperate-deciduous'),
    suitability: new Float32Array(n).fill(0.7),
    cities: [],
    ...emptyPolityState(n),
  }
}

describe('continents', () => {
  it('lists each large landmass and skips a speck', () => {
    const world = plate((mask, w, h) => {
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < 16; x++) mask[y * w + x] = 1
        for (let x = 22; x < 36; x++) mask[y * w + x] = 1
      }
      mask[0] = 1
    })
    const lands = listContinents(world)
    expect(lands).toHaveLength(2)
    expect(lands[0].cells).toBeGreaterThanOrEqual(lands[1].cells)
    expect(lands.every((c) => c.span >= 12 && c.name.length > 0 && c.mirror === 0)).toBe(true)
  })

  it('counts an aged mirror only on the land that holds it', () => {
    const world = plate((mask, w, h) => {
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < 16; x++) mask[y * w + x] = 1
        for (let x = 22; x < 36; x++) mask[y * w + x] = 1
      }
    })
    world.sites = new Uint8Array(world.meta.width * world.meta.height)
    world.sites[4 * world.meta.width + 6] = 1
    world.sites[4 * world.meta.width + 28] = 5
    const lands = listContinents(world)
    const west = lands.find((c) => c.x < 16)
    const east = lands.find((c) => c.x > 16)
    expect(west?.mirror).toBe(1)
    expect(west?.slot).toBe(0)
    expect(east?.slot).toBe(1)
    expect(east?.mirror).toBe(0)
  })

  it('founds towns only on the continent that was opened', () => {
    const world = plate((mask, w, h) => {
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < 16; x++) mask[y * w + x] = 1
        for (let x = 22; x < 36; x++) mask[y * w + x] = 1
      }
    })
    const [first] = listContinents(world)
    const added = fillContinent(world, first.id)
    expect(added).toBeGreaterThan(0)
    expect(world.cities.length).toBeGreaterThan(0)
    for (const city of world.cities) {
      expect(city.x).toBeGreaterThanOrEqual(2)
      expect(city.x).toBeLessThan(16)
    }
    void added
  })
})
