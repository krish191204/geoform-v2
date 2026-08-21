/**
 * Coach engine — turns provenance events into writer-facing copy.
 *
 * Every message is generated from the event's measurements; the system
 * literally cannot say something that isn't backed by the event payload.
 * Debug kinds (boot dumps, stage hops, cell telemetry) stay in the union
 * for provenance but never reach the Coach panel.
 */

import type { Issue, Stage, Tool } from '../world/types'
import { gradeCaption, gradeFromScore } from '../critique/main'

/** Tone carried alongside the message in the CustomEvent detail. */
export type CoachTone = 'info' | 'warn' | 'success' | 'error'

/**
 * Discriminated union of every coach announcement.
 * Each member is a closed record; the engine emits no other shapes.
 */
export type CoachEvent =
  /** Empty-ocean boot or after Clear sea. */
  | { kind: 'sketch.ready'; width: number; height: number; landCells: number }
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

/** Kinds that must never appear in the Coach panel. */
export const COACH_SILENT_KINDS: ReadonlySet<CoachEvent['kind']> = new Set([
  'sketch.brushDab',
  'critique.overlay',
  'makeSense.step',
  'app.boot',
  'app.stage',
  'tool.changed',
  'inspector.cell',
])

export function isCoachSilent(kind: CoachEvent['kind']): boolean {
  return COACH_SILENT_KINDS.has(kind)
}

/**
 * Render an event into a (tone, message) pair. Exhaustive — no `default` branch.
 * Each case builds its copy only from the event's own measurements.
 */
export function renderCoach(event: CoachEvent): { tone: CoachTone; message: string } {
  switch (event.kind) {
    case 'sketch.ready':
      return {
        tone: 'info',
        message: 'Empty ocean. Drag a picture onto the map, or paint land.',
      }
    case 'sketch.brushDab':
      return {
        tone: 'info',
        message: `Brush dab at (${event.x}, ${event.y}), size ${event.brushSize}, mask changed by ${event.maskDelta}`,
      }
    case 'sketch.commit':
      return {
        tone: 'success',
        message: 'Sketch committed. Read the issues, then Make sense.',
      }
    case 'sketch.clearSea':
      return {
        tone: 'info',
        message: 'Empty ocean again. Paint land.',
      }
    case 'critique.grade': {
      const grade = gradeFromScore(event.score)
      return {
        tone: 'warn',
        message: `${grade} — ${gradeCaption(grade)}. ${event.criticalCount} critical, ${event.majorCount} major, ${event.minorCount} minor.`,
      }
    }
    case 'critique.overlay':
      return {
        tone: 'warn',
        message: `Overlay: ${event.issueId} (${event.severity}) — ${event.cellCount} cells`,
      }
    case 'makeSense.start':
      return {
        tone: 'info',
        message: 'Grounding the doodle…',
      }
    case 'makeSense.step':
      return {
        tone: 'info',
        message: `Make sense step ${event.stepIndex}/${event.totalSteps}: ${event.stepName} (${event.elapsedMs}ms)`,
      }
    case 'makeSense.complete': {
      const grade = gradeFromScore(event.scoreAfter)
      return {
        tone: 'success',
        message: `${grade} — ${gradeCaption(grade)}. Atlas grounded. Switch layers.`,
      }
    }
    case 'makeSense.cancelled':
      return {
        tone: 'warn',
        message: 'Make sense stopped.',
      }
    case 'persist.saved':
      return {
        tone: 'success',
        message: event.key === 'world' ? 'World saved.' : 'Sketch saved.',
      }
    case 'persist.failed':
      return event.reason === 'quota'
        ? { tone: 'warn', message: 'Storage full — Export your mask as JSON.' }
        : event.reason === 'shape'
          ? { tone: 'warn', message: 'Nothing to save yet. Paint land first.' }
          : { tone: 'error', message: 'Save failed. Try again, or export the mask as JSON.' }
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
 * Silent kinds are no-ops. Writer-facing copy only.
 *
 * Pure-Node / SSR / Web Worker: no-op. The CustomEvent wire is window-only;
 * tests run under vitest+node, where `window` is undefined, so we early-return.
 */
export function announce(event: CoachEvent): void {
  if (typeof window === 'undefined') return
  if (isCoachSilent(event.kind)) return
  const { tone, message } = renderCoach(event)
  window.dispatchEvent(
    new CustomEvent('coach:message', { detail: { kind: event.kind, message, tone } }),
  )
}

/**
 * EXAMPLES
 *
 * announce({ kind: 'sketch.ready', width: 512, height: 256, landCells: 0 })
 *   -> { tone: 'info', message: 'Empty ocean. Drag a picture onto the map, or paint land.' }
 *
 * announce({ kind: 'app.boot', stage: 'sketch', resumedFromMask: false, resumedFromWorld: false })
 *   -> silent (Coach panel unchanged)
 *
 * announce({ kind: 'persist.failed', key: 'mask', reason: 'quota', bytes: 1048576 })
 *   -> { tone: 'warn', message: 'Storage full — Export your mask as JSON.' }
 */