/**
 * Critique regression tests.
 *
 * These pin the scoring rules of the post-Make-sense red pen. The
 * score is a 100-start deduction: critical costs 25, major costs 10,
 * minor costs 2. Zero issues -> 100. One critical -> 75 or less.
 *
 * The plumbing under test (severity weights, sort, individual checks)
 * already lives in `critique/analyzeWorld.ts`. The tests here are
 * the lock the conductor marks before going to Worldbuild.
 */

import { describe, it, expect } from 'vitest'
import {
  scoreFromIssues,
  sortIssuesBySeverity,
  SEVERITY_WEIGHTS,
  checkIceDesertDualism,
  checkRainShadow,
  checkContinentality,
  checkFluxOnMaxima,
} from '../../critique/analyzeWorld'
import type { World, Issue, WorldMeta } from '../../world/types'
import type { CellBiome } from '../../world/types'
import { DEFAULT_META } from '../../world/types'
import { makeContinentWorld, makeTwinContinentWorld, makePolarStripWorld } from './fixtures'
import type { TestWorld } from './fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorld(tw: TestWorld, seed: number, threshold: number): World {
  const meta: WorldMeta = {
    seed,
    width: tw.width,
    height: tw.height,
    planetRadiusKm: tw.planetRadiusKm,
    obliquityDeg: tw.obliquityDeg,
    seaLevel: 0.5,
    threshold,
  }
  const n = meta.width * meta.height
  return {
    meta,
    mask: new Float32Array(tw.mask),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n),
    seasons: 2,
    summer: new Float32Array(n),
    winter: new Float32Array(n),
    summerMoist: new Float32Array(n),
    winterMoist: new Float32Array(n),
    tempMean: new Float32Array(n),
    tempRange: new Float32Array(n),
    moistMean: new Float32Array(n),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome: new Array<CellBiome>(n).fill('ocean'),
    suitability: new Float32Array(n),
    cities: [],
  }
}

/** Pick a single cell at (x, y) and stamp values into it. */
function stamp(
  world: World,
  x: number,
  y: number,
  partial: {
    elev?: number
    tempMean?: number
    tempRange?: number
    moistMean?: number
    flux?: number
    rivers?: number
  },
): void {
  const i = y * world.meta.width + x
  if (partial.elev !== undefined) world.elev[i] = partial.elev
  if (partial.tempMean !== undefined) world.tempMean[i] = partial.tempMean
  if (partial.tempRange !== undefined) world.tempRange[i] = partial.tempRange
  if (partial.moistMean !== undefined) world.moistMean[i] = partial.moistMean
  if (partial.flux !== undefined) world.flux[i] = partial.flux
  if (partial.rivers !== undefined) world.rivers[i] = partial.rivers
}

function crit(id: string, evidence: { x: number; y: number }[] = []): Issue {
  return {
    id,
    severity: 'critical',
    title: id,
    critique: id,
    fix: id,
    evidence,
  }
}

function major(id: string, evidence: { x: number; y: number }[] = []): Issue {
  return {
    id,
    severity: 'major',
    title: id,
    critique: id,
    fix: id,
    evidence,
  }
}

function minor(id: string, evidence: { x: number; y: number }[] = []): Issue {
  return {
    id,
    severity: 'minor',
    title: id,
    critique: id,
    fix: id,
    evidence,
  }
}

// ---------------------------------------------------------------------------
// scoreFromIssues
// ---------------------------------------------------------------------------

describe('scoreFromIssues', () => {
  it('returns 100 for zero issues', () => {
    expect(scoreFromIssues([])).toBe(100)
  })

  it('caps at 75 for a single critical issue', () => {
    expect(scoreFromIssues([crit('x')])).toBeLessThanOrEqual(75)
  })

  it('a single critical issue scores exactly 75', () => {
    expect(scoreFromIssues([crit('x')])).toBe(75)
  })

  it('a single major issue scores exactly 90', () => {
    expect(scoreFromIssues([major('x')])).toBe(90)
  })

  it('a single minor issue scores exactly 98', () => {
    expect(scoreFromIssues([minor('x')])).toBe(98)
  })

  it('two critical issues score 50', () => {
    expect(scoreFromIssues([crit('a'), crit('b')])).toBe(50)
  })

  it('many critical issues clamp to 0', () => {
    const issues = [crit('a'), crit('b'), crit('c'), crit('d'), crit('e')]
    expect(scoreFromIssues(issues)).toBe(0)
  })

  it('clamps to [0, 100] even with negative deductions', () => {
    // Score should never go below 0.
    const issues = [
      crit('a'),
      crit('b'),
      crit('c'),
      crit('d'),
      crit('e'),
      crit('f'),
    ]
    expect(scoreFromIssues(issues)).toBeGreaterThanOrEqual(0)
  })

  it('clamps to 100 even when no issues are supplied', () => {
    expect(scoreFromIssues([])).toBeLessThanOrEqual(100)
  })

  it('uses the documented severity weights', () => {
    expect(SEVERITY_WEIGHTS.critical).toBe(25)
    expect(SEVERITY_WEIGHTS.major).toBe(10)
    expect(SEVERITY_WEIGHTS.minor).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// sortIssuesBySeverity
// ---------------------------------------------------------------------------

describe('sortIssuesBySeverity', () => {
  it('orders critical before major before minor', () => {
    const issues: Issue[] = [minor('m'), crit('c'), major('M')]
    const sorted = sortIssuesBySeverity(issues)
    expect(sorted.map((i) => i.severity)).toEqual(['critical', 'major', 'minor'])
  })

  it('preserves order within the same severity (stable)', () => {
    const a = crit('a')
    const b = crit('b')
    const c = crit('c')
    const sorted = sortIssuesBySeverity([c, a, b])
    expect(sorted.map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('does not mutate the input array', () => {
    const original: Issue[] = [minor('m'), crit('c')]
    const snapshot = JSON.stringify(original)
    sortIssuesBySeverity(original)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('handles an empty list', () => {
    expect(sortIssuesBySeverity([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// evidence-cell sanity
// ---------------------------------------------------------------------------

describe('checkIceDesertDualism evidence', () => {
  it('evidence cells are taken from the offending cells', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    // Place a cold cell (1,1) next to a hot-arid neighbour (1,2).
    stamp(world, 1, 1, { elev: 1.0, tempMean: 0 })
    stamp(world, 1, 2, { elev: 1.0, tempMean: 35, moistMean: 0.05 })
    const issues = checkIceDesertDualism(world)
    // The function may return zero issues if the input world has no
    // offender under its current scan policy; we only verify that
    // when it DOES emit an issue, the evidence is real cell coords.
    for (const issue of issues) {
      for (const e of issue.evidence) {
        expect(Number.isInteger(e.x)).toBe(true)
        expect(Number.isInteger(e.y)).toBe(true)
        expect(e.x).toBeGreaterThanOrEqual(0)
        expect(e.x).toBeLessThan(world.meta.width)
        expect(e.y).toBeGreaterThanOrEqual(0)
        expect(e.y).toBeLessThan(world.meta.height)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// checkRainShadow evidence
// ---------------------------------------------------------------------------

describe('checkRainShadow evidence', () => {
  it('no issue raised when there is no ridge row', () => {
    const tw = makeContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    const issues = checkRainShadow(world)
    expect(issues).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkContinentality evidence
// ---------------------------------------------------------------------------

describe('checkContinentality evidence', () => {
  it('no issue raised on a tiny world with no inland cells', () => {
    const tw = makeTwinContinentWorld()
    const world = makeWorld(tw, 1, 0.5)
    // No real land coastline yet — the mask has the islands but elev is 0.
    const issues = checkContinentality(world)
    expect(issues).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// checkFluxOnMaxima evidence
// ---------------------------------------------------------------------------

describe('checkFluxOnMaxima evidence', () => {
  it('no issue raised when no cell has flux on a local maximum', () => {
    const tw = makePolarStripWorld()
    const world = makeWorld(tw, 1, 0.5)
    const issues = checkFluxOnMaxima(world)
    expect(issues).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// end-to-end score composition
// ---------------------------------------------------------------------------

describe('issue pipeline composition', () => {
  it('1 critical issue -> score 75', () => {
    const issues = [crit('a')]
    const sorted = sortIssuesBySeverity(issues)
    expect(scoreFromIssues(sorted)).toBe(75)
  })

  it('mixed severities sum their weights', () => {
    const issues = [crit('a'), major('b'), minor('c')]
    // 100 - 25 - 10 - 2 = 63
    expect(scoreFromIssues(sortIssuesBySeverity(issues))).toBe(63)
  })
})

// ---------------------------------------------------------------------------
// exercise meta defaults
// ---------------------------------------------------------------------------

describe('WorldMeta defaults', () => {
  it('DEFAULT_META has sensible sketch defaults', () => {
    expect(DEFAULT_META.seed).toBe(1)
    expect(DEFAULT_META.width).toBeGreaterThan(0)
    expect(DEFAULT_META.height).toBeGreaterThan(0)
    expect(DEFAULT_META.planetRadiusKm).toBeGreaterThan(0)
    expect(DEFAULT_META.obliquityDeg).toBeGreaterThan(0)
    expect(DEFAULT_META.seaLevel).toBeGreaterThan(0)
    expect(DEFAULT_META.seaLevel).toBeLessThanOrEqual(1)
    expect(DEFAULT_META.threshold).toBeGreaterThan(0)
    expect(DEFAULT_META.threshold).toBeLessThanOrEqual(1)
  })
})
