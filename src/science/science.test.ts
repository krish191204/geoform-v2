// @vitest-environment happy-dom
/**
 * Product data science: analog pick, gravity monotonicity, climate fit
 * as a silent measurement. No UI RMSE.
 */

import { describe, expect, it } from 'vitest'
import { analogAt, PLACE_ANALOGS } from '../sketch/analogs'
import { EARTH_ANALOG_CENTROIDS } from './earth'
import { fitZonalClimate } from './fitClimate'
import { gravityFlow } from './gravity'
import { matchAnalogAt, matchFeatures } from './matchAnalog'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'
import { emptyPolityState, type CellBiome, type World, type WorldMeta } from '../world/types'

function stampWorld(opts: {
  biome: CellBiome
  temp: number
  range: number
  moist: number
  elev: number
  flux?: number
  river?: number
}): World {
  const meta: WorldMeta = {
    seed: 1,
    width: 8,
    height: 6,
    planetRadiusKm: 6371,
    obliquityDeg: 23.5,
    seaLevel: 0.5,
    threshold: 0.5,
  }
  const n = meta.width * meta.height
  const mask = new Float32Array(n)
  const biome = new Array<CellBiome>(n).fill('ocean')
  const tempMean = new Float32Array(n)
  const tempRange = new Float32Array(n)
  const moistMean = new Float32Array(n)
  const elev = new Float32Array(n)
  const flux = new Float32Array(n)
  const rivers = new Uint8Array(n)
  const x = 2
  const y = 2
  const i = y * meta.width + x
  mask[i] = 1
  biome[i] = opts.biome
  tempMean[i] = opts.temp
  tempRange[i] = opts.range
  moistMean[i] = opts.moist
  elev[i] = opts.elev
  flux[i] = opts.flux ?? 0
  rivers[i] = opts.river ?? 0
  return {
    meta,
    mask,
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev,
    seasons: 2,
    summer: new Float32Array(n),
    winter: new Float32Array(n),
    summerMoist: new Float32Array(n),
    winterMoist: new Float32Array(n),
    tempMean,
    tempRange,
    moistMean,
    flux,
    rivers,
    biome,
    suitability: new Float32Array(n).fill(0.5),
    cities: [],
    ...emptyPolityState(n),
  }
}

describe('gravityFlow', () => {
  it('farther pairs carry less volume', () => {
    const near = gravityFlow(4, 4, 8, 'land')
    const far = gravityFlow(4, 4, 40, 'land')
    expect(near).toBeGreaterThan(far)
  })

  it('sea is cheaper than land at the same distance', () => {
    const land = gravityFlow(4, 4, 12, 'land')
    const sea = gravityFlow(4, 4, 12, 'sea')
    expect(sea).toBeGreaterThan(land)
  })
})

describe('analog match', () => {
  it('a monsoon centroid is monsoon-delta, not tundra', () => {
    const id = matchFeatures(EARTH_ANALOG_CENTROIDS['monsoon-delta']).id
    expect(id).toBe('monsoon-delta')
    expect(id).not.toBe('tundra-edge')
  })

  it('hot wet coastal lowland feels like a monsoon delta', () => {
    const world = stampWorld({
      biome: 'rainforest',
      temp: 26,
      range: 6,
      moist: 0.8,
      elev: 40,
      flux: 12,
    })
    expect(analogAt(world, 2, 2)?.id).toBe('monsoon-delta')
    expect(matchAnalogAt(world, 2, 2)?.id).toBe('monsoon-delta')
  })

  it('oasis override still wins on a wet desert cell', () => {
    const world = stampWorld({
      biome: 'hot-desert',
      temp: 24,
      range: 16,
      moist: 0.35,
      elev: 200,
      river: 1,
    })
    expect(analogAt(world, 2, 2)?.id).toBe('oasis-corridor')
  })

  it('labels landscapes, never ethnicities', () => {
    const banned =
      /\bethnic\b|\bethnicity\b|\bhan\b|\barab\b|\bslav\b|\bgermanic\b|\bcelt\b|\bbantu\b|\bhindu\b|\bjewish\b|\blatin people\b|\bchinese\b|\bjapanese\b/i
    for (const analog of Object.values(PLACE_ANALOGS)) {
      expect(`${analog.label} ${analog.because} ${analog.tradition}`).not.toMatch(banned)
    }
  })
})

describe('fitZonalClimate', () => {
  it('does not write climate arrays', async () => {
    const tw = makeContinentWorld()
    const meta = {
      seed: 42,
      width: tw.width,
      height: tw.height,
      planetRadiusKm: tw.planetRadiusKm,
      obliquityDeg: tw.obliquityDeg,
      seaLevel: 0.5,
      threshold: 0.5,
    }
    const world = worldFromMakeSense(
      await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {}),
      meta,
      tw.mask,
    )
    const before = {
      temp: Array.from(world.tempMean),
      elev: Array.from(world.elev),
      biome: world.biome.slice(),
    }
    const fit = fitZonalClimate(world)
    expect(Array.from(world.tempMean)).toEqual(before.temp)
    expect(Array.from(world.elev)).toEqual(before.elev)
    expect(world.biome).toEqual(before.biome)
    expect(fit.bands.length).toBeGreaterThan(0)
    const equator = fit.bands.reduce((best, b) => (Math.abs(b.lat) < Math.abs(best.lat) ? b : best))
    const pole = fit.bands.reduce((best, b) => (Math.abs(b.lat) > Math.abs(best.lat) ? b : best))
    expect(equator.planetC).toBeGreaterThan(pole.planetC)
  })
})
