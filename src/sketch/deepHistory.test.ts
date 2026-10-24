/**
 * Deep history: cradles on rivers, ore in the hills, a sheltered bay, a dry
 * margin, the widest country, the longest road. Same world, same eras.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_META, emptyPolityState, type PlaceAnalog, type Polity, type World } from '../world/types'
import { deepHistory, formatEra, placeName } from './deepHistory'

const W = 64
const H = 32
const RIVER_Y = 16

const FARM: PlaceAnalog = {
  id: 'temperate-farmland',
  label: 'Temperate farmland',
  because: 'Mild forest climate.',
  tradition: 'Mixed farmers of a mild forest climate.',
}

function polity(id: number, name: string, capitalX: number, capitalY: number): Polity {
  return {
    id,
    name,
    capitalX,
    capitalY,
    analog: FARM,
    tradition: FARM.tradition,
    exports: ['grain'],
    imports: ['metals'],
    meltingPot: 0.2,
    mass: 1,
  }
}

/** Land x 8..55, a bay cut in at x 8..11, a river along y 16, hills NE, dry steppe S. */
function valleyWorld(seed = 7): World {
  const n = W * H
  const world: World = {
    meta: { ...DEFAULT_META, seed, width: W, height: H, planetRadiusKm: 1200 },
    mask: new Float32Array(n),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n).fill(-2000),
    seasons: 2,
    summer: new Float32Array(n).fill(20),
    winter: new Float32Array(n).fill(8),
    summerMoist: new Float32Array(n).fill(0.45),
    winterMoist: new Float32Array(n).fill(0.4),
    tempMean: new Float32Array(n).fill(14),
    tempRange: new Float32Array(n).fill(12),
    moistMean: new Float32Array(n).fill(0.42),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome: Array.from({ length: n }, () => 'ocean' as const) as World['biome'],
    suitability: new Float32Array(n),
    cities: [],
    ...emptyPolityState(n),
  }
  for (let y = 0; y < H; y++) {
    for (let x = 8; x < 56; x++) {
      const bay = x <= 11 && y >= 14 && y <= 17
      if (bay) continue
      const i = y * W + x
      world.mask[i] = 1
      world.elev[i] = 300
      world.suitability[i] = 0.5
      world.biome[i] = 'temperate-deciduous'
    }
  }
  for (let x = 12; x <= 40; x++) {
    const i = RIVER_Y * W + x
    world.rivers[i] = 1
    world.flux[i] = (41 - x) * 10
    world.elev[i] = 40 + (x - 12) * 4
    world.tempMean[i] = 20
    world.moistMean[i] = 0.5
    world.suitability[i] = 0.85
  }
  for (let y = 8; y <= 12; y++) {
    for (let x = 36; x <= 44; x++) {
      const i = y * W + x
      world.elev[i] = 1500
      world.tempMean[i] = 6
      world.suitability[i] = 0.2
      world.biome[i] = 'alpine'
    }
  }
  for (let y = 19; y <= 24; y++) {
    for (let x = 18; x <= 28; x++) {
      const i = y * W + x
      world.moistMean[i] = 0.12
      world.tempMean[i] = 22
      world.suitability[i] = 0.15
      world.biome[i] = 'steppe'
    }
  }
  world.polities = [polity(0, 'Brennic Reach', 20, RIVER_Y), polity(1, 'Highfold', 40, 9)]
  for (let i = 0; i < n; i++) {
    if (world.mask[i] < 0.5) continue
    world.polityId[i] = i % W < 36 ? 0 : 1
  }
  world.cities = [
    { x: 20, y: RIVER_Y, name: 'Corvane', seasonal: 0.85, role: 'seat_of_power', rank: 'seat', polityId: 0 },
    { x: 40, y: 9, name: 'Talmeer', seasonal: 0.2, role: 'mining', rank: 'town', polityId: 1 },
  ]
  const landPath = [] as { x: number; y: number }[]
  for (let x = 20; x <= 40; x++) landPath.push({ x, y: x < 34 ? RIVER_Y : 9 })
  world.routes = [
    { kind: 'land', ax: 20, ay: RIVER_Y, bx: 40, by: 9, volume: 0.6, good: 'metals', path: landPath, days: 40 },
    {
      kind: 'sea',
      ax: 12,
      ay: 15,
      bx: 8,
      by: 4,
      volume: 0.3,
      good: 'fish',
      path: [
        { x: 12, y: 15 },
        { x: 7, y: 10 },
        { x: 8, y: 4 },
      ],
    },
  ]
  return world
}

const EARTH = /\b(Nile|Mesopotamia|Egypt|Sumer|Indus|Euphrates|Tigris|Babylon|Rome|BC|AD|BCE|CE)\b/

describe('deepHistory', () => {
  it('places the cradle on the warm river cells', () => {
    const world = valleyWorld()
    const eras = deepHistory(world)
    const cradle = eras[0]!
    expect(cradle.theme).toBe('cradle')
    expect(cradle.places.length).toBeGreaterThan(0)
    for (const p of cradle.places) {
      expect(p.y).toBe(RIVER_Y)
      expect(world.rivers[p.y * W + p.x]).toBe(1)
    }
    expect(cradle.why).toMatch(/river/)
    expect(cradle.why).toMatch(/°C/)
  })

  it('earns metal, harbour, drought, seat and road eras from the cells', () => {
    const world = valleyWorld()
    const eras = deepHistory(world)
    expect(eras.map((e) => e.theme)).toEqual(['cradle', 'metal', 'sea', 'drought', 'empire', 'trade'])
    const metal = eras.find((e) => e.theme === 'metal')!
    for (const p of metal.places) expect(world.elev[p.y * W + p.x]).toBeGreaterThanOrEqual(800)
    const sea = eras.find((e) => e.theme === 'sea')!
    expect(sea.why).toMatch(/both sides/)
    const drought = eras.find((e) => e.theme === 'drought')!
    expect(world.moistMean[drought.places[0]!.y * W + drought.places[0]!.x]).toBeLessThan(0.2)
    expect(drought.why).toMatch(/risk/)
    const empire = eras.find((e) => e.theme === 'empire')!
    expect(empire.why).toMatch(/Brennic Reach/)
    expect(empire.why).toMatch(/km²/)
    expect(empire.places[0]!.label).toBe('Corvane')
    const trade = eras.find((e) => e.theme === 'trade')!
    expect(trade.why).toMatch(/caravan road/)
    expect(trade.places.map((p) => p.label)).toEqual(['Corvane', 'Talmeer'])
  })

  it('orders eras oldest first', () => {
    const eras = deepHistory(valleyWorld())
    expect(eras.length).toBeGreaterThanOrEqual(4)
    expect(eras.length).toBeLessThanOrEqual(6)
    for (let k = 1; k < eras.length; k++) {
      expect(eras[k]!.yearsAgo[0]).toBeLessThanOrEqual(eras[k - 1]!.yearsAgo[0])
    }
    for (const e of eras) expect(e.yearsAgo[0]).toBeGreaterThan(e.yearsAgo[1])
  })

  it('is deterministic and does not mutate the world', () => {
    const world = valleyWorld()
    const before = structuredClone(world)
    const a = deepHistory(world).map(formatEra)
    const b = deepHistory(world).map(formatEra)
    expect(a).toEqual(b)
    expect(deepHistory(valleyWorld()).map(formatEra)).toEqual(a)
    expect(world).toEqual(before)
    expect(placeName(world, 3, 4)).toBe(placeName(world, 3 + W, 4))
  })

  it('returns no era when there is no land', () => {
    const world = valleyWorld()
    world.mask.fill(0)
    expect(deepHistory(world)).toEqual([])
  })

  it('prints relative years and no Earth names', () => {
    const eras = deepHistory(valleyWorld())
    for (const e of eras) {
      const text = [formatEra(e), ...e.places.map((p) => p.label)].join(' ')
      expect(text).not.toMatch(EARTH)
    }
    expect(formatEra(eras[0]!)).toMatch(/^c\. 6000–4500 years before the map · First granaries — /)
  })
})
