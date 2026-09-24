import { describe, expect, it } from 'vitest'
import { applyGlaciation } from './glaciation'

describe('applyGlaciation ice line', () => {
  it('iceLineC 5 marks a 2°C cell as ice and iceLineC 0 does not', () => {
    const w = 4
    const h = 4
    const n = w * h
    const elev = new Float32Array(n).fill(100)
    const mask = new Float32Array(n).fill(1)
    const summer = new Float32Array(n).fill(2)
    const winter = new Float32Array(n).fill(2)
    const budget = { inputLandArea: n, areaFraction: 0.12, minComponent: 100 }
    const warmLine = applyGlaciation(elev, Float32Array.from(mask), summer, winter, w, h, 0.5, budget, 5)
    const earthLine = applyGlaciation(elev, Float32Array.from(mask), summer, winter, w, h, 0.5, budget, 0)
    expect(warmLine.ice[0]).toBe(1)
    expect(earthLine.ice[0]).toBe(0)
    expect(Array.from(mask)).toEqual(Array.from(new Float32Array(n).fill(1)))
  })
})
