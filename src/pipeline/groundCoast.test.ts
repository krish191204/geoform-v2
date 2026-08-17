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

  it('keeps land area inside the 5% lock budget', () => {
    const tw = makeContinentWorld()
    const grounded = groundCoast(tw.mask, tw.width, tw.height, 0.5, 99)
    let before = 0
    let after = 0
    for (let i = 0; i < tw.mask.length; i++) {
      if (tw.mask[i] >= 0.5) before++
      if (grounded[i] >= 0.5) after++
    }
    expect(Math.abs(after - before) / Math.max(1, before)).toBeLessThanOrEqual(0.05)
  })
})
