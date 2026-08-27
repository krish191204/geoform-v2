import { describe, expect, it } from 'vitest'
import { labelLandmasses } from './countBigComponents'

describe('labelLandmasses', () => {
  it('names the biggest blob a continent and a smaller one an island', () => {
    const w = 16
    const h = 10
    const mask = new Float32Array(w * h)
    for (let y = 1; y <= 8; y++) {
      for (let x = 1; x <= 6; x++) mask[y * w + x] = 1
    }
    for (let y = 2; y <= 4; y++) {
      for (let x = 12; x <= 14; x++) mask[y * w + x] = 1
    }
    const labels = labelLandmasses(mask, w, h, 0.5)
    expect(labels.name.length).toBe(2)
    expect(labels.area[0]).toBeGreaterThan(labels.area[1])
    expect(labels.name[0]).not.toBe(labels.name[1])
    expect(labels.name[0].length).toBeGreaterThan(3)
    expect(labels.id[2 * w + 2]).toBe(0)
    expect(labels.id[3 * w + 13]).toBe(1)
    expect(labels.id[0]).toBe(-1)
  })
})
