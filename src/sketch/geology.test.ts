import { describe, expect, it } from 'vitest'
import { DEFAULT_META, emptyPolityState, type World } from '../world/types'
import { LITHOLOGY, describeRock, geologySummary, readGeology } from './geology'

const W = 64
const H = 32
/** 50 km per cell at the equator. */
const RADIUS_KM = (50 * W) / (2 * Math.PI)
const ROW = 16

/**
 * Two plates split at x = 32 (west plate 1, east plate 2), each drifting
 * east–west at `westVx` / `eastVx` cells per Myr.
 */
function twoPlateWorld(westVx: number, eastVx: number, land: (x: number) => boolean = () => true): World {
  const n = W * H
  const mask = new Float32Array(n)
  const plateId = new Int16Array(n)
  const plateVx = new Float32Array(n)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      mask[i] = land(x) ? 1 : 0
      plateId[i] = x < W / 2 ? 1 : 2
      plateVx[i] = x < W / 2 ? westVx : eastVx
    }
  }
  return {
    meta: { ...DEFAULT_META, width: W, height: H, planetRadiusKm: RADIUS_KM },
    mask,
    plateId,
    plateVx,
    plateVy: new Float32Array(n),
    elev: new Float32Array(n).fill(600),
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
    cities: [],
    ...emptyPolityState(n),
  }
}

const at = (x: number, y = ROW) => y * W + x

describe('readGeology', () => {
  it('folds the join of two converging continents and leaves the far interior as craton', () => {
    const world = twoPlateWorld(1, -1)
    const g = readGeology(world)
    expect(g.boundaryKind[at(31)]).toBe(1)
    expect(g.boundaryKind[at(32)]).toBe(1)
    for (const x of [30, 31, 32, 33, 34]) expect(g.lith[at(x)]).toBe(LITHOLOGY.foldBelt)
    expect(g.lith[at(16)]).toBe(LITHOLOGY.craton)
    expect(g.ageMyr[at(16)]).toBeGreaterThanOrEqual(1500)
    expect(g.ageMyr[at(16)]).toBeLessThanOrEqual(3000)
    expect(g.ageMyr[at(32)]).toBeGreaterThanOrEqual(30)
    expect(g.ageMyr[at(32)]).toBeLessThanOrEqual(400)
  })

  it('lays rift basalt where two continents pull apart', () => {
    const world = twoPlateWorld(-1, 1)
    const g = readGeology(world)
    expect(g.boundaryKind[at(31)]).toBe(3)
    for (const x of [31, 32, 33]) expect(g.lith[at(x)]).toBe(LITHOLOGY.riftBasalt)
    expect(g.ageMyr[at(32)]).toBeLessThanOrEqual(30)
    expect(g.lith[at(16)]).toBe(LITHOLOGY.craton)
  })

  it('does not write to the world', () => {
    const world = twoPlateWorld(1, -1)
    const elev = world.elev.slice()
    const mask = world.mask.slice()
    const plateId = world.plateId.slice()
    readGeology(world)
    expect(Array.from(world.elev)).toEqual(Array.from(elev))
    expect(Array.from(world.mask)).toEqual(Array.from(mask))
    expect(Array.from(world.plateId)).toEqual(Array.from(plateId))
  })

  it('leaves ocean cells at 0 and puts an arc on the land side of a subduction edge', () => {
    // West plate is ocean diving east under the continent on plate 2.
    const world = twoPlateWorld(1, -1, (x) => x >= W / 2)
    const g = readGeology(world)
    for (let i = 0; i < world.mask.length; i++) {
      if (world.mask[i] < world.meta.threshold) {
        expect(g.lith[i]).toBe(0)
        expect(g.ageMyr[i]).toBe(0)
      }
    }
    expect(g.lith[at(32)]).toBe(LITHOLOGY.volcanicArc)
    expect(g.lith[at(34)]).toBe(LITHOLOGY.volcanicArc)
    expect(g.ageMyr[at(34)]).toBeLessThanOrEqual(60)
    const shares = geologySummary(world, g)
    expect(shares.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 6)
    expect(shares.every((r) => r.lith !== 0)).toBe(true)
  })
})

describe('describeRock', () => {
  it('is empty on ocean and names rock, age, and the plate edge on land', () => {
    const world = twoPlateWorld(1, -1, (x) => x >= 8)
    const g = readGeology(world)
    expect(describeRock(world, g, at(2))).toBe('')
    const fold = describeRock(world, g, at(35))
    expect(fold).toMatch(/^Fold belt: /)
    expect(fold).toMatch(/million years/)
    expect(fold).toMatch(/km to the west/)
    const craton = describeRock(world, g, at(20))
    expect(craton).toMatch(/^Craton: /)
    expect(craton).toMatch(/million years/)
  })
})
