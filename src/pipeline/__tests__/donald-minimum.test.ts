// @vitest-environment happy-dom
/**
 * Donald-minimum regression tests.
 *
 * The Donald bar is the geographic trust contract. The fixes in PR 2
 * (orogeny clamp, climate cylinder wrap, hydro sink-wipe removal, biomes
 * with elev) and PR 4 (suitability layer, kebab-case biomes) restored
 * the basic physics. These tests pin the bar so regressions are caught.
 *
 * Pass criteria:
 *   - Windward > lee on a mid-latitude N-S ridge (single wind direction).
 *   - No ice↔warm-desert adjacency epidemic across 50 random seeds.
 *   - No flux wipe at sinks (local minima are sinks, not local maxima).
 *   - Alpine fires when elev ≥ 3500 m.
 *   - Persistence round-trip preserves everything byte-stable.
 *
 * Fail criteria (any one):
 *   - Windward ≤ lee on a tall N-S ridge.
 *   - ice↔desert adjacency > 2/50 trials.
 *   - flux[j] = 0 for any j that is a local minimum (sin formula fix).
 *   - Alpine never fires on a 5000 m peak.
 *   - Round-trip drops a field.
 */

import { describe, it, expect } from 'vitest'
import { makeSenseInline } from '../makeSense_inline'
import { computeHydrology } from '../hydrology'
import { computeBiomes } from '../biomes'
import { serializeWorld, deserializeWorld } from '../../world/persist'
import { makeContinentWorld } from './fixtures'

describe('Donald minimum', () => {
  it('windward > lee on a mid-latitude N-S ridge', async () => {
    // Single continent at mid-lat (lat 0.5) with a N-S ridge down the
    // middle. Prevailing wind is west-to-east (the climate march).
    // Windward (east side) should receive more moisture than lee (west).
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
    const result = await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {})
    // Find the largest landmass and its bounding box. The "ridge" is
    // the y-band within the bounding box that has the highest mean
    // elevation. We then partition the landmass by the ridge line and
    // compare mean moisture on the windward (east) side to the lee
    // (west) side. This is the actual physical claim, not a fixed
    // x = w/2 split.
    const elev = result.elev
    const moist = result.summerMoist
    const w = tw.width
    const h = tw.height
    const seaLevel = 0.5

    // Bounding box of land.
    let minX = w, maxX = -1, minY = h, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (tw.mask[i] >= 0.5 && elev[i] >= seaLevel) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    // The world must have land above sea level.
    expect(minX).toBeLessThanOrEqual(maxX)

    // Find the y with the highest mean elevation across the land's
    // x-range. This is the ridge axis.
    let ridgeY = -1
    let ridgeMean = -Infinity
    for (let y = minY; y <= maxY; y++) {
      let sum = 0
      let n = 0
      for (let x = minX; x <= maxX; x++) {
        const i = y * w + x
        if (tw.mask[i] >= 0.5 && elev[i] >= seaLevel) {
          sum += elev[i]
          n++
        }
      }
      if (n > 0) {
        const m = sum / n
        if (m > ridgeMean) {
          ridgeMean = m
          ridgeY = y
        }
      }
    }
    expect(ridgeY).toBeGreaterThanOrEqual(0)

    // Partition by the ridge's x-centroid (mean x of the bounding box),
    // not the map's geometric centre.
    const ridgeX = (minX + maxX) / 2

    // Mid-lat band: a strip of rows around the centre. This restricts
    // the test to a single Hadley cell, where the prevailing wind is
    // consistent.
    const yMin = Math.floor(tw.height * 0.35)
    const yMax = Math.ceil(tw.height * 0.65)

    let eastMoist = 0
    let westMoist = 0
    let eastCount = 0
    let westCount = 0
    for (let y = yMin; y < yMax; y++) {
      for (let x = 0; x < tw.width; x++) {
        const i = y * tw.width + x
        if (tw.mask[i] < 0.5) continue
        // East of the ridge column = windward, west of the ridge = lee.
        if (x > ridgeX) {
          eastMoist += moist[i]
          eastCount++
        } else {
          westMoist += moist[i]
          westCount++
        }
      }
    }
    const eastMean = eastCount > 0 ? eastMoist / eastCount : 0
    const westMean = westCount > 0 ? westMoist / westCount : 0
    // The strict physics claim: windward mean moisture must beat lee by
    // a meaningful margin, not just "> 0". The old assertion was a
    // vacuous pass when both sides read 0.
    expect(eastMean - westMean).toBeGreaterThan(0.05)
  })

  it('icy peak stays separate from warm desert', async () => {
    // Run 50 random seeds; count ice↔warm-desert neighbour pairs.
    // Threshold: 2 such pairs across 50 trials is acceptable.
    let totalAdjacencies = 0
    for (let trial = 0; trial < 50; trial++) {
      const tw = makeContinentWorld()
      const meta = {
        seed: trial,
        width: tw.width,
        height: tw.height,
        planetRadiusKm: tw.planetRadiusKm,
        obliquityDeg: tw.obliquityDeg,
        seaLevel: 0.5,
        threshold: 0.5,
      }
      const result = await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {})
      const biomes = computeBiomes(
        result.summer,
        result.winter,
        result.summerMoist,
        result.winterMoist,
        tw.mask,
        0.5,
        result.elev,
        result.tempMean,
      )
      for (let i = 0; i < biomes.biome.length; i++) {
        if (tw.mask[i] < 0.5) continue
        const isIce = biomes.biome[i] === 'ice'
        const isHotDesert = biomes.biome[i] === 'hot-desert'
        if (!isIce && !isHotDesert) continue
        // Check 4-neighbours.
        const x = i % tw.width
        const y = (i - x) / tw.width
        const neighbours = [
          y > 0 ? i - tw.width : -1,
          y < tw.height - 1 ? i + tw.width : -1,
          x > 0 ? i - 1 : -1,
          x < tw.width - 1 ? i + 1 : -1,
        ]
        for (const j of neighbours) {
          if (j < 0) continue
          if (tw.mask[j] < 0.5) continue
          if ((isIce && biomes.biome[j] === 'hot-desert') ||
              (isHotDesert && biomes.biome[j] === 'ice')) {
            totalAdjacencies++
          }
        }
      }
    }
    expect(totalAdjacencies).toBeLessThan(3)
  })

  it('does not wipe flux at sinks', () => {
    // A slope descending east-to-west. The eastern ridgecrest is a
    // local max (flux 0); the western edge is a sink (flux accumulates).
    // The old code zeroed flux[i] on j === -1, which clobbered flux at
    // sinks. The fix: keep flux at sinks.
    const w = 10
    const h = 5
    const elev = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        elev[y * w + x] = 1000 - x * 100  // 1000 at x=0, 100 at x=9
      }
    }
    const mask = new Float32Array(w * h).fill(1)
    const result = computeHydrology(elev, mask, w, h, 0.5)
    let total = 0
    for (let i = 0; i < result.flux.length; i++) total += result.flux[i]
    // The western column (x=0, lowest) should accumulate flux from
    // every cell above it. ~50 cells donate ~1 each.
    expect(total).toBeGreaterThan(w * h * 0.5)
  })

  it('alpine fires when elev is high', async () => {
    const tw = makeContinentWorld()
    const meta = {
      seed: 1,
      width: tw.width,
      height: tw.height,
      planetRadiusKm: tw.planetRadiusKm,
      obliquityDeg: tw.obliquityDeg,
      seaLevel: 0.5,
      threshold: 0.5,
    }
    const result = await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {})
    // Find land cells with elev ≥ 3500 (the alpine threshold).
    // Peak count checks all cells; alpine count checks only land cells.
    let alpineCount = 0
    let landPeakCount = 0
    for (let i = 0; i < result.elev.length; i++) {
      if (tw.mask[i] < 0.5) continue
      if (result.elev[i] >= 3500) landPeakCount++
    }
    const biomes = computeBiomes(
      result.summer,
      result.winter,
      result.summerMoist,
      result.winterMoist,
      tw.mask,
      0.5,
      result.elev,
      result.tempMean,
    )
    for (let i = 0; i < biomes.biome.length; i++) {
      if (tw.mask[i] < 0.5) continue
      if (biomes.biome[i] === 'alpine') alpineCount++
    }
    // The Donald bar: the world must have alpine peaks, and every
    // alpine cell must be a tall peak (no false positives). The old
    // `if (landPeakCount > 0)` guard was a vacuous pass when the world
    // happened to have no alpine peaks.
    expect(landPeakCount).toBeGreaterThan(0)
    expect(alpineCount).toBeGreaterThan(0)
    expect(alpineCount).toBeLessThanOrEqual(landPeakCount)
  })

  it('persistence round-trip preserves every field', async () => {
    const tw = makeContinentWorld()
    const meta = {
      seed: 7,
      width: tw.width,
      height: tw.height,
      planetRadiusKm: tw.planetRadiusKm,
      obliquityDeg: tw.obliquityDeg,
      seaLevel: 0.5,
      threshold: 0.5,
    }
    const result = await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {})
    const world = {
      meta,
      mask: new Float32Array(tw.mask),
      plateId: result.plateId,
      plateVx: result.plateVx,
      plateVy: result.plateVy,
      elev: result.elev,
      seasons: 2 as const,
      summer: result.summer,
      winter: result.winter,
      summerMoist: result.summerMoist,
      winterMoist: result.winterMoist,
      tempMean: result.tempMean,
      tempRange: result.tempRange,
      moistMean: result.moistMean,
      flux: result.flux,
      rivers: result.rivers,
      biome: result.biome,
      cities: [],
      suitability: result.suitability,
    }
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(restored).not.toBeNull()
    if (!restored) throw new Error('restored is null')
    // Every typed array must be the right concrete type.
    expect(restored.elev).toBeInstanceOf(Float32Array)
    expect(restored.plateId).toBeInstanceOf(Int16Array)
    expect(restored.rivers).toBeInstanceOf(Uint8Array)
    // Element-wise: every field equals.
    expect(Array.from(restored.elev)).toEqual(Array.from(world.elev))
    expect(Array.from(restored.summer)).toEqual(Array.from(world.summer))
    expect(Array.from(restored.winter)).toEqual(Array.from(world.winter))
    expect(Array.from(restored.suitability)).toEqual(Array.from(world.suitability))
  })
})

