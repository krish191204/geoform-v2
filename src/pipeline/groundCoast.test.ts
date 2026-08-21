import { describe, expect, it } from 'vitest'
import { groundCoast } from './groundCoast'
import { makeContinentWorld } from './__tests__/fixtures'

describe('groundCoast', () => {
  it('does not write the input mask', () => {
    const tw = makeContinentWorld()
    const copy = new Float32Array(tw.mask)
    groundCoast(tw.mask, tw.width, tw.height, 0.5, 42)
    expect(Array.from(tw.mask)).toEqual(Array.from(copy))
  })

  it('is deterministic and changes the doodle shoreline', () => {
    const tw = makeContinentWorld()
    const a = groundCoast(tw.mask, tw.width, tw.height, 0.5, 7)
    const b = groundCoast(tw.mask, tw.width, tw.height, 0.5, 7)
    expect(Array.from(a)).toEqual(Array.from(b))
    let flipped = 0
    for (let i = 0; i < a.length; i++) {
      const before = tw.mask[i] >= 0.5
      const after = a[i] >= 0.5
      if (before !== after) flipped++
    }
    expect(flipped).toBeGreaterThan(20)
  })

  it('keeps land area inside the lock budget', () => {
    const tw = makeContinentWorld()
    const grounded = groundCoast(tw.mask, tw.width, tw.height, 0.5, 99)
    let before = 0
    let after = 0
    for (let i = 0; i < tw.mask.length; i++) {
      if (tw.mask[i] >= 0.5) before++
      if (grounded[i] >= 0.5) after++
    }
    expect(Math.abs(after - before) / Math.max(1, before)).toBeLessThanOrEqual(0.12)
  })

  it('fills an inland brush sea that is not the world ocean', () => {
    const w = 32
    const h = 16
    const mask = new Float32Array(w * h)
    for (let y = 3; y < 13; y++) {
      for (let x = 6; x < 26; x++) mask[y * w + x] = 0.9
    }
    for (let y = 6; y < 10; y++) {
      for (let x = 12; x < 18; x++) mask[y * w + x] = 0
    }
    const grounded = groundCoast(mask, w, h, 0.5, 3)
    expect(grounded[8 * w + 14]).toBeGreaterThanOrEqual(0.5)
  })
})
