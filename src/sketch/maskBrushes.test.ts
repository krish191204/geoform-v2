import { describe, it, expect, beforeEach } from 'vitest'
import { paintMask } from './paintMask'
import { clearSea } from './eraseMask'
import { countBigComponents, analyseComponents } from './countBigComponents'
import {
  createMaskBrushes,
  DEFAULT_MIN_BIG_AREA,
  maskAreaAbove,
  fireCommitHook,
} from './maskBrushes'
import type { WorldMeta } from '../world/types'
import { DEFAULT_META } from '../world/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMeta(overrides: Partial<WorldMeta> = {}): WorldMeta {
  return { ...DEFAULT_META, width: 32, height: 32, ...overrides }
}

function makeMask(width: number, height: number, fill = 0): Float32Array {
  return Float32Array.from({ length: width * height }, () => fill)
}

/** Sum the absolute values of a mask (cheap diagnostic). */
function totalAbs(mask: Float32Array): number {
  let s = 0
  for (let i = 0; i < mask.length; i++) s += Math.abs(mask[i])
  return s
}

// ---------------------------------------------------------------------------
// paintMask
// ---------------------------------------------------------------------------

describe('paintMask', () => {
  it('draw-land increases mask values within radius', () => {
    const mask = makeMask(10, 10)
    const before = totalAbs(mask)
    const result = paintMask(mask, 10, 10, 5, 5, 2, 1, 'draw-land')
    expect(result.mutatedCells).toBeGreaterThan(0)
    expect(totalAbs(mask)).toBeGreaterThan(before)

    // The center cell should now be close to 1 (full strength).
    const centerIdx = 5 * 10 + 5
    expect(mask[centerIdx]).toBeGreaterThan(0.9)
  })

  it('erase-land decreases mask values within radius', () => {
    const mask = makeMask(10, 10, 1)
    const before = totalAbs(mask)
    const result = paintMask(mask, 10, 10, 5, 5, 2, 1, 'erase-land')
    expect(result.mutatedCells).toBeGreaterThan(0)
    expect(totalAbs(mask)).toBeLessThan(before)

    // The center cell should now be close to 0.
    const centerIdx = 5 * 10 + 5
    expect(mask[centerIdx]).toBeLessThan(0.1)
  })

  it('clips centers to bounds (no out-of-range writes)', () => {
    const mask = makeMask(10, 10)
    // Paint with a brush centered outside the left edge.
    paintMask(mask, 10, 10, -3, 5, 2, 1, 'draw-land')
    // Only the cells whose intersection with the disc lands inside the
    // grid should have been written; nothing should have wrapped or
    // touched cells far away from (0, 5).
    const farIdx = 5 * 10 + 9
    expect(mask[farIdx]).toBe(0)
    // No NaNs, no negative indices.
    for (let i = 0; i < mask.length; i++) {
      expect(Number.isFinite(mask[i])).toBe(true)
      expect(mask[i]).toBeGreaterThanOrEqual(0)
      expect(mask[i]).toBeLessThanOrEqual(1)
    }
  })

  it('returns correct mutatedCells and maskDelta counts', () => {
    const mask = makeMask(20, 20)
    const r = paintMask(mask, 20, 20, 10, 10, 3, 0.5, 'draw-land')
    // maskDelta must equal the absolute sum of the writes.
    let recomputed = 0
    let recomputedCount = 0
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 0) {
        recomputed += mask[i]
        recomputedCount++
      }
    }
    expect(r.mutatedCells).toBe(recomputedCount)
    expect(r.maskDelta).toBeCloseTo(recomputed, 5)
  })

  it('returns zero mutations when strength is zero', () => {
    const mask = makeMask(10, 10)
    const r = paintMask(mask, 10, 10, 5, 5, 3, 0, 'draw-land')
    expect(r.mutatedCells).toBe(0)
    expect(r.maskDelta).toBe(0)
    expect(totalAbs(mask)).toBe(0)
  })

  it('caps the mask at 1 for draw-land', () => {
    const mask = makeMask(10, 10, 1)
    paintMask(mask, 10, 10, 5, 5, 3, 1, 'draw-land')
    for (let i = 0; i < mask.length; i++) {
      expect(mask[i]).toBeLessThanOrEqual(1)
    }
  })

  it('floors the mask at 0 for erase-land', () => {
    const mask = makeMask(10, 10, 0.5)
    paintMask(mask, 10, 10, 5, 5, 3, 1, 'erase-land')
    for (let i = 0; i < mask.length; i++) {
      expect(mask[i]).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------------------------------------------------------------------------
// clearSea
// ---------------------------------------------------------------------------

describe('clearSea', () => {
  it('zeros out cells below threshold', () => {
    const mask = Float32Array.from({ length: 16 }, (_, i) =>
      i < 8 ? 0.3 : 0.8,
    )
    const r = clearSea(mask, 0.5)
    expect(r.clearedCells).toBe(8)
    // Cells below threshold are now zero.
    for (let i = 0; i < 8; i++) expect(mask[i]).toBe(0)
    // Cells above threshold are untouched. Float32 storage rounds the
    // 0.8 literal to ~0.800000011920929; use `toBeCloseTo` to absorb the
    // precision drift rather than asserting bit-exact equality.
    for (let i = 8; i < 16; i++) expect(mask[i]).toBeCloseTo(0.8, 5)
  })

  it('returns clearedCells > 0 on a partially-set mask', () => {
    const mask = Float32Array.from({ length: 32 }, (_, i) =>
      i % 2 === 0 ? 0.1 : 0.9,
    )
    const r = clearSea(mask, 0.5)
    expect(r.clearedCells).toBeGreaterThan(0)
  })

  it('returns clearedCells = 0 when nothing is below threshold', () => {
    const mask = makeMask(4, 4, 1)
    const r = clearSea(mask, 0.5)
    expect(r.clearedCells).toBe(0)
  })

  it('flags the autopilot when more than half the grid was cleared', () => {
    const mask = makeMask(10, 10, 0.1)
    const r = clearSea(mask, 0.5)
    expect(r.autopilotTriggered).toBe(true)
    expect(r.clearedCells).toBe(100)
  })

  it('does not flag the autopilot when only a little was cleared', () => {
    const mask = Float32Array.from({ length: 100 }, (_, i) =>
      i < 5 ? 0.1 : 1.0,
    )
    const r = clearSea(mask, 0.5)
    expect(r.autopilotTriggered).toBe(false)
    expect(r.clearedCells).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// countBigComponents
// ---------------------------------------------------------------------------

describe('countBigComponents', () => {
  it('returns 1 for a single-cell mask above threshold', () => {
    const mask = makeMask(10, 10)
    mask[5 * 10 + 5] = 1
    // Use minBigArea = 1 so the single-cell component is counted.
    expect(countBigComponents(mask, 10, 10, 0.5, 1)).toBe(1)
  })

  it('returns 2 for two disjoint 5x5 blocks', () => {
    const mask = makeMask(20, 20)
    // Block A: rows 2..6, cols 2..6
    for (let y = 2; y <= 6; y++) {
      for (let x = 2; x <= 6; x++) {
        mask[y * 20 + x] = 1
      }
    }
    // Block B: rows 12..16, cols 12..16
    for (let y = 12; y <= 16; y++) {
      for (let x = 12; x <= 16; x++) {
        mask[y * 20 + x] = 1
      }
    }
    expect(countBigComponents(mask, 20, 20, 0.5, 10)).toBe(2)
  })

  it('ignores components below minBigArea', () => {
    const mask = makeMask(20, 20)
    // Tiny 2x2 block (area 4) and a big 6x6 block (area 36).
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        mask[y * 20 + x] = 1
      }
    }
    for (let y = 10; y < 16; y++) {
      for (let x = 10; x < 16; x++) {
        mask[y * 20 + x] = 1
      }
    }
    // minBigArea=10 drops the 2x2 patch.
    expect(countBigComponents(mask, 20, 20, 0.5, 10)).toBe(1)
    // minBigArea=1 counts both.
    expect(countBigComponents(mask, 20, 20, 0.5, 1)).toBe(2)
  })

  it('wraps around at the horizontal seam (longitude wraparound)', () => {
    const mask = makeMask(20, 20)
    // Place a cell in the leftmost column and another in the rightmost
    // column at the same row — they should be the same component when
    // the longitude wraps.
    mask[5 * 20 + 0] = 1
    mask[5 * 20 + 19] = 1
    // Plus the cells in between to make sure the wrap path is real.
    for (let x = 0; x < 20; x++) {
      mask[5 * 20 + x] = 1
    }
    expect(countBigComponents(mask, 20, 20, 0.5, 1)).toBe(1)
  })

  it('analyseComponents returns sorted areas', () => {
    const mask = makeMask(20, 20)
    // Component A: 5x5 at (1, 1) -> 25 cells
    for (let y = 1; y <= 5; y++) {
      for (let x = 1; x <= 5; x++) {
        mask[y * 20 + x] = 1
      }
    }
    // Component B: 3x3 at (10, 10) -> 9 cells
    for (let y = 10; y <= 12; y++) {
      for (let x = 10; x <= 12; x++) {
        mask[y * 20 + x] = 1
      }
    }
    const stats = analyseComponents(mask, 20, 20, 0.5, 1)
    expect(stats.bigComponents).toBe(2)
    expect(stats.areas[0]).toBeGreaterThanOrEqual(stats.areas[1])
    expect(Array.from(stats.areas)).toEqual([25, 9])
  })

  it('returns 0 for an empty mask', () => {
    const mask = makeMask(10, 10)
    expect(countBigComponents(mask, 10, 10, 0.5, 100)).toBe(0)
  })

  it('treats cells below threshold as ocean even when neighbours are land', () => {
    const mask = makeMask(10, 10)
    // Two cells separated by one ocean cell.
    mask[5 * 10 + 3] = 1
    mask[5 * 10 + 4] = 0.1 // below 0.5
    mask[5 * 10 + 5] = 1
    // They are different components because the gap is below threshold.
    expect(countBigComponents(mask, 10, 10, 0.5, 1)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// MaskBrushes (the public API)
// ---------------------------------------------------------------------------

describe('createMaskBrushes', () => {
  let meta: WorldMeta
  let mask: Float32Array

  beforeEach(() => {
    meta = makeMeta()
    mask = makeMask(meta.width, meta.height)
  })

  it('dab routes to paintMask and fires onBrushDab', () => {
    const { brushes, bindMask } = createMaskBrushes()
    const calls: { x: number; y: number; brushSize: number; maskDelta: number }[] = []
    brushes.onBrushDab = (e) => calls.push(e)
    bindMask(mask)

    const r = brushes.dab({
      mask,
      meta,
      cx: 10,
      cy: 10,
      brushSize: 4,
      strength: 0.8,
      tool: 'draw-land',
    })
    expect(r.mutatedCells).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ x: 10, y: 10, brushSize: 4 })
    expect(calls[0].maskDelta).toBeGreaterThan(0)
  })

  it('dab clamps brushSize into 1..64', () => {
    const { brushes } = createMaskBrushes()
    const r = brushes.dab({
      mask,
      meta,
      cx: 10,
      cy: 10,
      brushSize: 9999,
      strength: 0.5,
      tool: 'draw-land',
    })
    // With a giant brush, the entire 32x32 grid gets touched.
    expect(r.mutatedCells).toBe(meta.width * meta.height)

    const r2 = brushes.dab({
      mask,
      meta,
      cx: 10,
      cy: 10,
      brushSize: -5,
      strength: 0.5,
      tool: 'draw-land',
    })
    expect(r2.mutatedCells).toBeGreaterThan(0)
  })

  it('clearSea operates on the bound mask and respects the threshold', () => {
    const { brushes, bindMask } = createMaskBrushes()
    bindMask(mask)
    brushes.setThreshold(0.5)

    // Fill some cells below threshold, some above.
    for (let i = 0; i < mask.length; i++) {
      mask[i] = i % 2 === 0 ? 0.2 : 0.9
    }

    const r = brushes.clearSea()
    expect(r.clearedCells).toBeGreaterThan(0)
    // All cells should now be either 0 or 0.9 (modulo Float32 drift).
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i]
      const isZero = v === 0
      const isHigh = Math.abs(v - 0.9) < 1e-5
      expect(isZero || isHigh).toBe(true)
    }
  })

  it('pickThreshold defaults to 0.5 and can be overridden', () => {
    const { brushes } = createMaskBrushes()
    expect(brushes.pickThreshold()).toBeCloseTo(0.5, 5)
    brushes.setThreshold(0.75)
    expect(brushes.pickThreshold()).toBeCloseTo(0.75, 5)
  })

  it('onCommit reports the meta, mask area, and big component count', () => {
    const { brushes, bindMask } = createMaskBrushes()
    bindMask(mask)
    let captured: unknown = null
    brushes.onCommit = (e) => {
      captured = e
    }

    // Paint a single 10x10 block.
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) {
        mask[y * meta.width + x] = 1
      }
    }

    fireCommitHook(brushes, meta, mask)
    expect(captured).toMatchObject({
      metaSeed: meta.seed,
      metaWidth: meta.width,
      metaHeight: meta.height,
      threshold: 0.5,
    })
    const payload = captured as { maskArea: number; bigComponents: number }
    expect(payload.maskArea).toBe(100)
    expect(payload.bigComponents).toBe(1)
  })

  it('DEFAULT_MIN_BIG_AREA defaults to 100 pixels', () => {
    expect(DEFAULT_MIN_BIG_AREA).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// maskAreaAbove (commit hook helper)
// ---------------------------------------------------------------------------

describe('maskAreaAbove', () => {
  it('counts cells at or above the threshold', () => {
    const mask = Float32Array.from({ length: 10 }, (_, i) =>
      i < 3 ? 0.4 : 0.6,
    )
    // The 7 cells of 0.6 are above 0.5.
    expect(maskAreaAbove(mask, 0.5)).toBe(7)
    // Float32 precision means 0.4 literals are stored slightly above
    // 0.4 (≈ 0.4000000059604645), so every cell qualifies as "at or
    // above" 0.4. All 10 cells count.
    expect(maskAreaAbove(mask, 0.4)).toBe(10)
    // The 7 cells of 0.6 are at or above 0.6.
    expect(maskAreaAbove(mask, 0.6)).toBe(7)
  })
})