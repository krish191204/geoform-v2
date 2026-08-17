// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  critiqueMask,
  critiqueWorld,
  setPriorMask,
  clearPriorMask,
  SEVERITY_WEIGHTS,
  scoreFromIssues,
  sortIssuesBySeverity,
} from './main'
import {
  checkIceDesertDualism,
  checkFluxOnMaxima,
  checkMaskLock,
  computeCoastDistance,
} from './analyzeWorld'
import type { World, WorldMeta, Issue, CellBiome } from '../world/types'
import { DEFAULT_META, idx } from '../world/types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMeta(overrides: Partial<WorldMeta> = {}): WorldMeta {
  return { ...DEFAULT_META, width: 32, height: 16, seed: 1, threshold: 0.5, ...overrides }
}

function makeMask(width: number, height: number, fill = 0): Float32Array {
  return Float32Array.from({ length: width * height }, () => fill)
}

function mkIssue(severity: Issue['severity']): Issue {
  return {
    id: `synthetic-${severity}`,
    severity,
    title: `Synthetic ${severity}`,
    critique: 'Synthetic.',
    fix: 'Synthetic.',
    evidence: [],
  }
}

function makeWorld(overrides: Partial<World> = {}): World {
  const meta = makeMeta(overrides.meta ?? {})
  const w = meta.width
  const h = meta.height
  const n = w * h
  const elev = new Float32Array(n)
  for (let i = 0; i < n; i++) elev[i] = 10 + (i % 13) * 100 // strictly above seaLevel
  const tempMean = new Float32Array(n)
  for (let i = 0; i < n; i++) tempMean[i] = 10
  const moistMean = new Float32Array(n)
  for (let i = 0; i < n; i++) moistMean[i] = 0.5
  const biome: CellBiome[] = new Array(n).fill('ocean' as CellBiome)
  return {
    meta,
    mask: overrides.mask ?? makeMask(w, h, 0.7),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: overrides.elev ?? elev,
    seasons: 2 as const,
    summer: overrides.summer ?? new Float32Array(n),
    winter: overrides.winter ?? new Float32Array(n),
    summerMoist: overrides.summerMoist ?? new Float32Array(n),
    winterMoist: overrides.winterMoist ?? new Float32Array(n),
    tempMean: overrides.tempMean ?? tempMean,
    tempRange: overrides.tempRange ?? new Float32Array(n),
    moistMean: overrides.moistMean ?? moistMean,
    flux: overrides.flux ?? new Float32Array(n),
    rivers: overrides.rivers ?? new Uint8Array(n),
    biome: overrides.biome ?? biome,
    suitability: overrides.suitability ?? new Float32Array(n),
    cities: overrides.cities ?? [],
  }
}

// ---------------------------------------------------------------------------
// Score: direct unit tests on scoreFromIssues / sortIssuesBySeverity.
// ---------------------------------------------------------------------------

describe('scoreFromIssues', () => {
  it('returns 100 for zero issues (no flattery floor)', () => {
    expect(scoreFromIssues([])).toBe(100)
  })
  it('caps one critical at <= 75', () => {
    const s = scoreFromIssues([mkIssue('critical')])
    expect(s).toBe(75)
    expect(s).toBeLessThanOrEqual(75)
  })
  it('caps one major at <= 90', () => {
    const s = scoreFromIssues([mkIssue('major')])
    expect(s).toBe(90)
    expect(s).toBeLessThanOrEqual(90)
  })
  it('caps one minor at <= 98', () => {
    const s = scoreFromIssues([mkIssue('minor')])
    expect(s).toBe(98)
    expect(s).toBeLessThanOrEqual(98)
  })
  it('does not promise 90 to a 64x32 world with one critical', () => {
    // A tiny world with one critical bug should NOT score 90.
    const s = scoreFromIssues([mkIssue('critical')])
    expect(s).toBeLessThan(90)
  })
  it('does not promise 70 to a world with ten bugs', () => {
    const s = scoreFromIssues([
      mkIssue('critical'),
      mkIssue('critical'),
      mkIssue('critical'),
      mkIssue('critical'),
      mkIssue('major'),
      mkIssue('major'),
      mkIssue('major'),
      mkIssue('minor'),
      mkIssue('minor'),
      mkIssue('minor'),
    ])
    expect(s).toBeLessThan(70)
  })
  it('clamps to 0', () => {
    const many = Array.from({ length: 5 }, () => mkIssue('critical'))
    const s = scoreFromIssues(many)
    expect(s).toBe(0)
  })
  it('uses the documented severity weights', () => {
    expect(SEVERITY_WEIGHTS.critical).toBe(25)
    expect(SEVERITY_WEIGHTS.major).toBe(10)
    expect(SEVERITY_WEIGHTS.minor).toBe(2)
  })
})

describe('sortIssuesBySeverity', () => {
  it('puts critical first, then major, then minor', () => {
    const sorted = sortIssuesBySeverity([
      mkIssue('minor'),
      mkIssue('critical'),
      mkIssue('major'),
    ])
    expect(sorted.map((i) => i.severity)).toEqual(['critical', 'major', 'minor'])
  })
  it('preserves order within the same severity (stable)', () => {
    const a = { ...mkIssue('major'), id: 'a' }
    const b = { ...mkIssue('major'), id: 'b' }
    const c = { ...mkIssue('minor'), id: 'c' }
    const sorted = sortIssuesBySeverity([a, b, c])
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('does not mutate input', () => {
    const list = [mkIssue('minor'), mkIssue('critical')]
    const before = [...list]
    sortIssuesBySeverity(list)
    expect(list).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// critiqueMask: pre-Make-sense, runs on mask only.
// ---------------------------------------------------------------------------

describe('critiqueMask', () => {
  beforeEach(() => clearPriorMask())

  it('reports pre = true and runs on mask only', () => {
    const result = critiqueMask(makeMask(64, 32, 0), makeMeta({ width: 64, height: 32 }), 0.5)
    expect(result.pre).toBe(true)
    // Empty mask → land% = 0 → critical "mostly ocean".
    expect(result.issues.length).toBeGreaterThanOrEqual(1)
    expect(result.issues.some((i) => i.id === 'too-little-land')).toBe(true)
  })

  it('flags a near-empty land mask as critical "too little land"', () => {
    const mask = makeMask(64, 32)
    mask[100] = 0.8 // single land cell among 2048
    const r = critiqueMask(mask, makeMeta({ width: 64, height: 32 }), 0.5)
    expect(r.issues.some((i) => i.id === 'too-little-land' && i.severity === 'critical')).toBe(true)
  })

  it('flags a fully-land mask as critical "too much land"', () => {
    const mask = makeMask(64, 32, 1)
    const r = critiqueMask(mask, makeMeta({ width: 64, height: 32 }), 0.5)
    expect(r.issues.some((i) => i.id === 'too-much-land' && i.severity === 'critical')).toBe(true)
  })

  it('flags too many speckle islands (bigComponents > 8) as major', () => {
    // Build 10 distinct 100x1 land blobs to force bigComponentsCount > 8.
    const w = 256
    const h = 32
    const mask = makeMask(w, h)
    for (let i = 0; i < 10; i++) {
      const cx = 10 + i * 16
      for (let dx = 0; dx < 14; dx++) {
        for (let dy = 0; dy < 8; dy++) {
          mask[(5 + dy) * w + (cx + dx)] = 0.9
        }
      }
    }
    const r = critiqueMask(mask, makeMeta({ width: w, height: h }), 0.5)
    const speckle = r.issues.find((i) => i.id === 'too-many-speckles')
    expect(speckle).toBeDefined()
    expect(speckle?.severity).toBe('major')
  })

  it('flags a fully-land polar strip as major', () => {
    const w = 64
    const h = 32
    const mask = makeMask(w, h)
    // Polar lanes (y=0,1,2,3) all land; rest is ocean.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < w; x++) {
        mask[y * w + x] = 0.9
      }
    }
    const r = critiqueMask(mask, makeMeta({ width: w, height: h }), 0.5)
    expect(r.issues.some((i) => i.id === 'polar-strip' && i.severity === 'major')).toBe(true)
  })

  it('does not give 100 to a stamped rectangle', () => {
    const w = 64
    const h = 32
    const mask = makeMask(w, h)
    for (let y = 8; y < 24; y++) {
      for (let x = 20; x < 44; x++) {
        mask[y * w + x] = 0.9
      }
    }
    const r = critiqueMask(mask, makeMeta({ width: w, height: h }), 0.5)
    expect(r.issues.some((i) => i.id === 'box-continent')).toBe(true)
    expect(r.issues.some((i) => i.id === 'not-a-planet-yet')).toBe(true)
    expect(r.score).toBeLessThanOrEqual(40)
  })

  it('flags inland paint holes', () => {
    const w = 48
    const h = 24
    const mask = makeMask(w, h)
    for (let y = 6; y <= 17; y++) {
      for (let x = 10; x <= 30; x++) {
        mask[y * w + x] = 0.9
      }
    }
    for (let y = 9; y <= 14; y++) {
      for (let x = 16; x <= 24; x++) {
        mask[y * w + x] = 0
      }
    }
    const r = critiqueMask(mask, makeMeta({ width: w, height: h }), 0.5)
    expect(r.issues.some((i) => i.id === 'paint-holes')).toBe(true)
    expect(r.score).toBeLessThan(90)
  })

  it('never scores a mid-range doodle as a finished planet', () => {
    const w = 64
    const h = 32
    const mask = makeMask(w, h)
    for (let y = 6; y < 26; y++) {
      for (let x = 8; x < 28; x++) {
        if (((x + y) & 1) === 0) mask[y * w + x] = 0.9
      }
    }
    const r = critiqueMask(mask, makeMeta({ width: w, height: h }), 0.5)
    expect(r.score).toBeLessThan(40)
    expect(r.issues.length).toBeGreaterThan(0)
    expect(r.issues.some((i) => i.id === 'not-a-planet-yet' && i.severity === 'critical')).toBe(
      true,
    )
  })

  it('fails a smiley face — that is a cartoon, not a B-minus planet', () => {
    const w = 64
    const h = 32
    const mask = makeMask(w, h)
    const stampDisc = (cx: number, cy: number, r: number) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) mask[y * w + x] = 0.9
        }
      }
    }
    stampDisc(22, 12, 3)
    stampDisc(42, 12, 3)
    for (let x = 16; x <= 48; x++) {
      const t = (x - 16) / 32
      const y = Math.round(22 + 6 * Math.sin(t * Math.PI))
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy >= 0 && yy < h) mask[yy * w + x] = 0.9
      }
    }
    const r = critiqueMask(mask, makeMeta({ width: w, height: h }), 0.5)
    expect(r.score).toBeLessThanOrEqual(20)
    expect(r.issues.some((i) => i.id === 'not-a-planet-yet')).toBe(true)
  })

  it('orders its issues critical-first', () => {
    // Force two critical (too little land AND any other rule on a mostly-ocean mask)
    // and zero majors — sort should put criticals at index 0.
    const mask = makeMask(64, 32, 0)
    const r = critiqueMask(mask, makeMeta({ width: 64, height: 32 }), 0.5)
    expect(r.issues[0].severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// critiqueWorld: post-Make-sense, runs on World. Each check has its own
// evidence-cell test.
// ---------------------------------------------------------------------------

describe('critiqueWorld', () => {
  beforeEach(() => clearPriorMask())

  it('reports pre = false', () => {
    const w = makeWorld()
    const r = critiqueWorld(w)
    expect(r.pre).toBe(false)
  })

  it('runs on full World (uses temp/moist/elev/flux)', () => {
    const w = makeWorld()
    // No violations expected from defaults.
    const r = critiqueWorld(w)
    expect(r.score).toBe(100)
    expect(r.issues).toEqual([])
  })

  it('flags ice-vs-tropical-desert as critical and lists the offending cells', () => {
    const w = makeWorld()
    w.tempMean[idx(32, 5, 5)] = -10 // ice cell
    w.moistMean[idx(32, 6, 5)] = 0.05
    w.tempMean[idx(32, 6, 5)] = 35 // hot-arid desert next door
    const r = critiqueWorld(w)
    const ice = r.issues.find((i) => i.id === 'ice-desert-dualism')
    expect(ice).toBeDefined()
    expect(ice?.severity).toBe('critical')
    // Evidence must contain the offending pair.
    const has = (x: number, y: number) =>
      ice!.evidence.some((e) => e.x === x && e.y === y)
    expect(has(5, 5)).toBe(true)
    expect(has(6, 5)).toBe(true)
    // Score capped at 75.
    expect(r.score).toBeLessThanOrEqual(75)
  })

  it('flags flux on local maxima as critical', () => {
    const w = makeWorld()
    const w_ = w.meta.width
    const cx = 10
    const cy = 8
    const i = idx(w_, cx, cy)
    // make this cell strictly higher than all 8 neighbours.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = (cx + dx + w_) % w_
        const ny = cy + dy
        w.elev[ny * w_ + nx] = 0
        w.elev[i] = 1000
      }
    }
    w.flux[i] = 5 // flux on the local max
    const r = critiqueWorld(w)
    const peak = r.issues.find((i) => i.id === 'flux-on-maxima')
    expect(peak).toBeDefined()
    expect(peak?.severity).toBe('critical')
    expect(peak!.evidence.some((e) => e.x === cx && e.y === cy)).toBe(true)
  })

  it('flags missing continentality as major', () => {
    // The check requires coastDist > 50 (real interior). The default
    // 32×16 fixture is too small — max coastDist ~13. Build a wide
    // continent with NO top/bottom ocean strips so coastDist grows with
    // the x dimension (max ~98 on a 200-wide grid).
    const w = makeWorld({ meta: makeMeta({ width: 200, height: 16 }) })
    const w_ = w.meta.width
    const h = w.meta.height
    // Ocean strips on the LEFT and RIGHT only.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w_; x++) {
        const k = y * w_ + x
        const isOcean = x < 3 || x >= w_ - 3
        w.elev[k] = isOcean ? -10 : 100
        w.tempRange[k] = isOcean ? 5 : 5 // flat — continentality missing
      }
    }
    const r = critiqueWorld(w)
    const inland = r.issues.find((i) => i.id === 'no-continentality')
    expect(inland).toBeDefined()
    expect(inland?.severity).toBe('major')
  })

  it('flags flipped rain shadow as minor', () => {
    // Build a clean single mountain with west-wind. Windward slice (x-4..x-1)
    // is dry; lee slice (x+1..x+4) is wet. The west-east-dry-west layout is
    // the classic flipped-rain-shadow.
    const w = makeWorld()
    const w_ = w.meta.width
    const cy = 10
    for (let dx = -10; dx <= 10; dx++) {
      const x = 16 + dx
      const k = cy * w_ + ((x + w_) % w_)
      // Mountain profile.
      const profile = Math.max(0, 400 - Math.abs(dx) * 30)
      // Set wall of land to hold the moisture field in place.
      w.elev[k] = profile > 0 ? profile : 50
    }
    // Windward slice (x=12..15) — DRY.
    for (const x of [12, 13, 14, 15]) {
      w.moistMean[cy * w_ + x] = 0.05
    }
    // Lee slice (x=17..20) — WET.
    for (const x of [17, 18, 19, 20]) {
      w.moistMean[cy * w_ + x] = 0.95
    }
    const r = critiqueWorld(w)
    const shadow = r.issues.find((i) => i.id === 'rain-shadow-flipped')
    expect(shadow).toBeDefined()
    expect(shadow?.severity).toBe('minor')
  })

  it('flags mask drift (post bigComponents > 5% off pre) as critical', () => {
    setPriorMask(makeMask(64, 32, 0), makeMeta({ width: 64, height: 32 }))
    // Build a derived world with 6 distinct, ≥100-cell land blobs.
    const w = makeWorld({ meta: makeMeta({ width: 64, height: 32 }) })
    const blobs = [
      [4, 4, 12, 10],
      [20, 4, 12, 10],
      [36, 4, 12, 10],
      [52, 4, 8, 10],
      [12, 18, 12, 10],
      [44, 18, 12, 10],
    ] as const
    for (const [x0, y0, dx, dy] of blobs) {
      for (let yy = 0; yy < dy; yy++) {
        for (let xx = 0; xx < dx; xx++) {
          const k = (y0 + yy) * 64 + (x0 + xx)
          w.elev[k] = 200
        }
      }
    }
    const r = critiqueWorld(w)
    const lock = r.issues.find((i) => i.id === 'mask-drift')
    expect(lock).toBeDefined()
    expect(lock?.severity).toBe('critical')
  })

  it('issue ordering puts critical first when a critical and a major coexist', () => {
    // Critical: flux-on-maxima. Major: no-continentality (set up a wide
    // continent, more than 50 cells deep from any coast). The check uses
    // coastDist > 50 for "real interior", so the world has to be wide
    // enough along at least one axis — top/bottom ocean strips would cap
    // coastDist at ~14 in y, never tripping the major.
    const w = makeWorld({ meta: makeMeta({ width: 256, height: 16 }) })
    const w_ = w.meta.width
    const h = w.meta.height
    // Ocean strips on the LEFT and RIGHT only.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w_; x++) {
        const k = y * w_ + x
        const isOcean = x < 4 || x >= w_ - 4
        w.elev[k] = isOcean ? -10 : 100
        w.tempRange[k] = isOcean ? 5 : 5 // flat inland → no continentality
      }
    }
    // Local max with flux near the centre.
    const peakX = 128
    const peakY = 8
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) {
          w.elev[(peakY + dy) * w_ + ((peakX + dx) % w_)] = 5000
          w.flux[(peakY + dy) * w_ + ((peakX + dx) % w_)] = 9
          continue
        }
        const nx = (peakX + dx + w_) % w_
        const ny = peakY + dy
        w.elev[ny * w_ + nx] = 0
      }
    }
    const r = critiqueWorld(w)
    const hasCritical = r.issues.some((i) => i.severity === 'critical')
    const hasMajor = r.issues.some((i) => i.severity === 'major')
    expect(hasCritical).toBe(true)
    expect(hasMajor).toBe(true)
    expect(r.issues[0].severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// Direct unit tests on the per-check helpers — cover the helpers
// independently from the orchestrator.
// ---------------------------------------------------------------------------

describe('check helpers', () => {
  it('checkFluxOnMaxima returns no issue when no cell is a strict local max', () => {
    const w = makeWorld()
    const issues = checkFluxOnMaxima(w)
    // Default world has gentle slopes; no strict local maxes carry flux.
    expect(issues).toEqual([])
  })

  it('checkIceDesertDualism returns no issue for sane temperatures', () => {
    const w = makeWorld()
    const issues = checkIceDesertDualism(w)
    expect(issues).toEqual([])
  })

  it('checkMaskLock returns no issue when the world matches its mask', () => {
    // Build a coherent prior mask and a world derived from it.
    const w = 32
    const h = 16
    const prior = makeMask(w, h)
    for (let y = 4; y < 12; y++) {
      for (let x = 8; x < 24; x++) prior[y * w + x] = 0.9
    }
    const world = makeWorld({ meta: makeMeta({ width: w, height: h }) })
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x
        world.elev[k] = prior[k] >= 0.5 ? 200 : -50
      }
    }
    setPriorMask(prior, makeMeta({ width: w, height: h }))
    const issues = checkMaskLock(prior, world, 0.5)
    expect(issues).toEqual([])
  })

  it('checkMaskLock returns a critical issue when the world added continents', () => {
    const w = 32
    const h = 16
    const prior = makeMask(w, h) // empty mask, pre=0 land components
    const world = makeWorld({ meta: makeMeta({ width: w, height: h }) })
    for (let i = 0; i < w * h; i++) world.elev[i] = 200 // all land
    const issues = checkMaskLock(prior, world, 0.5)
    expect(issues.length).toBe(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('computeCoastDistance assigns distance 1 to coastal cells', () => {
    const w = 16
    const h = 8
    const elev = new Float32Array(w * h)
    // Row 4 is land; rows 3 and 5 are ocean.
    for (let x = 0; x < w; x++) {
      elev[4 * w + x] = 100
    }
    const world = makeWorld({ meta: makeMeta({ width: w, height: h }) })
    world.elev = elev
    const dist = computeCoastDistance(world)
    // The cells in row 4 are coastal — their distance should be 1.
    for (let x = 0; x < w; x++) {
      expect(dist[4 * w + x]).toBe(1)
    }
  })
})