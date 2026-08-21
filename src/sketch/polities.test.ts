// @vitest-environment happy-dom
/**
 * Worldbuild countries: seats grow cost-based borders, landscape analogs,
 * not ethnicities. Downstream of Make sense only.
 */

import { describe, expect, it } from 'vitest'
import { analogAt, PLACE_ANALOGS } from './analogs'
import {
  clampPolityCount,
  defaultPolityCount,
  ensureWorldbuild,
  meltingPotLabel,
  paintClaim,
  polityAt,
} from './polities'
import { seedSettlements } from './settlements'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'

async function groundedContinent() {
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
  return worldFromMakeSense(result, meta, tw.mask)
}

function firstLand(world: ReturnType<typeof worldFromMakeSense>): { x: number; y: number } {
  const { width: w, threshold } = world.meta
  for (let i = 0; i < world.mask.length; i++) {
    if (world.mask[i] >= threshold) return { x: i % w, y: Math.floor(i / w) }
  }
  throw new Error('no land')
}

describe('polity count', () => {
  it('clamps to 1–12', () => {
    expect(clampPolityCount(0)).toBe(1)
    expect(clampPolityCount(99)).toBe(12)
    expect(clampPolityCount(4.4)).toBe(4)
  })

  it('defaults from inhabitable area, not from doodle pixels', async () => {
    const world = await groundedContinent()
    const n = defaultPolityCount(world)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(7)
  })
})

describe('ensureWorldbuild', () => {
  it('grows one country per seat and claims land', async () => {
    const world = await groundedContinent()
    seedSettlements(world, 0.35, 2)
    ensureWorldbuild(world, 2)
    expect(world.cities.filter((c) => c.role === 'seat_of_power')).toHaveLength(2)
    expect(world.polities).toHaveLength(2)
    expect(world.polities[0].id).not.toBe(world.polities[1].id)

    let claimed = 0
    for (let i = 0; i < world.polityId.length; i++) {
      if (world.mask[i] < world.meta.threshold) {
        expect(world.polityId[i]).toBe(-1)
        continue
      }
      if (world.polityId[i] >= 0) claimed++
    }
    expect(claimed).toBeGreaterThan(20)
    expect(new Set(world.polities.map((p) => p.analog.id)).size).toBeGreaterThanOrEqual(1)
    expect(world.polities.every((p) => p.analog.id in PLACE_ANALOGS)).toBe(true)
    expect(world.polities.every((p) => p.meltingPot >= 0 && p.meltingPot <= 1)).toBe(true)
  })

  it('paint-claim reassigns a land cell without rewriting climate', async () => {
    const world = await groundedContinent()
    seedSettlements(world, 0.35, 2)
    ensureWorldbuild(world, 2)
    const a = world.polities[0]
    const b = world.polities[1]
    const { width: w, threshold } = world.meta
    let cell: { x: number; y: number } | null = null
    for (let i = 0; i < world.polityId.length; i++) {
      if (world.mask[i] < threshold) continue
      if (world.polityId[i] === a.id) {
        cell = { x: i % w, y: Math.floor(i / w) }
        break
      }
    }
    expect(cell).not.toBeNull()
    if (!cell) return
    const beforeElev = world.elev.slice()
    paintClaim(world, cell.x, cell.y, 2, b.id)
    expect(world.polityId[cell.y * w + cell.x]).toBe(b.id)
    expect(Array.from(world.elev)).toEqual(Array.from(beforeElev))
  })
})

describe('analogs', () => {
  it('labels landscapes, never ethnicities', () => {
    const banned =
      /\bethnic\b|\bethnicity\b|\bhan\b|\barab\b|\bslav\b|\bgermanic\b|\bcelt\b|\bbantu\b|\bhindu\b|\bjewish\b|\blatin people\b|\bchinese\b|\bjapanese\b/i
    for (const analog of Object.values(PLACE_ANALOGS)) {
      const blob = `${analog.label} ${analog.because} ${analog.tradition}`
      expect(blob).not.toMatch(banned)
      expect(analog.label.length).toBeGreaterThan(4)
    }
  })

  it('returns null on ocean and a known analog on land', async () => {
    const world = await groundedContinent()
    const { width: w, threshold } = world.meta
    let ocean: { x: number; y: number } | null = null
    for (let i = 0; i < world.mask.length; i++) {
      if (world.mask[i] < threshold) {
        ocean = { x: i % w, y: Math.floor(i / w) }
        break
      }
    }
    expect(ocean).not.toBeNull()
    if (ocean) expect(analogAt(world, ocean.x, ocean.y)).toBeNull()
    const land = firstLand(world)
    const analog = analogAt(world, land.x, land.y)
    expect(analog).not.toBeNull()
    expect(analog && analog.id in PLACE_ANALOGS).toBe(true)
    expect(polityAt(world, land.x, land.y)).toBeNull()
  })
})

describe('meltingPotLabel', () => {
  it('calls a port mix a melting pot and a highland a provincial seat', () => {
    expect(meltingPotLabel(0.8)).toMatch(/melting-pot/i)
    expect(meltingPotLabel(0.1)).toMatch(/provincial/i)
  })
})
