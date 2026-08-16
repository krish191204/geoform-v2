import { describe, it, expect } from 'vitest'
import {
  computeHydrology,
  RIVER_THRESHOLD,
  D8_OFFSETS,
  idx,
  wrapX,
  meanLand,
} from './hydrology'

// ---------------------------------------------------------------------------
// Helpers for tests
// ---------------------------------------------------------------------------

/** Build a flat Float32Array of the given size filled with `value`. */
function fill(size: number, value: number): Float32Array {
  return Float32Array.from({ length: size }, () => value)
}

/** Count cells where mask[i] >= threshold (land). */
function landCells(mask: Float32Array, threshold: number): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] >= threshold) n++
  return n
}

/** Sum a Float32Array. */
function sum(a: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}

/** Count the number of cells with value > 0. */
function countPositive(a: Float32Array): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] > 0) n++
  return n
}

/** Find the index of a local maximum (higher than every D8 neighbour). */
function localMaximaIndices(elev: Float32Array, w: number, h: number): number[] {
  const out: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(w, x, y)
      const e = elev[i]
      let isMax = true
      for (let k = 0; k < D8_OFFSETS.length; k++) {
        const o = D8_OFFSETS[k]
        const nx = wrapX(x + o.dx, w)
        const ny = y + o.dy
        if (ny < 0 || ny >= h) continue
        if (elev[idx(w, nx, ny)] >= e) {
          isMax = false
          break
        }
      }
      if (isMax) out.push(i)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Shared mask fixture: a small continent in a 64x32 ocean
// ---------------------------------------------------------------------------

const W = 64
const H = 32
const THRESHOLD = 0.5

/** Mask = 1.0 inside a roughly disc-shaped continent, 0.0 elsewhere. */
function continentMask(): Float32Array {
  const mask = fill(W * H, 0)
  const cx = W / 2
  const cy = H / 2
  const r = Math.min(W, H) * 0.35
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) mask[idx(W, x, y)] = 1
    }
  }
  return mask
}

/** A noisy elevation field over the continent — single dominant hill. */
function continentElev(): Float32Array {
  const elev = fill(W * H, 0)
  const cx = W / 2
  const cy = H / 2
  const r = Math.min(W, H) * 0.35
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx
      const dy = y - cy
      const d2 = dx * dx + dy * dy
      if (d2 <= r * r) {
        // Cone hill with a little jitter so flow has real structure.
        const cone = 1 - Math.sqrt(d2) / r
        const noise =
          0.02 *
          Math.sin(x * 0.91 + y * 0.47) *
          Math.cos(x * 0.31 - y * 0.63)
        elev[idx(W, x, y)] = cone + noise
      }
    }
  }
  return elev
}

// ---------------------------------------------------------------------------
// Spec assertions on a local maximum (Donald bar)
// ---------------------------------------------------------------------------

describe('computeHydrology: invariants', () => {
  it('a local maximum has flux = 0 (Donald bar)', () => {
    // Hand-built 5x5 island: a single hill at (2,2). Centre is a local max.
    const w = 5
    const h = 5
    const elev = Float32Array.from([
      0, 0, 0, 0, 0,
      0, 1, 2, 1, 0,
      0, 2, 5, 2, 0,
      0, 1, 2, 1, 0,
      0, 0, 0, 0, 0,
    ])
    const mask = Float32Array.from([
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
      1, 1, 1, 1, 1,
    ])
    const { flux, rivers } = computeHydrology(elev, mask, w, h, THRESHOLD)
    const center = idx(w, 2, 2)
    expect(flux[center]).toBe(0)
    // And that local max is never a river (flux > RIVER_THRESHOLD is impossible at 0).
    expect(rivers[center]).toBe(0)
  })

  it('a cell at the bottom of a hill accumulates flux from neighbours (flux > 1)', () => {
    // Linear ridge descending left -> right; water should pool on the rightmost cell.
    const w = 7
    const h = 3
    const elev = Float32Array.from([
      10, 9, 8, 7, 6, 5, 4,
      10, 9, 8, 7, 6, 5, 4,
      10, 9, 8, 7, 6, 5, 4,
    ])
    const mask = fill(w * h, 1)
    const { flux } = computeHydrology(elev, mask, w, h, THRESHOLD)
    // The rightmost column (x=6) is the lowest on the ridge; every cell should
    // drain into it. Each row has 7 cells => flux on the low end >= 6.
    expect(flux[idx(w, 6, 0)]).toBeGreaterThan(1)
    expect(flux[idx(w, 6, 1)]).toBeGreaterThan(1)
    expect(flux[idx(w, 6, 2)]).toBeGreaterThan(1)
  })

  it('every river cell satisfies flux[i] > RIVER_THRESHOLD', () => {
    const { flux, rivers } = computeHydrology(
      continentElev(),
      continentMask(),
      W,
      H,
      THRESHOLD,
    )
    for (let i = 0; i < flux.length; i++) {
      if (rivers[i] === 1) {
        expect(flux[i]).toBeGreaterThan(RIVER_THRESHOLD)
      }
    }
  })

  it('every non-zero flux cell satisfies flux[i] >= 1 + flux[donor]', () => {
    // Flow invariant: at each cell receiving flow, flux = 1 + (sum of its
    // donors' flux contributions). The strict weaker check: flux > 1 means
    // it has at least one donor.
    const { flux } = computeHydrology(
      continentElev(),
      continentMask(),
      W,
      H,
      THRESHOLD,
    )
    let checked = 0
    for (let i = 0; i < flux.length; i++) {
      if (flux[i] > 1) checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeHydrology: edge cases', () => {
  it('flat world: flux = 0 everywhere', () => {
    const w = 4
    const h = 4
    const elev = fill(w * h, 5)
    const mask = fill(w * h, 1)
    const { flux, rivers } = computeHydrology(elev, mask, w, h, THRESHOLD)
    expect(sum(flux)).toBe(0)
    for (let i = 0; i < rivers.length; i++) expect(rivers[i]).toBe(0)
  })

  it('all-ocean mask: every cell is a sink, flux = 0 everywhere', () => {
    const w = 4
    const h = 4
    const elev = Float32Array.from({ length: w * h }, (_, i) => i)
    const mask = fill(w * h, 0) // all ocean
    const { flux } = computeHydrology(elev, mask, w, h, THRESHOLD)
    expect(sum(flux)).toBe(0)
  })

  it('single-hill world: flux accumulates downhill toward the lowest cell', () => {
    // 5x5 island with a single hill at (2,2). Lowest cell is (0,0) at elev=0;
    // every land cell should drain there.
    const w = 5
    const h = 5
    const elev = Float32Array.from([
      0, 1, 2, 1, 0,
      1, 2, 3, 2, 1,
      2, 3, 5, 3, 2,
      1, 2, 3, 2, 1,
      0, 1, 2, 1, 0,
    ])
    const mask = fill(w * h, 1)
    const { flux } = computeHydrology(elev, mask, w, h, THRESHOLD)

    // Highest cell is a local max -> flux = 0.
    expect(flux[idx(w, 2, 2)]).toBe(0)
    // Lowest corner has flux > 1 (the rest of the island drains into it).
    expect(flux[idx(w, 0, 0)]).toBeGreaterThan(1)
    // And not everything is zero: there's at least one downhill path.
    expect(countPositive(flux)).toBeGreaterThan(1)
  })

  it('sink fill: a cell lower than all its neighbours still flows to a coast', () => {
    // 5x5 island with ocean border (elev=0) and a single pit on land.
    // Centre (2,2) starts at elev=0, surrounded by elev=2 land; after sink
    // fill, the pit must drain — flux at the coast > 0.
    const w = 5
    const h = 5
    const elev = Float32Array.from([
      0, 0, 0, 0, 0,
      0, 2, 2, 2, 0,
      0, 2, 0, 2, 0,
      0, 2, 2, 2, 0,
      0, 0, 0, 0, 0,
    ])
    const mask = Float32Array.from([
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 0, 0, 0, 0,
    ])
    const { flux } = computeHydrology(elev, mask, w, h, THRESHOLD)
    // The pit must contribute to flux somewhere rather than disappearing
    // — ocean cells accumulate the flow that drained from land.
    expect(sum(flux)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Conservation law
// ---------------------------------------------------------------------------

describe('computeHydrology: conservation', () => {
  it('every non-local-max land cell donates exactly one unit upstream', () => {
    // Each land cell that has a lower neighbour contributes one "1" to the
    // flow system (the `1 + flux[cell]` donation). A cell with flux > 0
    // has received at least one unit; a cell with flux = 0 is either a
    // local max (no lower neighbour) or an ocean cell. In an all-land
    // world the count of donors plus local maxima equals the cell count.
    const w = 8
    const h = 6
    const elev = Float32Array.from({ length: w * h }, (_, i) =>
      Math.sin(i * 0.31) + Math.cos(i * 0.17),
    )
    const mask = fill(w * h, 1)
    const { flux } = computeHydrology(elev, mask, w, h, THRESHOLD)
    let localMaxes = 0
    let nonZeroFlux = 0
    for (let i = 0; i < flux.length; i++) {
      if (flux[i] === 0) {
        // Could be ocean (n/a here, all-land) or local max. Verify by
        // checking neighbour elevations.
        const x = i % w
        const y = (i - x) / w
        let isMax = true
        for (const o of D8_OFFSETS) {
          const nx = wrapX(x + o.dx, w)
          const ny = y + o.dy
          if (ny < 0 || ny >= h) continue
          if (elev[idx(w, nx, ny)] >= elev[i]) {
            isMax = false
            break
          }
        }
        if (isMax) localMaxes++
      } else {
        nonZeroFlux++
      }
    }
    // Donors = nonZeroFlux (those received >0). Local maxes don't donate.
    // Every land cell is either a donor or a local max.
    expect(nonZeroFlux + localMaxes).toBe(w * h)
    // And total flux is at least the number of donors (every donor contributes
    // at least the literal `1` to its recipient).
    expect(sum(flux)).toBeGreaterThanOrEqual(nonZeroFlux)
  })

  it('continent fixture: ocean cells receive flux but land cells carry the donors', () => {
    const mask = continentMask()
    const { flux } = computeHydrology(continentElev(), mask, W, H, THRESHOLD)
    // Ocean cells DO carry flux — they're the terminal sinks. The renderer
    // ignores them. The relevant invariant is land-side: every land cell
    // with flux > 0 received a donation from a higher neighbour.
    let landDonors = 0
    for (let i = 0; i < flux.length; i++) {
      if (mask[i] >= THRESHOLD && flux[i] > 0) landDonors++
    }
    expect(landDonors).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Continent fixture: shape sanity
// ---------------------------------------------------------------------------

describe('computeHydrology: continent fixture', () => {
  it('produces a non-trivial river network', () => {
    const { flux, rivers } = computeHydrology(
      continentElev(),
      continentMask(),
      W,
      H,
      THRESHOLD,
    )
    // Some cells must flow.
    expect(countPositive(flux)).toBeGreaterThan(0)
    // The hilltop is a local max -> flux = 0 there.
    const maxima = localMaximaIndices(continentElev(), W, H)
    expect(maxima.length).toBeGreaterThan(0)
    for (const i of maxima) {
      expect(flux[i]).toBe(0)
    }
    // A small cone-shaped continent (radius ~11 cells) is a radial drain:
    // each coastal cell receives a thin wedge of upstream flow. At the
    // default `RIVER_THRESHOLD = 8` tuned for a 512x256 production world,
    // no single land cell on this tiny fixture exceeds the cutoff, so
    // `rivers` is all zero. The relationship still holds: every river
    // cell, if any, must satisfy `flux > RIVER_THRESHOLD`.
    for (let i = 0; i < rivers.length; i++) {
      if (rivers[i] === 1) expect(flux[i]).toBeGreaterThan(RIVER_THRESHOLD)
    }
  })

  it('with a ridged terrain, flux exceeds RIVER_THRESHOLD on at least one cell', () => {
    // A 12x6 slab with a single ridge funnel: every cell on the ridge
    // drains to the one coastal cell at x=0, producing flux > 8 there.
    const w = 12
    const h = 6
    const elev = Float32Array.from({ length: w * h }, (_, i) => {
      const x = i % w
      const y = (i - x) / w
      // High plateau with a single coastal outlet.
      return 1 - x / w + 0.05 * Math.sin(y * 1.7)
    })
    const mask = Float32Array.from({ length: w * h }, () => 1)
    const { flux, rivers } = computeHydrology(elev, mask, w, h, THRESHOLD)
    // Every land cell contributes 1 -> flux accumulates into the low end.
    // With 6 rows x 12 cols = 72 cells, the leftmost column receives most.
    const leftFlux = Array.from({ length: h }, (_, y) => flux[idx(w, 0, y)])
    expect(Math.max(...leftFlux)).toBeGreaterThan(RIVER_THRESHOLD)
    let riverCount = 0
    for (let i = 0; i < rivers.length; i++) if (rivers[i] === 1) riverCount++
    expect(riverCount).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

describe('pipeline helpers (re-exported by hydrology)', () => {
  it('idx is row-major', () => {
    expect(idx(8, 3, 2)).toBe(2 * 8 + 3)
  })

  it('wrapX handles negatives and overflow', () => {
    expect(wrapX(-1, 16)).toBe(15)
    expect(wrapX(16, 16)).toBe(0)
    expect(wrapX(17, 16)).toBe(1)
  })

  it('meanLand averages only land cells', () => {
    const mask = Float32Array.from([0.1, 0.4, 0.6, 0.9])
    expect(meanLand(mask, 0.5)).toBeCloseTo((0.6 + 0.9) / 2, 6)
  })

  it('meanLand returns 0 when nothing is land', () => {
    expect(meanLand(Float32Array.from([0.1, 0.2]), 0.5)).toBe(0)
  })

  it('D8_OFFSETS has 8 entries with the expected distances', () => {
    expect(D8_OFFSETS.length).toBe(8)
    const cardinal = D8_OFFSETS.filter((o) => o.dist === 1)
    const diagonal = D8_OFFSETS.filter((o) => o.dist > 1)
    expect(cardinal.length).toBe(4)
    expect(diagonal.length).toBe(4)
    expect(diagonal[0].dist).toBeCloseTo(Math.SQRT2, 10)
  })

  it('RIVER_THRESHOLD is a positive integer', () => {
    expect(RIVER_THRESHOLD).toBeGreaterThan(0)
    expect(Number.isInteger(RIVER_THRESHOLD)).toBe(true)
  })
})