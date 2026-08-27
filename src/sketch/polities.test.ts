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
  growPolities,
  meltingPotLabel,
  paintClaim,
  polityAt,
  refreshWorldbuildAfterPaint,
  routeCaption,
  routeDossier,
  routeNearCell,
  traceTradeRoute,
} from './polities'
import { seedSettlements } from './settlements'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'
import { DEFAULT_META, emptyPolityState, type World } from '../world/types'

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
  it('clamps to 1–24', () => {
    expect(clampPolityCount(0)).toBe(1)
    expect(clampPolityCount(99)).toBe(24)
    expect(clampPolityCount(4.4)).toBe(4)
  })

  it('defaults from inhabitable area, not from doodle pixels', async () => {
    const world = await groundedContinent()
    const n = defaultPolityCount(world)
    expect(n).toBeGreaterThanOrEqual(6)
    expect(n).toBeLessThanOrEqual(24)
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

  it('keeps writer country and people names when trade rebuilds', async () => {
    const world = await groundedContinent()
    seedSettlements(world, 0.35, 2)
    ensureWorldbuild(world, 2)
    const p = world.polities[0]
    p.name = 'Northland'
    p.tradition = 'Marcher herders'
    refreshWorldbuildAfterPaint(world)
    const kept = world.polities.find((row) => row.id === p.id)
    expect(kept?.name).toBe('Northland')
    expect(kept?.tradition).toBe('Marcher herders')
    expect(kept?.analog.tradition).not.toBe('Marcher herders')
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

describe('writer trade routes', () => {
  it('traces a caravan that survives a country rebuild', async () => {
    const world = await groundedContinent()
    seedSettlements(world, 0.35, 2)
    ensureWorldbuild(world, 2)
    const a = firstLand(world)
    const { width: w, height: h, threshold } = world.meta
    // Pick b on the SAME land component as a (BFS over 4-connected
    // land), 6–18 steps out. A manhattan-distance pick can land on a
    // disconnected islet and make the caravan impossible by geography,
    // which is not what this test is about.
    let b: { x: number; y: number } | null = null
    {
      const dist = new Int32Array(w * h).fill(-1)
      const q: number[] = [a.y * w + a.x]
      dist[q[0]] = 0
      let head = 0
      while (head < q.length && !b) {
        const i = q[head++]
        const x = i % w
        const y = (i - x) / w
        if (dist[i] >= 6 && dist[i] <= 18) {
          b = { x, y }
          break
        }
        if (dist[i] > 18) continue
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = (x + dx + w) % w
          const ny = y + dy
          if (ny < 0 || ny >= h) continue
          const ni = ny * w + nx
          if (dist[ni] >= 0 || world.mask[ni] < threshold) continue
          dist[ni] = dist[i] + 1
          q.push(ni)
        }
      }
    }
    expect(b).toBeTruthy()
    if (!b) return
    const drawn = traceTradeRoute(world, a.x, a.y, b.x, b.y, 'land')
    expect(drawn?.author).toBe(true)
    expect(drawn?.path.length).toBeGreaterThan(1)
    expect(routeCaption(world, drawn!)).toMatch(/Caravan/)
    expect(routeCaption(world, drawn!)).toMatch(/km/)
    expect(routeDossier(world, drawn!)).toMatch(/Writer-traced|Auto trade/)
    const onPath = drawn!.path[Math.floor(drawn!.path.length / 2)]
    expect(routeNearCell(world, onPath.x, onPath.y, 'land')?.author).toBe(true)
    ensureWorldbuild(world, 2)
    expect(world.routes.some((r) => r.author && r.kind === 'land')).toBe(true)
  })
})

function landWorld(width: number, height: number, seats: number): World {
  const n = width * height
  const mask = new Float32Array(n).fill(1)
  for (let x = 0; x < width; x++) {
    mask[x] = 0
    mask[(height - 1) * width + x] = 0
  }
  const cities = Array.from({ length: seats }, (_, k) => {
    const col = k % Math.max(1, Math.ceil(Math.sqrt(seats)))
    const row = Math.floor(k / Math.max(1, Math.ceil(Math.sqrt(seats))))
    return {
      x: 8 + col * Math.floor((width - 16) / Math.max(1, Math.ceil(Math.sqrt(seats)))),
      y: 8 + row * Math.floor((height - 16) / Math.max(1, Math.ceil(Math.sqrt(seats)))),
      name: `Seat${k}`,
      seasonal: 1,
      role: 'seat_of_power' as const,
      rank: 'seat' as const,
    }
  })
  return {
    meta: { ...DEFAULT_META, width, height },
    mask,
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n).fill(200),
    seasons: 2,
    summer: new Float32Array(n).fill(18),
    winter: new Float32Array(n).fill(8),
    summerMoist: new Float32Array(n).fill(0.4),
    winterMoist: new Float32Array(n).fill(0.3),
    tempMean: new Float32Array(n).fill(13),
    tempRange: new Float32Array(n).fill(10),
    moistMean: new Float32Array(n).fill(0.35),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome: Array.from({ length: n }, () => 'temperate-forest' as const),
    suitability: new Float32Array(n).fill(0.5),
    cities,
    ...emptyPolityState(n),
  }
}

describe('growPolities heap', () => {
  it('terminates when elevation is NaN instead of overflowing Array.push', () => {
    const world = landWorld(24, 16, 2)
    world.elev.fill(NaN)
    expect(() => growPolities(world)).not.toThrow()
    expect(world.cities.every((c) => c.polityId === 0 || c.polityId === 1)).toBe(true)
  })

  it('grows 12 countries on a 768×384 atlas without RangeError', () => {
    const world = landWorld(768, 384, 12)
    expect(() => growPolities(world)).not.toThrow()
    let claimed = 0
    for (let i = 0; i < world.polityId.length; i++) {
      if (world.polityId[i] >= 0) claimed++
    }
    expect(claimed).toBeGreaterThan(1000)
  })

  it('grows 24 countries on a 768×384 atlas without RangeError', () => {
    const world = landWorld(768, 384, 24)
    expect(() => growPolities(world)).not.toThrow()
    let claimed = 0
    for (let i = 0; i < world.polityId.length; i++) {
      if (world.polityId[i] >= 0) claimed++
    }
    expect(claimed).toBeGreaterThan(1000)
  })
})
