import { describe, expect, it } from 'vitest'
import { atlasBakeWidth, LAYER_CHIPS } from './atlas'
import { groupedBiomeLegend } from '../world/types'

describe('atlasBakeWidth', () => {
  it('oversamples the Geoform 1 HD grid then caps at 4096', () => {
    expect(atlasBakeWidth(1600, 768)).toBe(3072)
    expect(atlasBakeWidth(5000, 768)).toBe(4096)
    expect(atlasBakeWidth(200, 64)).toBe(256)
    expect(atlasBakeWidth(1600, 768, true)).toBe(768)
  })

  it('matches Geoform 1 published-build raster budget so Vercel stays interactive', () => {
    expect(atlasBakeWidth(1600, 768, { prod: true, gridH: 384 })).toBe(1536)
    expect(atlasBakeWidth(1600, 768, { preview: true, prod: true, gridH: 384 })).toBe(768)
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
    expect(LAYER_CHIPS.find((c) => c.id === 'biome')?.title).toMatch(/climate/i)
    expect(LAYER_CHIPS.find((c) => c.id === 'biome')?.title).not.toMatch(/Holdridge/i)
  })
})

describe('groupedBiomeLegend', () => {
  it('hides empty groups and lists subtypes under Forest / Dry / Cold / Wet', () => {
    const groups = groupedBiomeLegend(['ocean', 'tundra', 'hot-desert', 'rainforest', 'wetland'])
    expect(groups.map((g) => g.label)).toEqual(['Cold', 'Dry', 'Forest', 'Wet'])
    expect(groups.find((g) => g.label === 'Forest')?.entries.map((e) => e.id)).toEqual(['rainforest'])
  })
})
