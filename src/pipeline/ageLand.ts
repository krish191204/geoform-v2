/**
 * Geologic fast-forward. Runs only after the continent has been grounded.
 * The seven Make sense steps are left alone. This pass may flatten a dry
 * pit floor, drop a slot a few metres, or raise a terrace a few metres.
 * It never edits the coast mask, and it never marks a surface the climate
 * or the plates do not already allow.
 *
 * 1 salt mirror — dry playa with a wetter season, a thin sheet of water
 * 2 hot spring — land on a plate that is pulling apart, warm enough for water
 * 3 travertine — the slope just downhill of that spring
 * 4 hoodoo — an arid local peak with a steep drop beside it
 * 5 slot — a river in dry country with high walls
 */

import { SALT_SUMMER_MOIST } from './hydrology'

export const SITE_MIRROR = 1
export const SITE_SPRING = 2
export const SITE_TERRACE = 3
export const SITE_HOODOO = 4
export const SITE_SLOT = 5

export interface AgeLandInput {
  width: number
  height: number
  threshold: number
  mask: Float32Array
  elev: Float32Array
  tempMean: Float32Array
  summerMoist: Float32Array
  winterMoist: Float32Array
  moistMean: Float32Array
  flux: Float32Array
  rivers: Uint8Array
  salt: Uint8Array
  lakes?: Uint8Array
  ice?: Uint8Array
  plateId: Int16Array
  plateVx: Float32Array
  plateVy: Float32Array
}

/** How hard the neighbouring plate is pulling away, in cells per million years. */
function pullApart(
  plateId: Int16Array,
  vx: Float32Array,
  vy: Float32Array,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const i = y * w + x
  const id = plateId[i]
  if (id < 0) return 0
  let best = 0
  const n4: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  for (const [dx, dy] of n4) {
    const nx = (x + dx + w) % w
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    const j = ny * w + nx
    if (plateId[j] === id || plateId[j] < 0) continue
    const pull = (vx[j] - vx[i]) * dx + (vy[j] - vy[i]) * dy
    if (pull > best) best = pull
  }
  return best
}

export function ageLand(input: AgeLandInput): Uint8Array {
  const {
    width: w,
    height: h,
    threshold,
    mask,
    elev,
    tempMean,
    summerMoist,
    winterMoist,
    moistMean,
    rivers,
    salt,
    ice,
    plateId,
    plateVx,
    plateVy,
  } = input
  const n = w * h
  const sites = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (mask[i] < threshold || (ice && ice[i])) continue
    if (salt[i] && winterMoist[i] > summerMoist[i] + 0.06 && winterMoist[i] > 0.12) {
      sites[i] = SITE_MIRROR
    }
  }
  const springCandidates: { i: number; pull: number }[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (mask[i] < threshold || sites[i] || salt[i] || (ice && ice[i])) continue
      if (tempMean[i] < 8) continue
      const pull = pullApart(plateId, plateVx, plateVy, x, y, w, h)
      if (pull <= 0.015) continue
      springCandidates.push({ i, pull })
    }
  }
  springCandidates.sort((a, b) => b.pull - a.pull)
  const springGap = Math.max(28, Math.round(w / 14))
  const placed: { x: number; y: number }[] = []
  for (const candidate of springCandidates) {
    if (placed.length >= 4) break
    const x = candidate.i % w
    const y = (candidate.i - x) / w
    let crowded = false
    for (const p of placed) {
      const dx = Math.min(Math.abs(x - p.x), w - Math.abs(x - p.x))
      const dy = Math.abs(y - p.y)
      if (dx * dx + dy * dy < springGap * springGap) {
        crowded = true
        break
      }
    }
    if (crowded) continue
    const i = candidate.i
    sites[i] = SITE_SPRING
    placed.push({ x, y })
    let sx = x
    let sy = y
    for (let step = 0; step < 3; step++) {
        let best = -1
        let bestE = elev[sy * w + sx]
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = (sx + dx + w) % w
          const ny = sy + dy
          if (ny < 0 || ny >= h) continue
          const j = ny * w + nx
          if (mask[j] < threshold || sites[j] || salt[j]) continue
          if (elev[j] < bestE - 8) {
            bestE = elev[j]
            best = j
            sx = nx
            sy = ny
          }
        }
        if (best < 0) break
        sites[best] = SITE_TERRACE
      }
    }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (mask[i] < threshold || sites[i] || salt[i] || rivers[i]) continue
      if (moistMean[i] > 0.28 || elev[i] < 150 || elev[i] > 2200) continue
      let drop = 0
      let lower = 0
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = (x + dx + w) % w
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        const gap = elev[i] - elev[ny * w + nx]
        if (gap > 0) lower++
        if (gap > drop) drop = gap
      }
      if (lower === 4 && drop > 160) sites[i] = SITE_HOODOO
    }
  }
  for (let i = 0; i < n; i++) {
    if (!rivers[i] || sites[i] || salt[i]) continue
    if (moistMean[i] > 0.3) continue
    let ns = Infinity
    let ew = Infinity
    const x = i % w
    const y = (i - x) / w
    for (const [dx, dy, axis] of [
      [0, -1, 'ns'],
      [0, 1, 'ns'],
      [-1, 0, 'ew'],
      [1, 0, 'ew'],
    ] as const) {
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const rise = elev[ny * w + ((x + dx + w) % w)] - elev[i]
      if (axis === 'ns') ns = Math.min(ns, rise)
      else ew = Math.min(ew, rise)
    }
    if (Math.max(ns, ew) > 280) sites[i] = SITE_SLOT
  }
  return sites
}

const PLAYA_ABOVE_M = 18
const SLOT_DROP_M = 8
const TERRACE_RISE_M = 4

function drainsInward(
  elev: Float32Array,
  salt: Uint8Array,
  mask: Float32Array,
  i: number,
  w: number,
  h: number,
  threshold: number,
): boolean {
  const x = i % w
  const y = (i - x) / w
  let lower = false
  let lowerSalt = false
  let lowest = Infinity
  let flatSalt = false
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = (x + dx + w) % w
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    const j = ny * w + nx
    if (mask[j] < threshold) return false
    if (elev[j] < elev[i]) {
      lower = true
      if (elev[j] < lowest) {
        lowest = elev[j]
        lowerSalt = salt[j] === 1
      } else if (elev[j] === lowest && salt[j] === 1) lowerSalt = true
    } else if (salt[j] === 1) flatSalt = true
  }
  return lower ? lowerSalt : flatSalt
}

/** Grow salt across a dry pit floor that still drains inward, and level that floor. */
function growPlaya(input: AgeLandInput): { salt: Uint8Array; elev: Float32Array } {
  const { width: w, height: h, threshold, mask, summerMoist, lakes, ice } = input
  const salt = new Uint8Array(input.salt)
  const elev = new Float32Array(input.elev)
  const n = w * h
  const floorOf = new Float32Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) {
    if (!salt[i]) continue
    floorOf[i] = elev[i]
    queue[tail++] = i
  }
  while (head < tail) {
    const i = queue[head++]
    const floor = floorOf[i]
    const x = i % w
    const y = (i - x) / w
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = (x + dx + w) % w
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + nx
      if (salt[ni] || mask[ni] < threshold || (lakes && lakes[ni]) || (ice && ice[ni])) continue
      if (summerMoist[ni] >= SALT_SUMMER_MOIST) continue
      if (elev[ni] < floor - 2 || elev[ni] > floor + PLAYA_ABOVE_M) continue
      if (!drainsInward(elev, salt, mask, ni, w, h, threshold)) continue
      salt[ni] = 1
      floorOf[ni] = floor
      if (elev[ni] > floor) elev[ni] = floor
      queue[tail++] = ni
    }
  }
  return { salt, elev }
}

export interface AgedContinent {
  salt: Uint8Array
  sites: Uint8Array
  elev: Float32Array
}

/**
 * Age a grounded continent. Salt spreads only across a dry floor that
 * drains into the pit. Slots drop a few metres. Terraces rise a few metres
 * and stay below the spring. The mask is not an argument and is not returned.
 */
export function ageContinent(input: AgeLandInput): AgedContinent {
  const grown = growPlaya(input)
  const sites = ageLand({ ...input, salt: grown.salt, elev: grown.elev })
  const elev = grown.elev
  const { width: w, height: h } = input
  for (let i = 0; i < sites.length; i++) {
    if (sites[i] !== SITE_SLOT) continue
    const x = i % w
    const y = (i - x) / w
    let wall = elev[i]
    for (const dy of [-1, 1]) {
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      wall = Math.min(wall, elev[ny * w + x])
    }
    const next = elev[i] - SLOT_DROP_M
    if (next < wall - 400) continue
    elev[i] = next
  }
  for (let i = 0; i < sites.length; i++) {
    if (sites[i] !== SITE_SPRING) continue
    const spring = elev[i]
    const x = i % w
    const y = (i - x) / w
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = (x + dx + w) % w
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const j = ny * w + nx
      if (sites[j] !== SITE_TERRACE) continue
      const raised = elev[j] + TERRACE_RISE_M
      if (raised < spring - 2) elev[j] = raised
    }
  }
  return { salt: grown.salt, sites, elev }
}
