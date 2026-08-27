/**
 * Natural wonders: planted geography must surface the expected kinds,
 * deterministically, capped and spaced. Downstream of Make sense only —
 * the fixture is a hand-built World, no pipeline run.
 */

import { describe, expect, it } from 'vitest'
import type { CellBiome, World } from '../world/types'
import { emptyPolityState } from '../world/types'
import { findWonders, MAX_PER_KIND, MAX_WONDERS, MIN_KIND_SPACING, earthCousinFor, groupWondersByKind, shortWonderName } from './wonders'

const W = 64
const H = 32

/** Cell of the planted salt-flat basin floor. */
const BASIN = { x: 14, y: 17 }
/** Cell of the planted river mouth (east coast of the desert continent). */
const MOUTH = { x: 27, y: 20 }
/** Box of the planted cold steep coast. */
const COLD = { x0: 40, x1: 60, y0: 3, y1: 8 }

/**
 * 64×32 synthetic World, everything ocean except:
 *  - a desert continent (x 4..27, y 8..27) with a closed basin at BASIN
 *    and a river running east along y=20 into the sea at MOUTH;
 *  - a cold steep coastal shelf (COLD box) rising fast from the north sea.
 */
function makeWonderWorld(seed = 7): World {
  const n = W * H
  const mask = new Float32Array(n)
  const elev = new Float32Array(n).fill(-2000)
  const summer = new Float32Array(n).fill(18)
  const winter = new Float32Array(n).fill(10)
  const summerMoist = new Float32Array(n).fill(0.3)
  const winterMoist = new Float32Array(n).fill(0.3)
  const tempMean = new Float32Array(n).fill(14)
  const tempRange = new Float32Array(n).fill(8)
  const moistMean = new Float32Array(n).fill(0.3)
  const flux = new Float32Array(n)
  const rivers = new Uint8Array(n)
  const biome: CellBiome[] = new Array<CellBiome>(n).fill('ocean')

  // Desert continent.
  for (let y = 8; y <= 27; y++) {
    for (let x = 4; x <= 27; x++) {
      const i = y * W + x
      mask[i] = 1
      elev[i] = 650
      biome[i] = 'hot-desert'
      tempMean[i] = 26
      tempRange[i] = 18
      summer[i] = 34
      winter[i] = 16
      moistMean[i] = 0.05
      summerMoist[i] = 0.05
      winterMoist[i] = 0.05
      flux[i] = 0.5
    }
  }

  // Closed basin: floor at 150 m, radius 2, inside a 650 m plateau.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      elev[(BASIN.y + dy) * W + (BASIN.x + dx)] = 150
    }
  }

  // River along y=20, flux ramping to a big mouth on the east coast.
  for (let x = 20; x <= MOUTH.x; x++) {
    const i = 20 * W + x
    flux[i] = 100 + (x - 20) * 100
    rivers[i] = 1
  }

  // Cold steep coast: sea to the north (y <= 2), walls rising off the shore.
  const shelfElev = [120, 750, 1400, 1600, 1600, 1500]
  for (let y = COLD.y0; y <= COLD.y1; y++) {
    for (let x = COLD.x0; x <= COLD.x1; x++) {
      const i = y * W + x
      mask[i] = 1
      elev[i] = shelfElev[y - COLD.y0]
      biome[i] = 'tundra'
      tempMean[i] = -4
      tempRange[i] = 12
      summer[i] = 2
      winter[i] = -10
      moistMean[i] = 0.4
      summerMoist[i] = 0.4
      winterMoist[i] = 0.4
      flux[i] = 0.5
    }
  }

  return {
    meta: {
      seed,
      width: W,
      height: H,
      planetRadiusKm: 6371,
      obliquityDeg: 23.5,
      seaLevel: 0.5,
      threshold: 0.5,
    },
    mask,
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev,
    seasons: 2,
    summer,
    winter,
    summerMoist,
    winterMoist,
    tempMean,
    tempRange,
    moistMean,
    flux,
    rivers,
    biome,
    suitability: new Float32Array(n),
    cities: [],
    ...emptyPolityState(n),
  }
}

function wrapDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.min(Math.abs(ax - bx), W - Math.abs(ax - bx))
  return Math.hypot(dx, ay - by)
}

describe('findWonders', () => {
  it('finds the planted salt flat in the basin', () => {
    const wonders = findWonders(makeWonderWorld())
    const salt = wonders.filter((w) => w.kind === 'salt-flat')
    expect(salt.length).toBeGreaterThanOrEqual(1)
    expect(salt.some((w) => wrapDist(w.x, w.y, BASIN.x, BASIN.y) <= 4)).toBe(true)
  })

  it('finds the planted fjord coast on the cold steep shore', () => {
    const wonders = findWonders(makeWonderWorld())
    const fjords = wonders.filter((w) => w.kind === 'fjord-coast')
    expect(fjords.length).toBeGreaterThanOrEqual(1)
    for (const f of fjords) {
      expect(f.x).toBeGreaterThanOrEqual(COLD.x0)
      expect(f.x).toBeLessThanOrEqual(COLD.x1)
      expect(f.y).toBeGreaterThanOrEqual(COLD.y0)
      expect(f.y).toBeLessThanOrEqual(COLD.y1)
    }
  })

  it('finds the planted great delta at the river mouth', () => {
    const wonders = findWonders(makeWonderWorld())
    const deltas = wonders.filter((w) => w.kind === 'great-delta')
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(deltas.some((w) => wrapDist(w.x, w.y, MOUTH.x, MOUTH.y) <= 2)).toBe(true)
  })

  it('is deterministic: two calls on the same World deep-equal', () => {
    const world = makeWonderWorld()
    const a = findWonders(world)
    const b = findWonders(world)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('caps the list at 8 and at 2 per kind', () => {
    const wonders = findWonders(makeWonderWorld())
    expect(wonders.length).toBeLessThanOrEqual(MAX_WONDERS)
    const byKind = new Map<string, number>()
    for (const w of wonders) byKind.set(w.kind, (byKind.get(w.kind) ?? 0) + 1)
    for (const count of byKind.values()) expect(count).toBeLessThanOrEqual(MAX_PER_KIND)
  })

  it('keeps same-kind wonders at least 12 cells apart (wrapped)', () => {
    const wonders = findWonders(makeWonderWorld())
    for (let i = 0; i < wonders.length; i++) {
      for (let j = i + 1; j < wonders.length; j++) {
        if (wonders[i].kind !== wonders[j].kind) continue
        expect(
          wrapDist(wonders[i].x, wonders[i].y, wonders[j].x, wonders[j].y),
        ).toBeGreaterThanOrEqual(MIN_KIND_SPACING)
      }
    }
  })

  it('gives every wonder a stable id, a name, a mechanism blurb, and a future', () => {
    const wonders = findWonders(makeWonderWorld())
    for (const w of wonders) {
      expect(w.id).toMatch(new RegExp(`^${w.kind}-\\d+$`))
      expect(w.name.length).toBeGreaterThan(3)
      expect(w.blurb.length).toBeGreaterThan(40)
      expect(w.futures.length).toBeGreaterThan(20)
    }
    const salt = wonders.find((w) => w.kind === 'salt-flat')
    expect(salt?.blurb).toMatch(/basin/i)
    expect(salt?.blurb).toMatch(/evaporat/i)
  })

  it('does not mutate the world', () => {
    const world = makeWonderWorld()
    const elevBefore = world.elev.slice()
    const maskBefore = world.mask.slice()
    findWonders(world)
    expect(Array.from(world.elev)).toEqual(Array.from(elevBefore))
    expect(Array.from(world.mask)).toEqual(Array.from(maskBefore))
  })

  it('names a similar Earth place, honest to hemisphere', () => {
    const wonders = findWonders(makeWonderWorld())
    for (const w of wonders) {
      expect(w.earthCousin).toMatch(/,/)
      expect(w.earthCousin.length).toBeGreaterThan(8)
    }
    const salt = wonders.find((w) => w.kind === 'salt-flat')
    expect(salt?.earthCousin).toBe('Salar de Uyuni, Bolivia')
    const fjord = wonders.find((w) => w.kind === 'fjord-coast')
    expect(fjord?.earthCousin).toBe('Geirangerfjord, Norway')
    expect(earthCousinFor('fjord-coast', 2, 32)).toBe('Geirangerfjord, Norway')
    expect(earthCousinFor('fjord-coast', 30, 32)).toBe('Milford Sound, New Zealand')
  })

  it('groups twin fjords under one mechanism', () => {
    const twins = [
      {
        id: 'fjord-coast-0',
        kind: 'fjord-coast' as const,
        name: 'Beldale Fjords',
        x: 1,
        y: 2,
        blurb: 'essay',
        futures: 'future',
        earthCousin: 'Geirangerfjord, Norway',
        fact: '2098 m, -6°C',
      },
      {
        id: 'fjord-coast-1',
        kind: 'fjord-coast' as const,
        name: 'Belfast Fjords',
        x: 8,
        y: 3,
        blurb: 'essay',
        futures: 'future',
        earthCousin: 'Milford Sound, New Zealand',
        fact: '1999 m, -23°C',
      },
    ]
    const groups = groupWondersByKind(twins)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Fjords')
    expect(groups[0].mechanism).toMatch(/ice cut troughs/i)
    expect(groups[0].places).toHaveLength(2)
    expect(shortWonderName(twins[0])).toBe('Beldale')
    expect(shortWonderName(twins[1])).toBe('Belfast')
  })
})
