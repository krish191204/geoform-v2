import { describe, expect, it } from 'vitest'
import { classifyOcean } from './oceanClass'

describe('classifyOcean', () => {
  it('returns null on land', () => {
    const mask = Float32Array.from([1, 0, 0, 0])
    const summer = Float32Array.from([10, 10, 10, 10])
    expect(classifyOcean(mask, summer, 2, 2, 0.5, 0, 0)).toBeNull()
  })

  it('marks polar SST as ice-edge', () => {
    const mask = new Float32Array(9)
    const summer = new Float32Array(9).fill(-2)
    expect(classifyOcean(mask, summer, 3, 3, 0.5, 1, 1)).toBe('ice-edge')
  })

  it('marks a cell next to land as shelf, and far ocean as open', () => {
    const w = 24
    const h = 3
    const mask = new Float32Array(w * h)
    mask[1 * w + 0] = 1
    const summer = new Float32Array(w * h).fill(18)
    expect(classifyOcean(mask, summer, w, h, 0.5, 1, 1)).toBe('shelf')
    expect(classifyOcean(mask, summer, w, h, 0.5, 12, 1)).toBe('open')
  })
})
