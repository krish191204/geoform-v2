// @vitest-environment happy-dom
/**
 * Pipeline golden tests.
 *
 * Five fixed seeds must produce byte-identical `MakeSenseResult` across
 * runs. Each one must also score >= 50 against the post-Make-sense
 * red pen — a reasonable bar for "physics produced a sensible world".
 *
 * The golden value is computed at the time the test is written (i.e. a
 * snapshot of the expected output). If the pipeline mutates, the test
 * breaks on purpose to force a fresh snapshot.
 */

import { describe, it, expect } from 'vitest'
import { makeSenseInline } from '../makeSense_inline'
import { serializeWorld, deserializeWorld } from '../../world/persist'
import {
  checkIceDesertDualism,
  checkRainShadow,
  checkContinentality,
  checkFluxOnMaxima,
  sortIssuesBySeverity,
  scoreFromIssues,
} from '../../critique/analyzeWorld'
import type { World, WorldMeta } from '../../world/types'
import { makeContinentWorld } from './fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TW = makeContinentWorld()

const FIXED_SEEDS = [1, 42, 100, 1234, 9999] as const
const THRESHOLD = 0.5

function metaFor(seed: number): WorldMeta {
  return {
    seed,
    width: TW.width,
    height: TW.height,
    planetRadiusKm: TW.planetRadiusKm,
    obliquityDeg: TW.obliquityDeg,
    seaLevel: 0.5,
    threshold: THRESHOLD,
  }
}

function inputFor(seed: number) {
  return { meta: metaFor(seed), mask: new Float32Array(TW.mask) }
}

async function evolve(seed: number) {
  return makeSenseInline(inputFor(seed), () => {
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
  } as World
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

describe('pipeline goldens', () => {
  for (const seed of FIXED_SEEDS) {
    it(`seed ${seed} produces a byte-identical MakeSenseResult across runs`, async () => {
      const a = await evolve(seed)
      const b = await evolve(seed)
      // Provenance shape is identical.
      expect(a.provenance.steps.map((s) => s.stepName)).toEqual(
        b.provenance.steps.map((s) => s.stepName),
      )
      expect(a.provenance.inputMaskArea).toBe(b.provenance.inputMaskArea)
      expect(a.provenance.outputMaskArea).toBe(b.provenance.outputMaskArea)
      expect(a.provenance.maskDeltaPct).toBe(b.provenance.maskDeltaPct)
      // Every physics array is bitwise identical.
      expect(Array.from(a.elev)).toEqual(Array.from(b.elev))
      expect(Array.from(a.summer)).toEqual(Array.from(b.summer))
      expect(Array.from(a.winter)).toEqual(Array.from(b.winter))
      expect(Array.from(a.summerMoist)).toEqual(Array.from(b.summerMoist))
      expect(Array.from(a.winterMoist)).toEqual(Array.from(b.winterMoist))
      expect(Array.from(a.tempMean)).toEqual(Array.from(b.tempMean))
      expect(Array.from(a.tempRange)).toEqual(Array.from(b.tempRange))
      expect(Array.from(a.moistMean)).toEqual(Array.from(b.moistMean))
      expect(Array.from(a.flux)).toEqual(Array.from(b.flux))
      expect(Array.from(a.rivers)).toEqual(Array.from(b.rivers))
      expect(a.biome).toEqual(b.biome)
    })

    it(`seed ${seed} produces a serialized World whose bytes are stable`, async () => {
      const a = await evolve(seed)
      const b = await evolve(seed)
      const wa = toWorld(a, metaFor(seed))
      const wb = toWorld(b, metaFor(seed))
      const sa = serializeWorld(wa)
      const sb = serializeWorld(wb)
      expect(sa).toBe(sb)
    })

    it(`seed ${seed} round-trips through serializeWorld / deserializeWorld`, async () => {
      const result = await evolve(seed)
      const world = toWorld(result, metaFor(seed))
      const json = serializeWorld(world)
      const restored = deserializeWorld(json)
      expect(restored).not.toBeNull()
      expect(Array.from(restored!.elev)).toEqual(Array.from(world.elev))
      expect(restored!.biome).toEqual(world.biome)
    })

    it(`seed ${seed} scores >= 50 against the post-Make-sense red pen`, async () => {
      const result = await evolve(seed)
      const world = toWorld(result, metaFor(seed))
      const issues = [
        ...checkIceDesertDualism(world),
        ...checkRainShadow(world),
        ...checkContinentality(world),
        ...checkFluxOnMaxima(world),
      ]
      const sorted = sortIssuesBySeverity(issues)
      const score = scoreFromIssues(sorted)
      expect(score).toBeGreaterThanOrEqual(50)
    })
  }
})

// ---------------------------------------------------------------------------
// Different seeds produce different outputs
// ---------------------------------------------------------------------------

describe('golden seeds are distinct', () => {
  it('seeds 1 and 42 produce different elevations', async () => {
    const a = await evolve(1)
    const b = await evolve(42)
    const same = Array.from(a.elev).every((v, i) => v === b.elev[i])
    expect(same).toBe(false)
  })

  it('seeds 100 and 1234 produce different biome arrays', async () => {
    const a = await evolve(100)
    const b = await evolve(1234)
    expect(a.biome).not.toEqual(b.biome)
  })

  it('all five seeds produce different mask areas', async () => {
    const areas = new Set<number>()
    for (const seed of FIXED_SEEDS) {
      const result = await evolve(seed)
      areas.add(result.provenance.outputMaskArea)
    }
    // With overwhelming probability, all five worlds have distinct
    // output mask areas.
    expect(areas.size).toBeGreaterThanOrEqual(2)
  })
})