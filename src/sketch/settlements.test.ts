// @vitest-environment happy-dom
/**
 * Auto-settlement tests: towns appear on inhabitable land, spaced, named uniquely.
 */

import { describe, expect, it } from 'vitest'
import {
  annotateSettlement,
  demoteExtraSeats,
  formatSettlementPeople,
  inferSettlementRole,
  isOasisSite,
  mixQuotas,
  scoreSettlementRole,
  seedSettlements,
  suggestSettlementsCovering,
} from './settlements'
import { placeCity } from './worldbuild'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'
import { DEFAULT_META, emptyPolityState, type World } from '../world/types'

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
    expect(world.cities.length).toBeLessThanOrEqual(48)
    for (const city of world.cities) {
      expect(city.population).toBeGreaterThan(0)
      expect(city.sizeCause && city.sizeCause.length).toBeGreaterThan(0)
      expect(city.sizeCause!.length).toBeLessThan(40)
      expect(city.sizeCause!.includes('.')).toBe(false)
      const suit = world.suitability[city.y * world.meta.width + city.x]
      if (city.role !== 'seat_of_power' && suit < 0.46) expect(city.rank).toBe('village')
    }
    const seat = world.cities.find((c) => c.role === 'seat_of_power')
    expect(seat?.population).toBe(Math.max(...world.cities.map((c) => c.population ?? 0)))
    expect(seat?.sizeCause).toMatch(/seat on /)

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
    expect(ca.map((c) => `${c.x},${c.y},${c.name},${c.role},${c.rank},${c.port},${c.population},${c.sizeCause}`)).toEqual(
      cb.map((c) => `${c.x},${c.y},${c.name},${c.role},${c.rank},${c.port},${c.population},${c.sizeCause}`),
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

function gridWorld(): World {
  const width = 24
  const height = 16
  const n = width * height
  return {
    meta: { ...DEFAULT_META, seed: 3, width, height, threshold: 0.5 },
    mask: new Float32Array(n).fill(1),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n).fill(120),
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

function cellAt(world: World, x: number, y: number): number {
  return y * world.meta.width + x
}

describe('settlement size', () => {
  it('lets a sea-port trade town outgrow an inland hunting camp on the same land score', () => {
    const world = gridWorld()
    const suit = 0.8
    world.mask[cellAt(world, 4, 11)] = 0
    world.suitability[cellAt(world, 4, 8)] = suit
    world.elev[cellAt(world, 4, 8)] = 40
    world.biome[cellAt(world, 4, 8)] = 'mediterranean'
    world.suitability[cellAt(world, 18, 4)] = suit
    world.elev[cellAt(world, 18, 4)] = 480
    world.biome[cellAt(world, 18, 4)] = 'taiga'
    world.suitability[cellAt(world, 12, 8)] = suit
    world.elev[cellAt(world, 12, 8)] = 80

    const trade = annotateSettlement(
      world,
      { x: 4, y: 8, name: 'Port', seasonal: suit, role: 'trade' },
      { allowSeat: false },
    )
    const camp = annotateSettlement(
      world,
      { x: 18, y: 4, name: 'Camp', seasonal: suit, role: 'hunting' },
      { allowSeat: false },
    )
    const seat = annotateSettlement(
      world,
      { x: 12, y: 8, name: 'Throne', seasonal: suit, role: 'seat_of_power' },
      { allowSeat: true },
    )

    expect(trade.port).toBe('sea')
    expect(trade.rank).toBe('town')
    expect(trade.sizeCause).toBe('sea-port trade')
    expect(camp.port).toBe('none')
    expect(camp.sizeCause).toBe('inland hunting camp')
    expect(camp.rank === 'village' || camp.rank === 'town').toBe(true)
    expect(trade.population!).toBeGreaterThan(camp.population!)
    expect(seat.rank).toBe('seat')
    expect(seat.sizeCause).toBe('seat on the best land')
    expect(seat.population!).toBeGreaterThan(trade.population!)
    expect(formatSettlementPeople(trade)).toBe(`≈${trade.population!.toLocaleString('en-US')} people — sea-port trade`)
  })

  it('keeps a poor site a village and names a river port', () => {
    const world = gridWorld()
    const poorI = cellAt(world, 8, 8)
    world.suitability[poorI] = 0.36
    world.elev[poorI] = 90
    const village = annotateSettlement(
      world,
      { x: 8, y: 8, name: 'Hamlet', seasonal: 0.36, role: 'farmland' },
      { allowSeat: false },
    )
    expect(village.rank).toBe('village')
    expect(village.population!).toBeLessThan(1500)
    expect(village.sizeCause).toBe('thin land')

    const riverI = cellAt(world, 16, 6)
    world.suitability[riverI] = 0.7
    world.flux[riverI] = 24
    world.elev[riverI] = 80
    const river = annotateSettlement(
      world,
      { x: 16, y: 6, name: 'Ford', seasonal: 0.7, role: 'trade' },
      { allowSeat: false },
    )
    expect(river.port).toBe('river')
    expect(river.rank).toBe('town')
    expect(river.sizeCause).toBe('river port')
    expect(river.population!).toBeGreaterThan(village.population!)
  })

  it('puts mines on high or rough land, fisheries on the coast, farms on low land, herds on marginal land', () => {
    const world = gridWorld()
    const farm = scoreSettlementRole(world, 8, 8, 'farmland')
    expect(farm).toBeGreaterThan(0.3)
    expect(scoreSettlementRole(world, 8, 8, 'mining')).toBe(0)
    expect(scoreSettlementRole(world, 8, 8, 'fishing')).toBe(0)
    expect(scoreSettlementRole(world, 8, 8, 'pastoral')).toBe(0)
    expect(scoreSettlementRole(world, 8, 8, 'hunting')).toBe(0)

    const mineI = cellAt(world, 18, 8)
    world.elev[mineI] = 1600
    world.elev[cellAt(world, 19, 8)] = 2100
    world.biome[mineI] = 'alpine'
    world.suitability[mineI] = 0.5
    expect(scoreSettlementRole(world, 18, 8, 'mining')).toBeGreaterThan(0.3)
    expect(scoreSettlementRole(world, 18, 8, 'farmland')).toBe(0)
    const highMine = annotateSettlement(
      world,
      { x: 18, y: 8, name: 'Delve', seasonal: 0.5, role: 'mining' },
      { allowSeat: false },
    )
    expect(highMine.sizeCause).toBe('high mine')

    const roughI = cellAt(world, 20, 4)
    world.elev[roughI] = 200
    world.elev[cellAt(world, 21, 4)] = 520
    world.biome[roughI] = 'temperate-forest'
    world.suitability[roughI] = 0.55
    const rough = annotateSettlement(
      world,
      { x: 20, y: 4, name: 'Quarry', seasonal: 0.55, role: 'mining' },
      { allowSeat: false },
    )
    expect(scoreSettlementRole(world, 20, 4, 'mining')).toBeGreaterThan(0.2)
    expect(rough.sizeCause).toBe('rough-land mine')

    world.mask[cellAt(world, 3, 3)] = 0
    expect(scoreSettlementRole(world, 3, 4, 'fishing')).toBeGreaterThan(0.3)
    expect(scoreSettlementRole(world, 12, 8, 'fishing')).toBe(0)

    const pastureI = cellAt(world, 14, 12)
    world.biome[pastureI] = 'steppe'
    world.elev[pastureI] = 1100
    world.suitability[pastureI] = 0.4
    expect(scoreSettlementRole(world, 14, 12, 'pastoral')).toBeGreaterThan(0.2)
    const pasture = annotateSettlement(
      world,
      { x: 14, y: 12, name: 'Fold', seasonal: 0.4, role: 'pastoral' },
      { allowSeat: false },
    )
    expect(pasture.rank).toBe('village')
    expect(pasture.sizeCause).toBe('high pasture')

    const huntI = cellAt(world, 20, 12)
    world.biome[huntI] = 'taiga'
    world.elev[huntI] = 700
    world.suitability[huntI] = 0.36
    expect(scoreSettlementRole(world, 20, 12, 'hunting')).toBeGreaterThan(0.2)
  })

  it('hand-placed cities use the same score and a rejected click still rejects', () => {
    const world = gridWorld()
    world.suitability[cellAt(world, 6, 6)] = 0.2
    const rejected = placeCity(world, 6, 6, 'No')
    expect(rejected.rejected).toBe(true)
    expect(rejected.city).toBeNull()
    expect(world.cities).toHaveLength(0)

    world.mask[cellAt(world, 10, 10)] = 0
    world.suitability[cellAt(world, 10, 8)] = 0.75
    world.elev[cellAt(world, 10, 8)] = 20
    world.biome[cellAt(world, 10, 8)] = 'mediterranean'
    const placed = placeCity(world, 10, 8, 'Haven')
    expect(placed.mutated).toBe(true)
    expect(placed.city?.population).toBeGreaterThan(0)
    expect(placed.city?.sizeCause?.includes('.')).toBe(false)
    const again = annotateSettlement(world, { ...placed.city! })
    expect(again.population).toBe(placed.city!.population)
    expect(again.sizeCause).toBe(placed.city!.sizeCause)
  })
})
