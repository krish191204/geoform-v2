import { describe, expect, it } from 'vitest'
import type { CellBiome, World } from '../world/types'
import { DEFAULT_META, emptyPolityState } from '../world/types'
import { RESOURCE, RESOURCE_LABEL, describeResources, readResources, resourceSummary } from './resources'

const W = 16
const H = 8
/** Land box of `makeWorld(16, 8)`: x 2..13, y 1..6. */
const LAND_CELLS = 12 * 6

function at(x: number, y: number, w = W): number {
  return y * w + x
}

/** Ocean planet with one temperate steppe block at x 2..w-3, y 1..h-2. */
function makeWorld(w = W, h = H): World {
  const n = w * h
  const mask = new Float32Array(n)
  const elev = new Float32Array(n).fill(-2000)
  const biome: CellBiome[] = new Array<CellBiome>(n).fill('ocean')
  for (let y = 1; y <= h - 2; y++) {
    for (let x = 2; x <= w - 3; x++) {
      const i = at(x, y, w)
      mask[i] = 1
      elev[i] = 300
      biome[i] = 'steppe'
    }
  }
  return {
    meta: { ...DEFAULT_META, width: w, height: h },
    mask,
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev,
    seasons: 2,
    summer: new Float32Array(n).fill(20),
    winter: new Float32Array(n).fill(10),
    summerMoist: new Float32Array(n).fill(0.5),
    winterMoist: new Float32Array(n).fill(0.5),
    tempMean: new Float32Array(n).fill(15),
    tempRange: new Float32Array(n).fill(10),
    moistMean: new Float32Array(n).fill(0.5),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome,
    suitability: new Float32Array(n),
    cities: [],
    ...emptyPolityState(n),
  }
}

function isLand(world: World, i: number): boolean {
  return world.mask[i] >= world.meta.threshold
}

/** `code` on every land cell, 0 at sea. */
function landLith(world: World, code: number): Uint8Array {
  const lith = new Uint8Array(world.mask.length)
  for (let i = 0; i < lith.length; i++) if (isLand(world, i)) lith[i] = code
  return lith
}

const has = (flags: Uint8Array, i: number, flag: number) => (flags[i] & flag) !== 0

describe('readResources', () => {
  it('puts metal ore on every fold-belt and volcanic-arc cell', () => {
    const world = makeWorld()
    for (const code of [2, 3]) {
      const { flags, counts } = readResources(world, landLith(world, code))
      for (let i = 0; i < flags.length; i++) {
        if (isLand(world, i)) expect(has(flags, i, RESOURCE.ORE)).toBe(true)
      }
      expect(counts[RESOURCE.ORE]).toBe(LAND_CELLS)
    }
  })

  it('keeps craton ore near 15% and craton gems near 4%', () => {
    const w = 128
    const h = 64
    const world = makeWorld(w, h)
    const { counts } = readResources(world, landLith(world, 1))
    const land = (w - 4) * (h - 2)
    expect(counts[RESOURCE.STONE]).toBe(land)
    expect(counts[RESOURCE.ORE] / land).toBeGreaterThan(0.12)
    expect(counts[RESOURCE.ORE] / land).toBeLessThan(0.18)
    expect(counts[RESOURCE.GEMS] / land).toBeGreaterThan(0.02)
    expect(counts[RESOURCE.GEMS] / land).toBeLessThan(0.06)
  })

  it('puts salt only on evaporite', () => {
    const world = makeWorld()
    const lith = landLith(world, 5)
    lith[at(4, 3)] = 7
    lith[at(5, 3)] = 7
    lith[at(0, 0)] = 7
    const { flags, counts } = readResources(world, lith)
    for (let i = 0; i < flags.length; i++) {
      expect(has(flags, i, RESOURCE.SALT)).toBe(isLand(world, i) && lith[i] === 7)
    }
    expect(counts[RESOURCE.SALT]).toBe(2)
  })

  it('marks a warm moist lowland alluvium fertile and a cold one not', () => {
    const world = makeWorld()
    const warm = at(6, 3)
    const cold = at(8, 3)
    const high = at(10, 3)
    world.tempMean[warm] = 18
    world.elev[warm] = 100
    world.tempMean[cold] = 2
    world.elev[cold] = 100
    world.elev[high] = 1200
    const { flags } = readResources(world, landLith(world, 6))
    expect(has(flags, warm, RESOURCE.FERTILE)).toBe(true)
    expect(has(flags, cold, RESOURCE.FERTILE)).toBe(false)
    expect(has(flags, high, RESOURCE.FERTILE)).toBe(false)
  })

  it('puts gems on high fold belt and timber on low forest only', () => {
    const world = makeWorld()
    world.elev[at(5, 3)] = 2000
    world.elev[at(6, 3)] = 1000
    world.biome[at(8, 3)] = 'taiga'
    world.elev[at(8, 3)] = 400
    world.biome[at(9, 3)] = 'taiga'
    world.elev[at(9, 3)] = 2600
    const { flags } = readResources(world, landLith(world, 2))
    expect(has(flags, at(5, 3), RESOURCE.GEMS)).toBe(true)
    expect(has(flags, at(6, 3), RESOURCE.GEMS)).toBe(false)
    expect(has(flags, at(8, 3), RESOURCE.TIMBER)).toBe(true)
    expect(has(flags, at(9, 3), RESOURCE.TIMBER)).toBe(false)
    expect(has(flags, at(10, 3), RESOURCE.TIMBER)).toBe(false)
  })

  it('puts fishing grounds on cool coasts and warm river mouths, not inland', () => {
    const world = makeWorld()
    world.tempMean[at(2, 4)] = 26
    world.rivers[at(13, 4)] = 1
    for (const y of [2, 4, 5]) world.tempMean[at(13, y)] = 26
    const { flags } = readResources(world, new Uint8Array(W * H))
    expect(has(flags, at(2, 3), RESOURCE.FISH)).toBe(true)
    expect(has(flags, at(7, 3), RESOURCE.FISH)).toBe(false)
    expect(has(flags, at(2, 4), RESOURCE.FISH)).toBe(false)
    expect(has(flags, at(13, 4), RESOURCE.FISH)).toBe(true)
    expect(has(flags, at(13, 5), RESOURCE.FISH)).toBe(true)
    expect(has(flags, at(13, 2), RESOURCE.FISH)).toBe(false)
  })

  it('finds the coast across the wrapped x edge', () => {
    const world = makeWorld()
    for (let y = 2; y <= 4; y++) {
      for (let x = 0; x < W; x++) world.mask[at(x, y)] = 1
    }
    world.mask[at(W - 1, 3)] = 0
    const { flags } = readResources(world, new Uint8Array(W * H))
    expect(has(flags, at(0, 3), RESOURCE.FISH)).toBe(true)
    expect(has(flags, at(1, 3), RESOURCE.FISH)).toBe(false)
  })

  it('leaves every ocean cell at 0 whatever the rock code says', () => {
    const world = makeWorld()
    const lith = new Uint8Array(W * H).fill(2)
    const { flags } = readResources(world, lith)
    for (let i = 0; i < flags.length; i++) {
      if (!isLand(world, i)) expect(flags[i]).toBe(0)
    }
  })

  it('does not write to the world or the rock codes, and repeats exactly', () => {
    const world = makeWorld()
    world.rivers[at(13, 4)] = 1
    const lith = landLith(world, 1)
    lith[at(4, 3)] = 7
    const before = {
      mask: world.mask.slice(),
      elev: world.elev.slice(),
      tempMean: world.tempMean.slice(),
      moistMean: world.moistMean.slice(),
      rivers: world.rivers.slice(),
      biome: world.biome.slice(),
      lith: lith.slice(),
    }
    const a = readResources(world, lith)
    const b = readResources(world, lith)
    expect(world.mask).toEqual(before.mask)
    expect(world.elev).toEqual(before.elev)
    expect(world.tempMean).toEqual(before.tempMean)
    expect(world.moistMean).toEqual(before.moistMean)
    expect(world.rivers).toEqual(before.rivers)
    expect(world.biome).toEqual(before.biome)
    expect(lith).toEqual(before.lith)
    expect(a.flags).toEqual(b.flags)
    expect(a.counts).toEqual(b.counts)
  })

  it('returns all zero when lengths disagree', () => {
    const world = makeWorld()
    const short = readResources(world, new Uint8Array(W * H - 1).fill(2))
    expect(short.flags.length).toBe(W * H)
    expect(short.flags.every((f) => f === 0)).toBe(true)
    expect(Object.values(short.counts).every((c) => c === 0)).toBe(true)

    const broken = makeWorld()
    broken.biome = broken.biome.slice(1)
    expect(readResources(broken, landLith(world, 2)).flags.every((f) => f === 0)).toBe(true)
  })
})

describe('describeResources', () => {
  it('joins labels in plain English', () => {
    expect(describeResources(RESOURCE.ORE | RESOURCE.TIMBER)).toBe('metal ore and timber')
    expect(describeResources(RESOURCE.SALT)).toBe('salt')
    expect(describeResources(RESOURCE.ORE | RESOURCE.STONE | RESOURCE.GEMS)).toBe(
      'metal ore, building stone and gemstones',
    )
    expect(describeResources(0)).toBe('')
  })
})

describe('resourceSummary', () => {
  it('lists present resources by cell count, omitting zero rows', () => {
    const world = makeWorld()
    const rows = resourceSummary(readResources(world, landLith(world, 2)))
    expect(rows.map((r) => r.flag)).toEqual([RESOURCE.ORE, RESOURCE.STONE, RESOURCE.FISH])
    expect(rows.map((r) => r.cells)).toEqual([LAND_CELLS, LAND_CELLS, 32])
    for (const r of rows) expect(r.label).toBe(RESOURCE_LABEL[r.flag])
  })
})
