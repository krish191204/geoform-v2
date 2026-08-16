import { describe, it, expect } from 'vitest'
import { generateWorld, paintElevation, nextCityName } from './generate'

describe('generate', () => {
  it('generateWorld produces a world with valid buffers', () => {
    const world = generateWorld(32, 16, 99)
    expect(world.width).toBe(32)
    expect(world.height).toBe(16)
    expect(world.elev.length).toBe(32 * 16)
    expect(world.temp.length).toBe(32 * 16)
    expect(world.moist.length).toBe(32 * 16)
    expect(world.flux.length).toBe(32 * 16)
    expect(world.plateId.length).toBe(32 * 16)
    expect(world.biome.length).toBe(32 * 16)
    expect(world.suitability.length).toBe(32 * 16)
    expect(Array.isArray(world.cities)).toBe(true)
    expect(world.plateCount).toBeGreaterThan(0)
    expect(world.seed).toBe(99)
  })

  it('generateWorld is deterministic for same seed', () => {
    const a = generateWorld(24, 12, 5)
    const b = generateWorld(24, 12, 5)
    // Pick a few cells and compare.
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev))
    expect(Array.from(a.plateId)).toEqual(Array.from(a.plateId))
  })

  it('paintElevation modifies elev in brush radius', () => {
    const world = generateWorld(24, 16, 3)
    const before = world.elev[10 * world.width + 10]
    paintElevation(world, 10, 10, 3, 0.5)
    const after = world.elev[10 * world.width + 10]
    expect(after).toBeGreaterThan(before)

    // Cells outside the radius should be untouched.
    expect(world.elev[0]).toBe(world.elev[0])
  })

  it('paintElevation with negative amount lowers terrain', () => {
    const world = generateWorld(16, 12, 7)
    // Reset to a flat-ish surface.
    for (let i = 0; i < world.elev.length; i++) world.elev[i] = 0.8
    const before = world.elev[5 * world.width + 5]
    paintElevation(world, 5, 5, 2, -0.5)
    const after = world.elev[5 * world.width + 5]
    expect(after).toBeLessThan(before)
  })

  it('paintElevation records each stroke in world.sculpt for server recompute', () => {
    const world = generateWorld(24, 16, 5)
    expect(world.sculpt).toEqual([])
    paintElevation(world, 10, 8, 3, 0.4)
    paintElevation(world, 5, 5, 2, -0.3)
    paintElevation(world, 20, 12, 4, 0.7)
    expect(world.sculpt.length).toBe(3)
    expect(world.sculpt[0]).toMatchObject({ x: 10, y: 8, radius: 3, delta: 0.4, tool: 'raise' })
    expect(world.sculpt[1]).toMatchObject({ x: 5, y: 5, radius: 2, delta: -0.3, tool: 'lower' })
    expect(world.sculpt[2]).toMatchObject({ x: 20, y: 12, radius: 4, delta: 0.7, tool: 'raise' })
    // Out-of-bounds brush centers must be clipped, not throw.
    paintElevation(world, -5, 100, 2, 0.2)
    expect(world.sculpt[world.sculpt.length - 1].x).toBe(0)
    expect(world.sculpt[world.sculpt.length - 1].y).toBe(15)
  })

  it('nextCityName returns unique names', () => {
    const world = generateWorld(16, 12, 42)
    const n1 = nextCityName(world)
    expect(typeof n1).toBe('string')
    expect(n1.length).toBeGreaterThan(0)
    world.cities.push({ x: 0, y: 0, name: n1, score: 1 })
    const n2 = nextCityName(world)
    expect(n2).not.toBe(n1)
  })
})
