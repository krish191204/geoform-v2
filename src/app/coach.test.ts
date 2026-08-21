/**
 * Coach copy: writer English on the panel, debug kinds silent.
 */

import { describe, expect, it } from 'vitest'
import {
  COACH_SILENT_KINDS,
  isCoachSilent,
  renderCoach,
  type CoachEvent,
} from './coach'

const DEBUG_SNIPPETS = [
  'Boot at stage',
  'mask=',
  'Brush dab',
  'Stage sketch',
  'Tool:',
  'Cell (',
  'Make sense step',
  'plate target',
  'mask moved',
  'mean range',
]

describe('isCoachSilent', () => {
  it('silences boot, stage hops, brush dabs, cell dumps, and pipeline ticks', () => {
    expect([...COACH_SILENT_KINDS].sort()).toEqual(
      [
        'app.boot',
        'app.stage',
        'critique.overlay',
        'inspector.cell',
        'makeSense.step',
        'sketch.brushDab',
        'tool.changed',
      ].sort(),
    )
  })
})

describe('renderCoach writer copy', () => {
  it('boot copy never reaches the panel', () => {
    expect(isCoachSilent('app.boot')).toBe(true)
    const copy = renderCoach({
      kind: 'app.boot',
      stage: 'sketch',
      resumedFromMask: false,
      resumedFromWorld: false,
    })
    expect(copy.message).toContain('Boot at stage')
  })

  it('empty ocean does not dump resolution or land-cell counts', () => {
    const copy = renderCoach({
      kind: 'sketch.ready',
      width: 512,
      height: 256,
      landCells: 0,
    })
    expect(isCoachSilent('sketch.ready')).toBe(false)
    expect(copy.message).toBe(
      'Empty ocean. Paint land. Critique when the blob looks like a continent.',
    )
    expect(copy.message).not.toMatch(/512|256|0 land/)
  })

  it('critique names the score without pretending it is geography', () => {
    const copy = renderCoach({
      kind: 'critique.grade',
      score: 28,
      issueCount: 2,
      criticalCount: 1,
      majorCount: 1,
      minorCount: 0,
    })
    expect(copy.message).toContain('Score 28')
    expect(copy.message).toContain('not a geography grade')
  })

  it('make sense complete does not boast pipeline telemetry', () => {
    const copy = renderCoach({
      kind: 'makeSense.complete',
      provenanceSteps: 7,
      maskDeltaPct: 3.21,
      scoreBefore: 28,
      scoreAfter: 98,
      riversCount: 400,
      rangeAvgC: 18.4,
    })
    expect(copy.message).toBe('Atlas grounded. Switch layers. Hover a cell.')
    for (const snip of ['98', '3.21', '400', '18.4']) {
      expect(copy.message).not.toContain(snip)
    }
  })

  it('writer-facing kinds never contain debug snippets', () => {
    const events: CoachEvent[] = [
      { kind: 'sketch.ready', width: 512, height: 256, landCells: 0 },
      {
        kind: 'sketch.commit',
        metaSeed: 1,
        metaWidth: 512,
        metaHeight: 256,
        maskArea: 100,
        bigComponents: 1,
        threshold: 0.5,
      },
      { kind: 'sketch.clearSea', clearedCells: 12, autopilotTriggered: false },
      {
        kind: 'critique.grade',
        score: 28,
        issueCount: 2,
        criticalCount: 1,
        majorCount: 1,
        minorCount: 0,
      },
      { kind: 'makeSense.start', cellCount: 131072, plateTarget: 8 },
      {
        kind: 'makeSense.complete',
        provenanceSteps: 7,
        maskDeltaPct: 1,
        scoreBefore: 28,
        scoreAfter: 98,
        riversCount: 1,
        rangeAvgC: 10,
      },
      { kind: 'makeSense.cancelled', atStep: '3' },
      { kind: 'persist.saved', key: 'mask', bytes: 12, ok: true },
      { kind: 'persist.failed', key: 'mask', reason: 'quota', bytes: 99 },
      { kind: 'persist.failed', key: 'mask', reason: 'shape', bytes: 0 },
    ]
    for (const event of events) {
      expect(isCoachSilent(event.kind)).toBe(false)
      const { message } = renderCoach(event)
      for (const snip of DEBUG_SNIPPETS) {
        expect(message, `${event.kind} leaked “${snip}”`).not.toContain(snip)
      }
    }
  })
})
