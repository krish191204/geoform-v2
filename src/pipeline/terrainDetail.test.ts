/**
 * Tests for coherent relief and the short hydraulic-erosion pass.
 */

import { describe, expect, it } from 'vitest'
import { idx } from './helpers'
import {
  fbmSigned,
  hydraulicErode,
  perlin2,
  ridgeFbm,
  sculptTerrain,
} from './terrainDetail'

const W = 32
const H = 16
const THRESHOLD = 0.5

function filledLand(): Float32Array {
  return new Float32Array(W * H).fill(1)
}

function cone(): Float32Array {
  const elev = new Float32Array(W * H)
  const cx = 16
  const cy = 8
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy)
      elev[idx(W, x, y)] = Math.max(50, 2000 - d * 180)
    }
  }
  return elev
}

function mean(elev: Float32Array): number {
  let s = 0
  for (let i = 0; i < elev.length; i++) s += elev[i]
  return s / elev.length
}

function peak(elev: Float32Array): number {
  let p = -Infinity
  for (let i = 0; i < elev.length; i++) if (elev[i] > p) p = elev[i]
  return p
}

describe('perlin / fBm / ridge', () => {
  it('is deterministic', () => {
    expect(perlin2(1.25, 2.5, 7)).toBe(perlin2(1.25, 2.5, 7))
    expect(fbmSigned(0.4, 0.8, 3)).toBe(fbmSigned(0.4, 0.8, 3))
    expect(ridgeFbm(0.2, 0.9, 11)).toBe(ridgeFbm(0.2, 0.9, 11))
  })

  it('varies with seed and with position', () => {
    expect(perlin2(1.25, 2.5, 7)).not.toBe(perlin2(1.25, 2.5, 8))
    expect(perlin2(1.25, 2.5, 7)).not.toBe(perlin2(1.3, 2.5, 7))
  })

  it('keeps neighbouring fBm samples closer than white noise would', () => {
    const seed = 4
    const a = fbmSigned(0.4, 0.5, seed)
    const b = fbmSigned(0.41, 0.5, seed)
    expect(Math.abs(a - b)).toBeLessThan(0.15)
  })

  it('keeps ridgeFbm in [0, 1]', () => {
    for (let i = 0; i < 20; i++) {
      const v = ridgeFbm(i * 0.17, i * 0.11, 2)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('hydraulicErode', () => {
  it('is deterministic', () => {
    const mask = filledLand()
    const a = cone()
    const b = cone()
    hydraulicErode(a, mask, W, H, THRESHOLD, 5)
    hydraulicErode(b, mask, W, H, THRESHOLD, 5)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('lowers the peak and the mean of a cone', () => {
    const mask = filledLand()
    const elev = cone()
    const beforeMean = mean(elev)
    const beforePeak = peak(elev)
    hydraulicErode(elev, mask, W, H, THRESHOLD, 5)
    expect(peak(elev)).toBeLessThan(beforePeak)
    expect(mean(elev)).toBeLessThan(beforeMean)
    for (let i = 0; i < elev.length; i++) {
      expect(Number.isFinite(elev[i])).toBe(true)
      expect(elev[i]).toBeGreaterThanOrEqual(0)
    }
  })

  it('does not raise ocean cells', () => {
    const mask = filledLand()
    // Punch a sea hole in the corner.
    mask[0] = 0
    mask[1] = 0
    mask[W] = 0
    const elev = cone()
    elev[0] = -400
    elev[1] = 0
    elev[W] = 0
    hydraulicErode(elev, mask, W, H, THRESHOLD, 9)
    expect(elev[0]).toBe(-400)
    expect(elev[1]).toBe(0)
    expect(elev[W]).toBe(0)
  })
})

describe('sculptTerrain', () => {
  it('adds coherent relief without NaNs or ocean leak', () => {
    const mask = filledLand()
    mask[0] = 0
    const elev = new Float32Array(W * H).fill(200)
    elev[0] = 0
    const uplift = new Float32Array(W * H)
    sculptTerrain(elev, uplift, mask, W, H, THRESHOLD, 12)
    expect(elev[0]).toBe(0)
    let landMin = Infinity
    let landMax = -Infinity
    for (let i = 1; i < elev.length; i++) {
      expect(Number.isFinite(elev[i])).toBe(true)
      if (elev[i] < landMin) landMin = elev[i]
      if (elev[i] > landMax) landMax = elev[i]
    }
    expect(landMin).toBeGreaterThanOrEqual(0)
    expect(landMax).toBeGreaterThan(landMin)
    expect(landMax).toBeLessThan(1200)
  })
})
