// @vitest-environment happy-dom
/**
 * Auto-settlement tests: towns appear on inhabitable land, spaced, named uniquely.
 */

import { describe, expect, it } from 'vitest'
import { inferSettlementRole, mixQuotas, seedSettlements, suggestSettlementsCovering, demoteExtraSeats, isOasisSite } from './settlements'
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
    expect(world.cities.every((c) => c.rank === 'village' || c.rank === 'town' || c.rank === 'seat')).toBe(
      true,
    )
    expect(world.cities.every((c) => c.port === 'none' || c.port === 'river' || c.port === 'sea')).toBe(
      true,
    )
    expect(world.cities.filter((c) => c.rank === 'seat')).toHaveLength(1)

    expect(seedSettlements(world)).toHaveLength(0)
    expect(world.cities.length).toBe(added.length)
  })

  it('founds at most one seat of power and mixes the rest', async () => {
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
    const added = seedSettlements(world)
    expect(added.length).toBeGreaterThanOrEqual(5)
    const seats = world.cities.filter((c) => c.role === 'seat_of_power')
    expect(seats).toHaveLength(1)
    const roles = new Set(world.cities.map((c) => c.role))
    expect(roles.has('seat_of_power')).toBe(true)
    expect(roles.size).toBeGreaterThanOrEqual(3)
    expect(world.cities.every((c) => c.role === 'seat_of_power')).toBe(false)
  })

  it('inferSettlementRole will not found a second seat', async () => {
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
    world.cities.push({ x: 32, y: 16, name: 'Throne', seasonal: 0.9, role: 'seat_of_power' })
    const role = inferSettlementRole(world, 28, 16)
    expect(role).not.toBe('seat_of_power')
  })

  it('mixQuotas always sums to the remaining slots', () => {
    for (const n of [0, 1, 6, 7, 16, 23]) {
      const q = mixQuotas(n)
      const sum = Object.values(q).reduce((s, v) => s + v, 0)
      expect(sum).toBe(n)
      expect(q.seat_of_power).toBe(0)
    }
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
    expect(ca.map((c) => `${c.x},${c.y},${c.name},${c.role},${c.rank},${c.port}`)).toEqual(
      cb.map((c) => `${c.x},${c.y},${c.name},${c.role},${c.rank},${c.port}`),
    )
  })

  it('demoteExtraSeats collapses a pile of thrones to one', async () => {
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
    world.cities = Array.from({ length: 11 }, (_, i) => ({
      x: 20 + i,
      y: 16,
      name: `Throne${i}`,
      seasonal: 0.8,
      role: 'seat_of_power' as const,
    }))
    world.cities.push({ x: 28, y: 18, name: 'Farm', seasonal: 0.7, role: 'farmland' })
    world.cities.push({ x: 36, y: 14, name: 'Port', seasonal: 0.6, role: 'fishing' })
    demoteExtraSeats(world.cities, world)
    expect(world.cities.filter((c) => c.role === 'seat_of_power')).toHaveLength(1)
    expect(world.cities.some((c) => c.role && c.role !== 'seat_of_power')).toBe(true)
  })

  it('treats a moist desert cell as an oasis, still one of the seven jobs', async () => {
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
    let x = 0
    let y = 0
    for (let i = 0; i < world.mask.length; i++) {
      if (world.mask[i] < world.meta.threshold) continue
      x = i % world.meta.width
      y = (i - x) / world.meta.width
      world.biome[i] = 'hot-desert'
      world.moistMean[i] = 0.4
      break
    }
    expect(isOasisSite(world, x, y)).toBe(true)
    const i = y * world.meta.width + x
    world.moistMean[i] = 0
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy
      if (ny < 0 || ny >= world.meta.height) continue
      for (let dx = -2; dx <= 2; dx++) {
        const nx = ((x + dx) % world.meta.width + world.meta.width) % world.meta.width
        world.flux[ny * world.meta.width + nx] = 0
      }
    }
    expect(isOasisSite(world, x, y)).toBe(false)
  })
})
