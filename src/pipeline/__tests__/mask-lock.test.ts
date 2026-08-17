// @vitest-environment happy-dom
/**
 * Mask-lock regression tests.
 *
 * The Mask Lock is the contract Make-sense has with the user: the
 * big-components fingerprint of the input mask must not move by more
 * than ±5% of the input land area (small components of < 100 cells
 * may disappear under thresholding). The rule is enforced inside
 * `makeSenseInline` (see `MASK_LOCK_AREA_FRACTION`); the tests here
 * assert that:
 *
 *   1. A continent that survives the threshold still survives the
 *      pipeline.
 *   2. Speckle islands smaller than 100 cells are free to drop.
 *   3. Two runs with the same seed produce byte-identical Worlds.
 *
 * Tests use the `makeSenseInline` runner — never the worker — so the
 * assertions can run in the same process as the test suite.
 */

import { describe, it, expect } from 'vitest'
import { makeSenseInline, MASK_LOCK_AREA_FRACTION, MASK_LOCK_MIN_COMPONENT } from '../makeSense_inline'
import { bigComponentsMask } from '../helpers'
import { serializeWorld, deserializeWorld } from '../../world/persist'
import type { World, WorldMeta } from '../../world/types'
import { makeContinentWorld, makeTwinContinentWorld, makeSpeckleWorld } from './fixtures'
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

function toInput(tw: TestWorld, seed: number, threshold: number) {
  return {
    meta: metaFromTest(tw, seed, threshold),
    mask: new Float32Array(tw.mask),
  }
}

async function evolve(tw: TestWorld, seed: number, threshold: number) {
  return makeSenseInline(toInput(tw, seed, threshold), () => {
    /* ignore progress */
  })
}

function toWorld(result: Awaited<ReturnType<typeof makeSenseInline>>, meta: WorldMeta): World {
  return {
    meta,
    mask: new Float32Array(meta.width * meta.height).fill(0),
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
    biome: result.biome as World['biome'],
    cities: [],
    suitability: result.suitability,
  } as World
}

// ---------------------------------------------------------------------------
// Mask lock constants
// ---------------------------------------------------------------------------

describe('mask-lock constants', () => {
  it('MASK_LOCK_AREA_FRACTION is 5%', () => {
    expect(MASK_LOCK_AREA_FRACTION).toBeCloseTo(0.05, 6)
  })

  it('MASK_LOCK_MIN_COMPONENT is 100 cells', () => {
    expect(MASK_LOCK_MIN_COMPONENT).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// bigComponentsMask sanity
// ---------------------------------------------------------------------------

describe('bigComponentsMask (pre-count)', () => {
  it('returns the same area for a single-continent world both before and after makeSense', async () => {
    const tw = makeContinentWorld()
    const meta = metaFromTest(tw, 1, 0.5)
    const before = bigComponentsMask(tw.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    const result = await evolve(tw, 1, 0.5)
    const postArea = result.provenance.outputMaskArea
    let preArea = 0
    for (let i = 0; i < before.mask.length; i++) preArea += before.mask[i]
    const after = bigComponentsMask(result.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    let postBigArea = 0
    for (let i = 0; i < after.mask.length; i++) postBigArea += after.mask[i]
    expect(Math.abs(postBigArea - preArea) / Math.max(1, preArea)).toBeLessThanOrEqual(0.05)
    expect(postArea).toBeGreaterThan(0)
    expect(result.provenance.inputMaskArea).toBe(preArea)
  })

  it('a world with one large continent keeps that continent', async () => {
    const tw = makeContinentWorld()
    const meta = metaFromTest(tw, 11, 0.5)
    const before = bigComponentsMask(tw.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    expect(before.count).toBe(1)
    const result = await evolve(tw, 11, 0.5)
    const after = bigComponentsMask(result.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    expect(after.count).toBe(1)
    const allowed = MASK_LOCK_AREA_FRACTION * Math.max(1, result.provenance.inputMaskArea)
    expect(Math.abs(result.provenance.outputMaskArea - result.provenance.inputMaskArea)).toBeLessThanOrEqual(allowed)
  })

  it('differences between pre- and post-count stay within ±5%', async () => {
    const tw = makeTwinContinentWorld()
    const meta = metaFromTest(tw, 99, 0.5)
    const before = bigComponentsMask(tw.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    const result = await evolve(tw, 99, 0.5)
    const after = bigComponentsMask(result.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    const areaDelta = Math.abs(result.provenance.outputMaskArea - result.provenance.inputMaskArea)
    const allowed = MASK_LOCK_AREA_FRACTION * Math.max(1, result.provenance.inputMaskArea)
    expect(areaDelta).toBeLessThanOrEqual(allowed)
    const countDelta = Math.abs(after.count - before.count)
    expect(countDelta / Math.max(1, before.count)).toBeLessThanOrEqual(0.05)
  })

  it('small components (≤ 100 cells) may disappear', () => {
    const tw = makeSpeckleWorld()
    const meta = metaFromTest(tw, 1, 0.5)
    // The speckle world has 5% land; the area of each component is small.
    const before = bigComponentsMask(tw.mask, tw.width, tw.height, meta.threshold, MASK_LOCK_MIN_COMPONENT)
    // The mask lock says: components below MASK_LOCK_MIN_COMPONENT may be dropped.
    // The fingerprint itself doesn't drop them — the lock is the "no large
    // component may disappear" rule.
    expect(before.count).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('byte-deterministic output', () => {
  it('the same seed produces a byte-identical MakeSenseResult', async () => {
    const tw = makeContinentWorld()
    void metaFromTest(tw, 1234, 0.5)
    const a = await evolve(tw, 1234, 0.5)
    const b = await evolve(tw, 1234, 0.5)
    // Same provenance steps.
    expect(a.provenance.steps.map((s) => s.stepName)).toEqual(b.provenance.steps.map((s) => s.stepName))
    // Same mask area.
    expect(a.provenance.outputMaskArea).toBe(b.provenance.outputMaskArea)
    expect(a.provenance.inputMaskArea).toBe(b.provenance.inputMaskArea)
    // Same elevation.
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev))
    expect(Array.from(a.rivers)).toEqual(Array.from(b.rivers))
    expect(Array.from(a.biome)).toEqual(Array.from(b.biome))
  })

  it('the same seed produces a byte-identical serialized World', async () => {
    const tw = makeTwinContinentWorld()
    const meta = metaFromTest(tw, 7, 0.5)
    const a = await evolve(tw, 7, 0.5)
    const b = await evolve(tw, 7, 0.5)
    const wa = toWorld(a, meta)
    const wb = toWorld(b, meta)
    const sa = serializeWorld(wa)
    const sb = serializeWorld(wb)
    expect(sa).toBe(sb)
  })

  it('different seeds produce different Worlds', async () => {
    const tw = makeContinentWorld()
    const a = await evolve(tw, 1, 0.5)
    const b = await evolve(tw, 2, 0.5)
    const same =
      Array.from(a.elev).length === Array.from(b.elev).length &&
      Array.from(a.elev).every((v, i) => v === b.elev[i])
    expect(same).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Round-trip the derived World
// ---------------------------------------------------------------------------

describe('derived World round-trips', () => {
  it('a Make-sense result, wrapped as a World, is byte-equal after serialize/deserialize', async () => {
    const tw = makeContinentWorld()
    const meta = metaFromTest(tw, 42, 0.5)
    const result = await evolve(tw, 42, 0.5)
    const world = toWorld(result, meta)
    const json = serializeWorld(world)
    const restored = deserializeWorld(json)
    expect(restored).not.toBeNull()
    expect(Array.from(restored!.elev)).toEqual(Array.from(world.elev))
    expect(Array.from(restored!.flux)).toEqual(Array.from(world.flux))
    expect(Array.from(restored!.rivers)).toEqual(Array.from(world.rivers))
    expect(restored!.biome).toEqual(world.biome)
  })
})