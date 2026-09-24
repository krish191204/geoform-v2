import { describe, expect, it } from 'vitest'
import { ageContinent, ageLand, SITE_MIRROR, SITE_SLOT, SITE_SPRING } from './ageLand'

describe('ageLand', () => {
  it('marks a seasonal salt sheet and a dry walled river, and skips a wet lake', () => {
    const w = 8
    const h = 6
    const n = w * h
    const mask = new Float32Array(n).fill(1)
    const elev = new Float32Array(n).fill(400)
    const salt = new Uint8Array(n)
    const rivers = new Uint8Array(n)
    const plateId = new Int16Array(n).fill(0)
    const plateVx = new Float32Array(n)
    const plateVy = new Float32Array(n)
    salt[w + 2] = 1
    rivers[3 * w + 5] = 1
    elev[2 * w + 5] = 800
    elev[4 * w + 5] = 800
    plateId[w + 4] = 1
    plateVx[w + 4] = 0.2
    const sites = ageLand({
      width: w,
      height: h,
      threshold: 0.5,
      mask,
      elev,
      tempMean: new Float32Array(n).fill(16),
      summerMoist: new Float32Array(n).fill(0.05),
      winterMoist: new Float32Array(n).fill(0.4),
      moistMean: new Float32Array(n).fill(0.12),
      flux: new Float32Array(n).fill(4),
      rivers,
      salt,
      plateId,
      plateVx,
      plateVy,
    })
    expect(sites[w + 2]).toBe(SITE_MIRROR)
    expect(sites[3 * w + 5]).toBe(SITE_SLOT)
    expect(sites[w + 3] === SITE_SPRING || sites[w + 4] === SITE_SPRING).toBe(true)
  })

  it('levels a dry floor that drains inward and leaves the coast mask untouched', () => {
    const w = 7
    const h = 5
    const n = w * h
    const mask = new Float32Array(n).fill(1)
    const elev = new Float32Array(n).fill(200)
    const salt = new Uint8Array(n)
    mask[0] = 0
    salt[2 * w + 3] = 1
    elev[2 * w + 3] = 40
    elev[2 * w + 2] = 48
    elev[2 * w + 4] = 48
    const before = new Float32Array(mask)
    const aged = ageContinent({
      width: w,
      height: h,
      threshold: 0.5,
      mask,
      elev,
      tempMean: new Float32Array(n).fill(20),
      summerMoist: new Float32Array(n).fill(0.05),
      winterMoist: new Float32Array(n).fill(0.3),
      moistMean: new Float32Array(n).fill(0.1),
      flux: new Float32Array(n),
      rivers: new Uint8Array(n),
      salt,
      plateId: new Int16Array(n),
      plateVx: new Float32Array(n),
      plateVy: new Float32Array(n),
    })
    expect(aged.salt[2 * w + 2]).toBe(1)
    expect(aged.elev[2 * w + 2]).toBe(40)
    expect(Array.from(mask)).toEqual(Array.from(before))
    expect(aged.sites[2 * w + 3]).toBe(SITE_MIRROR)
  })
})