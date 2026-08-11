import { describe, it, expect } from 'vitest'
import { createRng, hash2, valueNoise2D, fbm } from './noise'

describe('noise helpers', () => {
  it('createRng is deterministic for a given seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    for (let i = 0; i < 5; i++) {
      expect(a()).toBe(b())
    }
  })

  it('createRng produces values in [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 100; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('createRng different seeds diverge', () => {
    const a = createRng(1)
    const b = createRng(2)
    const samplesA = Array.from({ length: 4 }, () => a())
    const samplesB = Array.from({ length: 4 }, () => b())
    expect(samplesA).not.toEqual(samplesB)
  })

  it('hash2 returns deterministic values', () => {
    expect(hash2(3, 4, 7)).toBeCloseTo(hash2(3, 4, 7), 12)
  })

  it('valueNoise2D is in [0, 1]', () => {
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        const v = valueNoise2D(x * 0.37, y * 0.71, 99)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('fbm gives a smooth noise in [0, 1]', () => {
    const v = fbm(0.5, 0.5, 1, 5)
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  })
})
