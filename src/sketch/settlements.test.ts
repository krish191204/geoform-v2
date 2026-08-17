// @vitest-environment happy-dom
/**
 * Auto-settlement tests: towns appear on inhabitable land, spaced, named uniquely.
 */

import { describe, expect, it } from 'vitest'
import { seedSettlements, suggestSettlementsCovering } from './settlements'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'

describe('seedSettlements', () => {
  it('founds towns on a Make-sense continent and does not re-seed', async () => {
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
    const world = worldFromMakeSense(result, meta, tw.mask)
    expect(world.cities).toHaveLength(0)

    const added = seedSettlements(world)
    expect(added.length).toBeGreaterThan(0)
    expect(world.cities.length).toBe(added.length)
    for (const city of world.cities) {
      const i = city.y * world.meta.width + city.x
      expect(world.mask[i]).toBeGreaterThanOrEqual(world.meta.threshold)
      expect(city.name.length).toBeGreaterThan(0)
    }
    const names = new Set(world.cities.map((c) => c.name))
    expect(names.size).toBe(world.cities.length)

    expect(seedSettlements(world)).toHaveLength(0)
    expect(world.cities.length).toBe(added.length)
  })

  it('is deterministic for the same world', async () => {
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
    const a = worldFromMakeSense(
      await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {}),
      meta,
      tw.mask,
    )
    const b = worldFromMakeSense(
      await makeSenseInline({ meta, mask: new Float32Array(tw.mask) }, () => {}),
      meta,
      tw.mask,
    )
    const ca = suggestSettlementsCovering(a)
    const cb = suggestSettlementsCovering(b)
    expect(ca.map((c) => `${c.x},${c.y},${c.name},${c.role}`)).toEqual(
      cb.map((c) => `${c.x},${c.y},${c.name},${c.role}`),
    )
  })
})
