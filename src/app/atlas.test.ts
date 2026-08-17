import { describe, expect, it } from 'vitest'
import { atlasBakeWidth, LAYER_CHIPS } from './atlas'

describe('atlasBakeWidth', () => {
  it('oversamples the Geoform 1 HD grid then caps at 4096', () => {
    expect(atlasBakeWidth(1600, 768)).toBe(3072)
    expect(atlasBakeWidth(5000, 768)).toBe(4096)
    expect(atlasBakeWidth(200, 64)).toBe(256)
  })
})

describe('LAYER_CHIPS', () => {
  it('states one message per layer so chips do not hide climate under prettier green', () => {
    expect(LAYER_CHIPS.map((c) => c.id)).toEqual([
      'relief',
      'biome',
      'moisture',
      'temperature',
      'suitability',
      'plates',
      'elevation',
    ])
    for (const chip of LAYER_CHIPS) {
      expect(chip.title.length).toBeGreaterThan(8)
    }
    expect(LAYER_CHIPS.find((c) => c.id === 'temperature')?.title).toMatch(/temperature/i)
    expect(LAYER_CHIPS.find((c) => c.id === 'elevation')?.title).toMatch(/metres/i)
  })
})
