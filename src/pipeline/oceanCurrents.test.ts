import { describe, expect, it } from 'vitest'
import { computeOceanCurrents } from './oceanCurrents'

describe('computeOceanCurrents', () => {
  it('currentStrength 0 yields zero temp bias and unit moisture scales', () => {
    const width = 32
    const height = 16
    const mask = new Float32Array(width * height)
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < height; y++) mask[y * width + x] = 1
    }
    const off = computeOceanCurrents(mask, width, height, 0.5, 0)
    expect(off.tempBias.every((v) => v === 0)).toBe(true)
    expect(off.evapScale.every((v) => v === 1)).toBe(true)
    expect(off.moistScale.every((v) => v === 1)).toBe(true)
    const on = computeOceanCurrents(mask, width, height, 0.5, 1)
    const implicit = computeOceanCurrents(mask, width, height, 0.5)
    expect(Array.from(on.tempBias)).toEqual(Array.from(implicit.tempBias))
    expect(on.tempBias.some((v) => v !== 0)).toBe(true)
  })
})
