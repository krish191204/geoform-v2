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
  marchOf,
  meltingPotLabel,
  paintClaim,
  polityAt,
  refreshWorldbuildAfterPaint,
  entrepotHubs,
  removeRouteNearCell,
  routeCaption,
  routeDossier,
  routeLengthKm,
  routeNearCell,
  traceTradeRoute,
  TRADE_GOOD_LABEL,
} from './polities'
import { seedSettlements } from './settlements'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'
import { mountStageWork } from '../app/ui'
import type { ShellStateView } from '../app/stages'
import { DEFAULT_META, emptyPolityState, type City, type World } from '../world/types'

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
    expect(routeCaption(world, drawn!)).toMatch(/day/)
    expect(routeDossier(world, drawn!)).toMatch(/Writer-traced/)
    expect(routeDossier(world, drawn!)).toMatch(/km/)
    expect(routeDossier(world, drawn!)).toMatch(/day/)
    expect(routeDossier(world, drawn!)).toMatch(/The road is safe|Banditry|Piracy/)
    expect(drawn!.why && drawn!.why.length).toBeGreaterThan(8)
    expect(drawn!.days).toBeGreaterThan(0)
    expect(drawn!.risk).toMatch(/safe|banditry|piracy/)
    expect(routeDossier(world, drawn!)).toContain(drawn!.why!)
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

describe('marches', () => {
  it('leaves a short crest or river path wild and a farther open cell a march', () => {
    const width = 96
    const height = 11
    const world = landWorld(width, height, 1)
    const seat = { x: 40, y: 5 }
    world.cities = [
      { x: seat.x, y: seat.y, name: 'Seat', seasonal: 1, role: 'seat_of_power', rank: 'seat' },
    ]
    for (let y = 0; y < height; y++) world.rivers[y * width + 20] = 1
    for (let x = 0; x < width; x++) world.elev[3 * width + x] = 2400
    const rivers = world.rivers.slice()
    const mask = world.mask.slice()
    growPolities(world)
    expect(Array.from(world.mask)).toEqual(Array.from(mask))
    expect(Array.from(world.rivers)).toEqual(Array.from(rivers))

    const openFar = { x: 76, y: 5 }
    const pastReach = { x: 88, y: 5 }
    const acrossCrest = { x: 40, y: 1 }
    const acrossRiver = { x: 18, y: 5 }
    const openNear = { x: 56, y: 5 }

    expect(marchOf(world, seat.x, seat.y)).toBe('core')
    expect(marchOf(world, openNear.x, openNear.y)).toBe('claimed')
    expect(marchOf(world, openFar.x, openFar.y)).toBe('march')
    expect(world.polityId[openFar.y * width + openFar.x]).toBe(0)
    expect(marchOf(world, pastReach.x, pastReach.y)).toBe('wild')
    expect(world.polityId[pastReach.y * width + pastReach.x]).toBe(-1)
    expect(marchOf(world, acrossCrest.x, acrossCrest.y)).toBe('wild')
    expect(marchOf(world, acrossRiver.x, acrossRiver.y)).toBe('wild')
    expect(seat.x - acrossRiver.x).toBeLessThan(openFar.x - seat.x)
    expect(seat.y - acrossCrest.y).toBeLessThan(openFar.x - seat.x)
  })
})

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

function gridWorld(
  width: number,
  height: number,
  planetRadiusKm: number,
  land: (x: number, y: number) => boolean,
): World {
  const n = width * height
  const mask = new Float32Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) mask[y * width + x] = land(x, y) ? 1 : 0
  }
  return {
    meta: { ...DEFAULT_META, width, height, planetRadiusKm },
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
    suitability: new Float32Array(n).fill(0.6),
    cities: [],
    ...emptyPolityState(n),
  }
}

function putCity(world: World, city: City): City {
  world.cities.push(city)
  return city
}

function settled(world: World): World {
  const mask = world.mask.slice()
  growPolities(world)
  refreshWorldbuildAfterPaint(world)
  expect(Array.from(world.mask)).toEqual(Array.from(mask))
  world.routes = []
  for (const city of world.cities) city.entrepot = false
  return world
}

function tradeView(world: World): ShellStateView {
  return {
    stage: 'worldbuild',
    world,
    meta: world.meta,
    tool: 'trace-route',
    brushSize: 8,
    strength: 1,
    issues: [],
    provenance: null,
    isProcessing: false,
    mask: null,
    maskCommitted: true,
    makeSenseComplete: true,
    score: 0,
    layer: 'relief',
    season: 'summer',
    pipelineStep: 7,
    inspectHtml: '',
    viewMode: 'atlas',
    layoutMode: 'chrome',
    continentCount: 2,
    polityCount: Math.max(1, world.polities.length),
    worldbuildAct: 'trade',
    focusCell: null,
    worldOverlay: 'caravans',
    canUndo: false,
    canRedo: false,
    sketchPlane: 'land',
    hasSketchNotes: false,
  }
}

describe('trade network', () => {
  function coast(): World {
    // Ports sit on the short arc so the road crosses Midport instead of wrapping the date line.
    const world = gridWorld(80, 10, 51, (_x, y) => y < 3)
    putCity(world, { x: 8, y: 2, name: 'Westport', seasonal: 1, role: 'seat_of_power', rank: 'seat', port: 'sea' })
    putCity(world, { x: 24, y: 2, name: 'Midport', seasonal: 1, role: 'seat_of_power', rank: 'seat', port: 'sea' })
    putCity(world, { x: 40, y: 2, name: 'Eastport', seasonal: 1, role: 'seat_of_power', rank: 'seat', port: 'sea' })
    putCity(world, { x: 24, y: 0, name: 'Inland', seasonal: 1, role: 'trade', rank: 'town', port: 'none' })
    return settled(world)
  }

  it('calls banditry when a caravan crosses a third country', () => {
    const world = coast()
    const drawn = traceTradeRoute(world, 8, 2, 40, 2, 'land')
    expect(drawn?.risk).toBe('banditry')
    expect(drawn?.riskCause).toMatch(/crosses Midport/)
    const text = routeDossier(world, drawn!)
    expect(text).toMatch(/Banditry/)
    expect(text).toMatch(/km/)
    expect(text).toMatch(/day/)
    expect(text).toContain(TRADE_GOOD_LABEL[drawn!.good])
    expect(text).toContain(drawn!.why!)
  })

  it('calls piracy when a sea lane passes another country coast', () => {
    const world = coast()
    const drawn = traceTradeRoute(world, 8, 2, 40, 2, 'sea')
    expect(drawn?.kind).toBe('sea')
    expect(drawn?.risk).toBe('piracy')
    expect(drawn?.riskCause).toMatch(/Midport/)
    expect(routeDossier(world, drawn!)).toMatch(/Piracy/)
    expect(drawn!.days).toBe(Math.max(1, Math.ceil(routeLengthKm(world, drawn!) / 120)))
  })

  it('marks a town where two caravans meet, and drops the hub when one is cut', () => {
    const world = coast()
    const mask = world.mask.slice()
    traceTradeRoute(world, 8, 2, 24, 2, 'land')
    traceTradeRoute(world, 24, 2, 40, 2, 'land')
    const mid = world.cities.find((c) => c.name === 'Midport')
    const west = world.cities.find((c) => c.name === 'Westport')
    expect(mid?.entrepot).toBe(true)
    expect(west?.entrepot).toBe(false)
    expect(entrepotHubs(world).map((c) => c.name)).toContain('Midport')
    removeRouteNearCell(world, 8, 2, 'land')
    expect(mid?.entrepot).toBe(false)
    expect(Array.from(world.mask)).toEqual(Array.from(mask))
  })

  it('marks a sea port that joins a caravan and a sea lane as an entrepôt', () => {
    const world = coast()
    traceTradeRoute(world, 24, 0, 24, 2, 'land')
    traceTradeRoute(world, 24, 2, 8, 2, 'sea')
    const mid = world.cities.find((c) => c.name === 'Midport')
    const inland = world.cities.find((c) => c.name === 'Inland')
    const west = world.cities.find((c) => c.name === 'Westport')
    expect(mid?.port).toBe('sea')
    expect(mid?.entrepot).toBe(true)
    expect(inland?.entrepot).toBe(false)
    expect(west?.entrepot).toBe(false)
  })

  it('keeps a short road inside one watch as safe, and a long one as banditry', () => {
    const near = gridWorld(96, 16, 30, () => true)
    putCity(near, { x: 8, y: 8, name: 'Crown', seasonal: 1, role: 'seat_of_power', rank: 'seat' })
    putCity(near, { x: 48, y: 8, name: 'Market', seasonal: 1, role: 'trade', rank: 'town' })
    settled(near)
    const safe = traceTradeRoute(near, 8, 8, 48, 8, 'land')
    expect(safe?.risk).toBe('safe')
    expect(safe?.riskCause).toMatch(/within reach of Crown/)
    expect(routeDossier(near, safe!)).toMatch(/The road is safe/)

    const far = gridWorld(96, 16, 220, () => true)
    putCity(far, { x: 8, y: 8, name: 'Crown', seasonal: 1, role: 'seat_of_power', rank: 'seat' })
    putCity(far, { x: 48, y: 8, name: 'Market', seasonal: 1, role: 'trade', rank: 'town' })
    settled(far)
    const risky = traceTradeRoute(far, 8, 8, 48, 8, 'land')
    expect(risky?.risk).toBe('banditry')
    expect(risky?.riskCause).toMatch(/Crown's seat/)
    expect(risky?.riskCause).toMatch(/km/)
    expect(risky?.riskCause).not.toMatch(/crosses/)
    expect(risky!.days).toBe(Math.max(1, Math.ceil(routeLengthKm(far, risky!) / 30)))
  })

  it('does not lay a route between every hub pair', () => {
    const world = gridWorld(200, 16, 6371, () => true)
    const xs = [20, 28, 36, 100, 110, 120]
    xs.forEach((x, i) => {
      putCity(world, { x, y: 8, name: `Seat${i}`, seasonal: 1, role: 'seat_of_power', rank: 'seat' })
    })
    putCity(world, { x: 60, y: 8, name: 'Pit', seasonal: 1, role: 'mining', rank: 'town' })
    const mask = world.mask.slice()
    growPolities(world)
    refreshWorldbuildAfterPaint(world)
    expect(Array.from(world.mask)).toEqual(Array.from(mask))
    const land = world.routes.filter((r) => r.kind === 'land' && !r.author)
    const pairs = (xs.length * (xs.length - 1)) / 2
    expect(land.length).toBeGreaterThan(0)
    expect(land.length).toBeLessThan(pairs)
    expect(land.length).toBeLessThanOrEqual(24)
    expect(world.routes.filter((r) => r.kind === 'sea').length).toBeLessThanOrEqual(20)
    const links = (ax: number, bx: number) =>
      land.some((r) => (r.ax === ax && r.bx === bx) || (r.ax === bx && r.bx === ax))
    expect(links(20, 28)).toBe(true)
    // Seat1 is a thin country between two neighbors. Gravity drops the march to Seat5.
    expect(links(28, 120)).toBe(false)
    expect(world.routes.some((r) => (r.ax === 60 && r.ay === 8) || (r.bx === 60 && r.by === 8))).toBe(false)
    for (const route of world.routes) {
      expect(route.why && route.why.length).toBeGreaterThan(8)
      expect(route.days).toBeGreaterThan(0)
      expect(route.risk).toMatch(/safe|banditry|piracy/)
      const text = routeDossier(world, route)
      expect(text).toMatch(/km/)
      expect(text).toMatch(/day/)
      expect(text).toContain(TRADE_GOOD_LABEL[route.good])
      expect(text).toContain(route.why!)
      expect(text).toMatch(/The road is safe|The lane is safe|Banditry|Piracy/)
    }
  })

  it('lists entrepôts above volume-ranked lanes on the trade page', () => {
    const world = coast()
    const busy = traceTradeRoute(world, 8, 2, 24, 2, 'land')
    const quiet = traceTradeRoute(world, 24, 2, 40, 2, 'land')
    expect(busy && quiet).toBeTruthy()
    busy!.volume = 0.95
    quiet!.volume = 0.2
    const page = mountStageWork(tradeView(world))
    const text = page.textContent ?? ''
    expect(text).toMatch(/Entrepôts: Midport/)
    const lines = Array.from(page.querySelectorAll('li.route-line')).map((el) => el.textContent ?? '')
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('Westport')
    expect(lines[0]).not.toContain('Eastport')
    expect(lines[1]).toContain('Eastport')
    expect(lines[0]).toMatch(/km/)
    expect(lines[0]).toMatch(/day/)
    expect(lines[0]).toMatch(/entrepôt/)
    expect(lines[0]).toMatch(/The road is safe|Banditry/)
    expect(text.indexOf('Entrepôts')).toBeLessThan(text.indexOf('Westport'))
  })
})
