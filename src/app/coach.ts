/**
 * Coach engine — turns provenance events into user-facing copy.
 *
 * Every message is generated from the event's measurements; the system
 * literally cannot say something that isn't backed by the event payload.
 */

import type { Issue, Stage, Tool } from '../world/types'

/** Tone carried alongside the message in the CustomEvent detail. */
export type CoachTone = 'info' | 'warn' | 'success' | 'error'

/**
 * Discriminated union of every coach announcement.
 * Each member is a closed record; the engine emits no other shapes.
 */
export type CoachEvent =
  /** One brush dab on the sketch canvas. */
  | { kind: 'sketch.brushDab'; x: number; y: number; brushSize: number; maskDelta: number }
  /** A committed sketch mask. */
  | { kind: 'sketch.commit'; metaSeed: number; metaWidth: number; metaHeight: number; maskArea: number; bigComponents: number; threshold: number }
  /** Sea cells were cleared from the mask. */
  | { kind: 'sketch.clearSea'; clearedCells: number; autopilotTriggered: boolean }
  /** Critique produced a score. */
  | { kind: 'critique.grade'; score: number; issueCount: number; criticalCount: number; majorCount: number; minorCount: number }
  /** A single issue was highlighted on the overlay. */
  | { kind: 'critique.overlay'; issueId: string; severity: Issue['severity']; cellCount: number }
  /** Make-sense started. */
  | { kind: 'makeSense.start'; cellCount: number; plateTarget: number }
  /** Make-sense advanced one step. */
  | { kind: 'makeSense.step'; stepName: string; stepIndex: number; totalSteps: number; elapsedMs: number }
  /** Make-sense finished. */
  | { kind: 'makeSense.complete'; provenanceSteps: number; maskDeltaPct: number; scoreBefore: number; scoreAfter: number; riversCount: number; rangeAvgC: number }
  /** Make-sense cancelled mid-run. */
  | { kind: 'makeSense.cancelled'; atStep: string }
  /** A key persisted successfully. */
  | { kind: 'persist.saved'; key: 'mask' | 'world'; bytes: number; ok: true }
  /** A key failed to persist. */
  | { kind: 'persist.failed'; key: 'mask' | 'world'; reason: 'quota' | 'parse' | 'shape'; bytes: number }
  /** App booted. */
  | { kind: 'app.boot'; stage: Stage; resumedFromMask: boolean; resumedFromWorld: boolean }
  /** App moved between stages. */
  | { kind: 'app.stage'; from: Stage; to: Stage; trigger: 'user' | 'invariant' }
  /** The active tool changed. */
  | { kind: 'tool.changed'; tool: Tool }
  /** Inspector read a single cell. */
  | { kind: 'inspector.cell'; x: number; y: number; elevM: number; plateId: number; tempSummerC: number; tempWinterC: number; tempRangeC: number; moistSummer: number; moistWinter: number; biome: string }

/**
 * Render an event into a (tone, message) pair. Exhaustive — no `default` branch.
 * Each case builds its copy only from the event's own measurements.
 */
function render(event: CoachEvent): { tone: CoachTone; message: string } {
  switch (event.kind) {
    case 'sketch.brushDab':
      return {
        tone: 'info',
        message: `Brush dab at (${event.x}, ${event.y}), size ${event.brushSize}, mask changed by ${event.maskDelta}`,
      }
    case 'sketch.commit':
      return {
        tone: 'success',
        message: `Committed mask: ${event.metaWidth} x ${event.metaHeight}, area ${event.maskArea} pixels, ${event.bigComponents} components >= ${event.threshold}`,
      }
    case 'sketch.clearSea':
      return {
        tone: 'info',
        message: event.autopilotTriggered
          ? `Cleared ${event.clearedCells} ocean cells (autopilot)`
          : `Cleared ${event.clearedCells} ocean cells`,
      }
    case 'critique.grade':
      return {
        tone: 'warn',
        message: `Score: ${event.score} (${event.criticalCount} critical, ${event.majorCount} major, ${event.minorCount} minor issues)`,
      }
    case 'critique.overlay':
      return {
        tone: 'warn',
        message: `Overlay: ${event.issueId} (${event.severity}) — ${event.cellCount} cells`,
      }
    case 'makeSense.start':
      return {
        tone: 'info',
        message: `Make sense starting on ${event.cellCount} cells, plate target ${event.plateTarget}`,
      }
    case 'makeSense.step':
      return {
        tone: 'info',
        message: `Make sense step ${event.stepIndex}/${event.totalSteps}: ${event.stepName} (${event.elapsedMs}ms)`,
      }
    case 'makeSense.complete':
      return {
        tone: 'success',
        message: `Make sense complete: ${event.provenanceSteps} steps, mask moved ${event.maskDeltaPct.toFixed(2)}%, score ${event.scoreBefore}->${event.scoreAfter}, ${event.riversCount} rivers, mean range ${event.rangeAvgC.toFixed(1)}C`,
      }
    case 'makeSense.cancelled':
      return {
        tone: 'warn',
        message: `Make sense cancelled at step ${event.atStep}`,
      }
    case 'persist.saved':
      return {
        tone: 'success',
        message: `Saved ${event.key} (${event.bytes} bytes)`,
      }
    case 'persist.failed':
      return event.reason === 'quota'
        ? { tone: 'warn', message: 'Storage full — Export your mask as JSON.' }
        : { tone: 'error', message: `Save failed: ${event.reason} (${event.bytes} bytes attempted)` }
    case 'app.boot':
      return {
        tone: 'info',
        message: `Boot at stage ${event.stage} (mask=${event.resumedFromMask}, world=${event.resumedFromWorld})`,
      }
    case 'app.stage':
      return {
        tone: 'info',
        message: `Stage ${event.from} -> ${event.to} (${event.trigger})`,
      }
    case 'tool.changed':
      return {
        tone: 'info',
        message: `Tool: ${event.tool}`,
      }
    case 'inspector.cell':
      return {
        tone: 'info',
        message: `Cell (${event.x}, ${event.y}): elev ${event.elevM}m, plate ${event.plateId}, summer ${event.tempSummerC}C, winter ${event.tempWinterC}C, range ${event.tempRangeC}C, summer moist ${event.moistSummer}, winter moist ${event.moistWinter}, biome ${event.biome}`,
      }
  }
}

/**
 * Dispatch a `coach:message` CustomEvent on `window` for the given event.
 * The message is generated purely from the event's measurements.
 */
export function announce(event: CoachEvent): void {
  const { tone, message } = render(event)
  window.dispatchEvent(
    new CustomEvent('coach:message', { detail: { kind: event.kind, message, tone } }),
  )
}

/**
 * EXAMPLES
 *
 * announce({ kind: 'sketch.brushDab', x: 120, y: 64, brushSize: 12, maskDelta: 0.04 })
 *   -> { tone: 'info', message: 'Brush dab at (120, 64), size 12, mask changed by 0.04' }
 *
 * announce({
 *   kind: 'makeSense.complete',
 *   provenanceSteps: 8, maskDeltaPct: 3.21, scoreBefore: 62, scoreAfter: 91,
 *   riversCount: 47, rangeAvgC: 18.4,
 * })
 *   -> { tone: 'success', message: 'Make sense complete: 8 steps, mask moved 3.21%, score 62->91, 47 rivers, mean range 18.4C' }
 *
 * announce({ kind: 'persist.failed', key: 'mask', reason: 'quota', bytes: 1048576 })
 *   -> { tone: 'warn', message: 'Storage full — Export your mask as JSON.' }
 *
 * announce({ kind: 'persist.failed', key: 'world', reason: 'shape', bytes: 2048 })
 *   -> { tone: 'error', message: 'Save failed: shape (2048 bytes attempted)' }
 */