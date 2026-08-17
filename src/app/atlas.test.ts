import { describe, expect, it } from 'vitest'
import { atlasBakeWidth } from './atlas'

describe('atlasBakeWidth', () => {
  it('oversamples the Geoform 1 HD grid then caps at 4096', () => {
    expect(atlasBakeWidth(1600, 768)).toBe(3072)
    expect(atlasBakeWidth(5000, 768)).toBe(4096)
    expect(atlasBakeWidth(200, 64)).toBe(256)
  })
})
