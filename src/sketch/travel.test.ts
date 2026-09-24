/**
 * Journey time is a pure reading. These worlds are stubs — Make sense does not run.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_META, emptyPolityState, type World } from '../world/types'
import { journeyDays, type JourneyMode } from './travel'

function world(opts: {
  width?: number
  height?: number
  land?: boolean
  biome?: World['biome'][number]
  elev?: (x: number, y: number) => number
  river?: boolean
  climate?: boolean
}): World {
  const width = opts.width ?? 36
  const height = opts.height ?? 36
  const n = width * height
  const mask = new Float32Array(n).fill(opts.land === false ? 0 : 1)
  const elev = new Float32Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) elev[y * width + x] = opts.elev?.(x, y) ?? 100
  }
  const rivers = new Uint8Array(n)
  if (opts.river) rivers.fill(1)
  const climate = opts.climate !== false
  const biomeName = opts.biome ?? 'temperate-forest'
  return {
    meta: { ...DEFAULT_META, width, height, planetRadiusKm: 6371, threshold: 0.5 },
    mask,
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev,
    seasons: 2,
    summer: climate ? new Float32Array(n).fill(16) : (undefined as unknown as Float32Array),
    winter: climate ? new Float32Array(n).fill(4) : (undefined as unknown as Float32Array),
    summerMoist: climate ? new Float32Array(n).fill(0.4) : (undefined as unknown as Float32Array),
    winterMoist: climate ? new Float32Array(n).fill(0.3) : (undefined as unknown as Float32Array),
    tempMean: climate ? new Float32Array(n).fill(10) : (undefined as unknown as Float32Array),
    tempRange: climate ? new Float32Array(n).fill(12) : (undefined as unknown as Float32Array),
    moistMean: climate ? new Float32Array(n).fill(0.35) : (undefined as unknown as Float32Array),
    flux: new Float32Array(n),
    rivers,
    biome: Array.from({ length: n }, () => biomeName),
    suitability: new Float32Array(n).fill(0.5),
    cities: [],
    ...emptyPolityState(n),
  }
}

/** Row whose cell centre is nearest 50°N on this grid. */
function rowNear50(height: number): number {
  let best = 0
  let bestD = Infinity
  for (let y = 0; y < height; y++) {
    const deg = Math.abs(((y + 0.5) / height - 0.5) * 180)
    const d = Math.abs(deg - 50)
    if (d < bestD) {
      bestD = d
      best = y
    }
  }
  return best
}

function go(w: World, x0: number, x1: number, y: number, mode: JourneyMode, season: 'summer' | 'winter' = 'summer') {
  return journeyDays(w, x0, y, x1, y, mode, season)
}

describe('journeyDays', () => {
  it('a longer path takes more days', () => {
    const land = world({})
    const short = go(land, 2, 6, 10, 'foot')
    const long = go(land, 2, 20, 10, 'foot')
    expect(long.km).toBeGreaterThan(short.km)
    expect(long.days).toBeGreaterThan(short.days)
  })

  it('an army is slower than a solo walker on the same land', () => {
    const land = world({})
    const walker = go(land, 2, 16, 8, 'foot')
    const army = go(land, 2, 16, 8, 'army')
    expect(army.days).toBeGreaterThan(walker.days)
    expect(army.km).toBeCloseTo(walker.km)
  })

  it('a ship is faster than a caravan', () => {
    const land = world({ land: true })
    const sea = world({ land: false })
    const caravan = go(land, 2, 18, 8, 'caravan')
    const ship = go(sea, 2, 18, 8, 'ship')
    expect(ship.km).toBeCloseTo(caravan.km)
    expect(ship.days).toBeLessThan(caravan.days)
  })

  it('winter at 50° slows the ship versus summer', () => {
    const height = 36
    const y = rowNear50(height)
    const sea = world({ height, land: false })
    const summer = journeyDays(sea, 2, y, 14, y, 'ship', 'summer')
    const winter = journeyDays(sea, 2, y, 14, y, 'ship', 'winter')
    expect(winter.km).toBeCloseTo(summer.km)
    expect(winter.days).toBeGreaterThan(summer.days)
    expect(winter.days).toBeLessThan(summer.days * 3)
  })

  it('same kilometres cost more on land than on a river, and least at sea', () => {
    const land = go(world({ land: true }), 4, 14, 8, 'foot')
    const river = go(world({ land: true, river: true }), 4, 14, 8, 'foot')
    const sea = go(world({ land: false }), 4, 14, 8, 'foot')
    expect(land.km).toBeCloseTo(river.km)
    expect(river.km).toBeCloseTo(sea.km)
    expect(land.days).toBeGreaterThan(river.days)
    expect(river.days).toBeGreaterThan(sea.days)
    expect(land.days / sea.days).toBeCloseTo(8, 1)
    expect(river.days / sea.days).toBeCloseTo(4, 1)
  })

  it('returns distance only and says the season is unknown without climate arrays', () => {
    const bare = world({ climate: false })
    const before = bare.elev[0]
    const trip = go(bare, 1, 9, 4, 'caravan', 'winter')
    expect(trip.season).toBe('unknown')
    expect(trip.note.toLowerCase()).toContain('season unknown')
    expect(trip.km).toBeGreaterThan(0)
    expect(trip.days).toBeCloseTo(trip.km / 30)
    expect(bare.elev[0]).toBe(before)
  })

  it('does not write the world', () => {
    const land = world({ biome: 'hot-desert' })
    const elev = land.elev.slice()
    const mask = land.mask.slice()
    journeyDays(land, 1, 8, 12, 'army', 'summer')
    expect(Array.from(land.elev)).toEqual(Array.from(elev))
    expect(Array.from(land.mask)).toEqual(Array.from(mask))
  })
})
