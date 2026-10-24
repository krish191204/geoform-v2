import { describe, expect, it } from 'vitest'
import type { CellBiome, World, WorldMeta } from '../world/types'
import {
  annualMeanInsolation,
  cellKm,
  cellPhysics,
  circumferenceKm,
  coriolisParameter,
  dailyMeanInsolation,
  dayLengthHours,
  DECEMBER_SOLSTICE_DAY,
  describeSky,
  escapeVelocity,
  formatPlanetCard,
  horizonKm,
  inertialPeriodHours,
  JUNE_SOLSTICE_DAY,
  planetCard,
  polarCircleDeg,
  pressureAtElevationHpa,
  scaleHeightKm,
  SOLAR_CONSTANT_WM2,
  solarDeclinationRad,
  surfaceGravity,
  tropicDeg,
} from './planetPhysics'

const DEG = Math.PI / 180
const NORTH_POLE = Math.PI / 2

function stubWorld(overrides: Partial<WorldMeta> = {}): World {
  const meta: WorldMeta = {
    seed: 1,
    width: 4,
    height: 5,
    planetRadiusKm: 6371,
    obliquityDeg: 23.5,
    seaLevel: 0.5,
    threshold: 0.5,
    ...overrides,
  }
  const n = meta.width * meta.height
  const f32 = (fn: (i: number) => number) => {
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = fn(i)
    return a
  }
  const biome: CellBiome[] = Array.from({ length: n }, (_, i) => (i % 2 ? 'ocean' : 'steppe'))
  return {
    meta,
    mask: f32((i) => (i % 2 ? 0.1 : 0.9)),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: f32((i) => (i % 2 ? -3000 : 1500 * (i % 4))),
    seasons: 2,
    summer: f32(() => 20),
    winter: f32(() => 0),
    summerMoist: f32(() => 0.5),
    winterMoist: f32(() => 0.5),
    tempMean: f32((i) => 15 - (i % 4)),
    tempRange: f32(() => 20),
    moistMean: f32(() => 0.5),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome,
    suitability: new Float32Array(n),
    cities: [],
    polityId: new Int16Array(n).fill(-1),
    polities: [],
    routes: [],
  }
}

/** Complete elliptic integral of the second kind, by a fine midpoint rule. */
function ellipticE(k: number): number {
  const n = 20000
  let s = 0
  for (let j = 0; j < n; j++) {
    const t = ((j + 0.5) * (Math.PI / 2)) / n
    s += Math.sqrt(1 - k * k * Math.sin(t) ** 2)
  }
  return (s * (Math.PI / 2)) / n
}

describe('bulk planet', () => {
  it('matches Earth', () => {
    expect(surfaceGravity(6371)).toBeCloseTo(9.82, 2)
    expect(escapeVelocity(6371)).toBeCloseTo(11.19, 1)
    expect(horizonKm(6371)).toBeCloseTo(4.654, 2)
    expect(circumferenceKm(6371)).toBeCloseTo(40030.2, 0)
    expect(cellKm(6371, 768)).toBeCloseTo(52.12, 1)
    expect(tropicDeg(23.5)).toBe(23.5)
    expect(polarCircleDeg(23.5)).toBe(66.5)
  })

  it('doubles gravity when the radius doubles at fixed density', () => {
    expect(surfaceGravity(2 * 6371) / surfaceGravity(6371)).toBeCloseTo(2, 12)
    expect(surfaceGravity(6371, 2 * 5514) / surfaceGravity(6371)).toBeCloseTo(2, 12)
  })
})

describe('sunlight', () => {
  it('gives S0/π at the equator on the equinox', () => {
    expect(dailyMeanInsolation(0, 0)).toBeCloseTo(SOLAR_CONSTANT_WM2 / Math.PI, 9)
    expect(dailyMeanInsolation(0, 0)).toBeCloseTo(433.2, 1)
  })

  it('gives S0·sin δ at the pole on the June solstice', () => {
    const decl = solarDeclinationRad(23.44, JUNE_SOLSTICE_DAY)
    expect(decl / DEG).toBeCloseTo(23.44, 1)
    const q = dailyMeanInsolation(NORTH_POLE, decl)
    expect(q).toBeCloseTo(SOLAR_CONSTANT_WM2 * Math.sin(decl), 6)
    expect(q).toBeGreaterThan(540)
    expect(q).toBeLessThan(542)
    // Earth's measured ~524 comes from June sitting near aphelion (1.0167 AU).
    const atAphelion = dailyMeanInsolation(NORTH_POLE, decl, SOLAR_CONSTANT_WM2 / 1.0167 ** 2)
    expect(atAphelion).toBeGreaterThan(520)
    expect(atAphelion).toBeLessThan(525)
  })

  it('integrates the annual mean to the closed forms', () => {
    const tilt = 23.44
    const k = Math.sin(tilt * DEG)
    const equatorExact = (SOLAR_CONSTANT_WM2 / Math.PI) * (2 / Math.PI) * ellipticE(k)
    const poleExact = (SOLAR_CONSTANT_WM2 * k) / Math.PI
    expect(annualMeanInsolation(0, tilt)).toBeCloseTo(equatorExact, 2)
    expect(Math.abs(annualMeanInsolation(NORTH_POLE, tilt) - poleExact)).toBeLessThan(0.1)
    expect(equatorExact).toBeGreaterThan(415)
    expect(equatorExact).toBeLessThan(416)
    expect(poleExact).toBeGreaterThan(172)
    expect(poleExact).toBeLessThan(173)
  })

  it('has polar night at the north pole in December', () => {
    const decl = solarDeclinationRad(23.5, DECEMBER_SOLSTICE_DAY)
    expect(dailyMeanInsolation(NORTH_POLE, decl)).toBe(0)
    expect(dayLengthHours(NORTH_POLE, decl)).toBe(0)
    const pole = cellPhysics(stubWorld(), 0)
    expect(pole.insolationDecember).toBe(0)
    expect(pole.dayLengthDecember).toBe(0)
    expect(pole.dayLengthJune).toBe(24)
  })

  it('gives a long June day at 52°N', () => {
    const hours = dayLengthHours(52 * DEG, solarDeclinationRad(23.5, JUNE_SOLSTICE_DAY))
    expect(hours).toBeGreaterThan(16.3)
    expect(hours).toBeLessThan(16.7)
  })

  it('has no seasons and 12 h days everywhere at zero tilt', () => {
    const world = stubWorld({ obliquityDeg: 0 })
    for (let i = 0; i < world.meta.width * world.meta.height; i++) {
      const c = cellPhysics(world, i)
      expect(c.insolationJune).toBeCloseTo(c.insolationDecember, 9)
      expect(c.dayLengthJune).toBeCloseTo(12, 9)
      expect(c.dayLengthDecember).toBeCloseTo(12, 9)
    }
  })
})

describe('spin and air', () => {
  it('matches Earth', () => {
    expect(coriolisParameter(45 * DEG)).toBeCloseTo(1.0313e-4, 7)
    expect(inertialPeriodHours(NORTH_POLE)).toBeCloseTo(11.97, 1)
    expect(inertialPeriodHours(0)).toBe(Infinity)
    expect(scaleHeightKm(15)).toBeCloseTo(8.433, 2)
    expect(pressureAtElevationHpa(0, 15)).toBeCloseTo(1013.25, 9)
  })

  it('reads ocean pressure at the sea surface and highland pressure lower', () => {
    const world = stubWorld()
    expect(cellPhysics(world, 1).pressureHpa).toBeCloseTo(1013.25, 3)
    expect(cellPhysics(world, 2).pressureHpa).toBeLessThan(750)
  })
})

describe('cellPhysics', () => {
  it('does not mutate the world', () => {
    const world = stubWorld()
    const before = {
      meta: { ...world.meta },
      mask: world.mask.slice(),
      elev: world.elev.slice(),
      tempMean: world.tempMean.slice(),
      biome: [...world.biome],
    }
    Object.freeze(world.meta)
    Object.freeze(world)
    for (let i = 0; i < world.meta.width * world.meta.height; i++) cellPhysics(world, i)
    expect(world.meta).toEqual(before.meta)
    expect(world.mask).toEqual(before.mask)
    expect(world.elev).toEqual(before.elev)
    expect(world.tempMean).toEqual(before.tempMean)
    expect(world.biome).toEqual(before.biome)
  })
})

describe('copy', () => {
  it('formats the Earth card', () => {
    const lines = formatPlanetCard(
      planetCard({
        seed: 1,
        width: 768,
        height: 384,
        planetRadiusKm: 6371,
        obliquityDeg: 23.5,
        seaLevel: 0.5,
        threshold: 0.5,
      }),
    )
    expect(lines).toContain('Gravity 9.82 m/s² (1.00× Earth)')
    expect(lines).toContain('Tropics at 23.5°, polar circles at 66.5°')
    expect(lines).toContain('Equator gets 2.4× the sunlight of the poles over a year')
  })

  it('describes polar day and night with hemisphere suffixes', () => {
    const world = stubWorld()
    expect(describeSky(cellPhysics(world, 0))).toMatch(
      /^At 90°N the June sun never sets and the December sun never rises; air pressure about \d+ hPa\.$/,
    )
    expect(describeSky(cellPhysics(world, 12))).toMatch(/^At 45°S /)
    expect(describeSky(cellPhysics(world, 8))).toMatch(/^At 0° the June day lasts 12\.0 h/)
  })
})
