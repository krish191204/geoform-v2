import { describe, expect, it } from 'vitest'
import { fillMaskComponent, OCEAN_FILL_FRACTION, LAND_FILL_FRACTION } from './fillMask'

describe('fillMaskComponent', () => {
  it('flips a land blob to ocean', () => {
    const w = 12
    const h = 8
    const mask = new Float32Array(w * h)
    mask[3 * w + 4] = 1
    mask[3 * w + 5] = 1
    mask[4 * w + 4] = 1
    const result = fillMaskComponent(mask, w, h, 0.5, 4, 3)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.flippedTo).toBe('ocean')
      expect(result.mutatedCells).toBe(3)
    }
    expect(mask[3 * w + 4]).toBe(0)
    expect(mask[4 * w + 5]).toBe(0)
  })

  it('fills a small lake and refuses the open ocean', () => {
    const w = 16
    const h = 10
    const mask = new Float32Array(w * h).fill(1)
    mask[4 * w + 6] = 0
    mask[4 * w + 7] = 0
    const lake = fillMaskComponent(mask, w, h, 0.5, 6, 4)
    expect(lake.ok).toBe(true)
    if (lake.ok) expect(lake.flippedTo).toBe('land')
    expect(mask[4 * w + 6]).toBe(1)

    const sea = new Float32Array(w * h)
    sea[2 * w + 2] = 1
    const open = fillMaskComponent(sea, w, h, 0.5, 0, 0)
    expect(open).toEqual({ ok: false, reason: 'ocean' })
    expect(sea[0]).toBe(0)
  })

  it('wraps longitude when filling', () => {
    const w = 8
    const h = 4
    const mask = new Float32Array(w * h)
    mask[1 * w + 0] = 1
    mask[1 * w + w - 1] = 1
    const result = fillMaskComponent(mask, w, h, 0.5, 0, 1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mutatedCells).toBe(2)
    expect(mask[1 * w + w - 1]).toBe(0)
  })

  it('refuses to erase a continent-sized land blob', () => {
    const w = 20
    const h = 10
    const mask = new Float32Array(w * h).fill(1)
    const open = fillMaskComponent(mask, w, h, 0.5, 4, 4)
    expect(open).toEqual({ ok: false, reason: 'land' })
    expect(mask[4 * w + 4]).toBe(1)
  })

  it('keeps the ocean cap as a small fraction of the grid', () => {
    expect(OCEAN_FILL_FRACTION).toBeLessThan(0.05)
    expect(LAND_FILL_FRACTION).toBeGreaterThan(OCEAN_FILL_FRACTION)
  })

  it('clears range notes on the filled blob', () => {
    const w = 8
    const h = 6
    const mask = new Float32Array(w * h)
    const marks = new Uint8Array(w * h)
    mask[2 * w + 2] = 1
    marks[2 * w + 2] = 1
    const result = fillMaskComponent(mask, w, h, 0.5, 2, 2, marks)
    expect(result.ok).toBe(true)
    expect(marks[2 * w + 2]).toBe(0)
  })
})
