import { describe, expect, it } from 'vitest'
import { PAPER_KEY_LIGHT, paperKeyLightDirection } from './globe'

describe('paperKeyLightDirection', () => {
  it('places the key light in the texture upper-left (north and west)', () => {
    const L = paperKeyLightDirection()
    const len = Math.hypot(L.x, L.y, L.z)
    expect(len).toBeCloseTo(1, 5)
    // Map-centre frame: +X outward, +Y north (texture up), +Z west (texture left).
    expect(L.x).toBeGreaterThan(0)
    expect(L.y).toBeGreaterThan(0)
    expect(L.z).toBeGreaterThan(0)
    // Atlas weights: west 4.2, north 3.0 — the leftward component is stronger.
    expect(L.z / L.y).toBeCloseTo(PAPER_KEY_LIGHT.west / PAPER_KEY_LIGHT.north, 5)
    // Altitude is high, so the light is above the horizon and shadows stay soft.
    expect(L.x).toBeGreaterThan(Math.hypot(L.y, L.z))
  })
})
