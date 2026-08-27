// @vitest-environment happy-dom
/**
 * Doodle notes: stamps and continuous fields. Make sense ignores these.
 */
import { describe, expect, it } from 'vitest'
import {
  MARK_FOREST,
  MARK_NONE,
  MARK_RANGE,
  MARK_RIVER,
  MARK_TOWN,
  buildSketchNoteFields,
  emptyMarks,
  markValueForTool,
  noteStampRadius,
  rangeTickCells,
  riverThreads,
  stampSketchMarks,
} from './sketchMarks'

describe('sketch signifiers', () => {
  it('maps decorate tools to notes, Land/Ocean to clear', () => {
    expect(markValueForTool('draw-ridge')).toBe(MARK_RANGE)
    expect(markValueForTool('erase-channel')).toBe(MARK_RIVER)
    expect(markValueForTool('mark-forest')).toBe(MARK_FOREST)
    expect(markValueForTool('mark-town')).toBe(MARK_TOWN)
    expect(markValueForTool('wipe-note')).toBe(MARK_NONE)
    expect(markValueForTool('draw-land')).toBe(MARK_NONE)
    expect(markValueForTool('erase-land')).toBe(MARK_NONE)
    expect(markValueForTool('fill-mask')).toBeNull()
    expect(markValueForTool('inspect')).toBeNull()
  })

  it('stamps a circular range note and threads a river along neighbours', () => {
    const w = 8
    const h = 6
    const marks = emptyMarks(w * h)
    stampSketchMarks(marks, w, h, 3, 2, 0.4, MARK_RANGE)
    expect(marks[2 * w + 3]).toBe(MARK_RANGE)
    expect(rangeTickCells(marks, w, h).some((t) => t.x === 3 && t.y === 2)).toBe(true)

    const river = emptyMarks(w * h)
    river[3 * w + 1] = MARK_RIVER
    river[3 * w + 2] = MARK_RIVER
    river[3 * w + 3] = MARK_RIVER
    const threads = riverThreads(river, w, h)
    expect(threads.length).toBe(2)
  })

  it('spreads a range into a continuous field, not a single cell blit', () => {
    const w = 12
    const h = 8
    const marks = emptyMarks(w * h)
    marks[4 * w + 6] = MARK_RANGE
    const fields = buildSketchNoteFields(marks, w, h)
    expect(fields).toBeTruthy()
    expect(fields!.range[4 * w + 6]).toBeGreaterThan(0.35)
    expect(fields!.range[4 * w + 7]).toBeGreaterThan(0.15)
    expect(fields!.range[3 * w + 6]).toBeGreaterThan(0.15)
    expect(noteStampRadius('draw-ridge', 6)).toBeLessThan(6)
    expect(noteStampRadius('mark-town', 3)).toBeLessThan(1)
  })

  it('merges nearby range stamps into one massif, not separate discs', () => {
    const w = 16
    const h = 10
    const marks = emptyMarks(w * h)
    marks[5 * w + 6] = MARK_RANGE
    marks[5 * w + 9] = MARK_RANGE
    const fields = buildSketchNoteFields(marks, w, h)
    expect(fields!.range[5 * w + 7]).toBeGreaterThan(0.12)
    expect(fields!.range[5 * w + 8]).toBeGreaterThan(0.12)
  })

  it('stamps forest notes without touching river cells', () => {
    const w = 6
    const h = 4
    const marks = emptyMarks(w * h)
    stampSketchMarks(marks, w, h, 2, 1, 0.4, MARK_FOREST)
    expect(marks[1 * w + 2]).toBe(MARK_FOREST)
    expect(marks[1 * w + 2]).not.toBe(MARK_RIVER)
  })
})
