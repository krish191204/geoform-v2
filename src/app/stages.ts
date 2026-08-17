/**
 * Stage state machine for the 4-stage shell.
 *
 * Each stage declares four things:
 *   - `canEnter` — topbar navigation gate. False means the stage's
 *     topbar button is disabled (and the user can't navigate to it).
 *   - `canLeave` — forward-progress gate. False means the primary
 *     "advance" action on the stage is disabled.
 *   - `enter`    — fires once when the shell switches INTO this stage.
 *   - `leave`    — fires once when the shell switches OUT of this stage.
 *
 * Gates never mutate state; the shell owns the state and asks the gate
 * before doing anything.
 */

import type { EditorState, Layer, Stage } from '../world/types'

/** Transition target. Same value space as `Stage`. */
export type StageTransition = Stage

/**
 * Read-only state view the gates inspect.
 *
 * Extends `EditorState` with the shell-owned flags the gates need
 * (mask committed, Make-sense complete, latest Critique score). This
 * keeps `EditorState` clean while letting the gates read everything
 * they need from a single bundle.
 */
export interface ShellStateView extends EditorState {
  /** Live sketch mask; null until the first dab. */
  readonly mask: Float32Array | null
  /** True iff the user committed the Sketch mask. */
  readonly maskCommitted: boolean
  /** True iff Make-sense produced a `World`. */
  readonly makeSenseComplete: boolean
  /** Latest Critique score; 0 if Critique has not run. */
  readonly score: number
  /** Atlas layer after Make sense. */
  readonly layer: Layer
  /** Seasonal sample the atlas is showing. */
  readonly season: 'summer' | 'winter'
  /** Completed Make-sense steps (0..7). */
  readonly pipelineStep: number
  /** Last inspector readout HTML (empty until hover). */
  readonly inspectHtml: string
}

export interface StageGate {
  readonly stage: Stage
  readonly canEnter: (state: ShellStateView) => boolean
  readonly canLeave: (state: ShellStateView) => boolean
  readonly enter: (state: ShellStateView) => Promise<void> | void
  readonly leave: (state: ShellStateView) => void
}

const noop = (): void => {}

/**
 * The 4-stage state machine.
 *
 *   sketch  ──commit──▶  critique  ──mask committed──▶  make-sense  ──complete──▶  worldbuild
 *     ▲                                                    │
 *     └──────────────── back-to-sketch ─────────────────────┘
 *
 * Each transition is gated by the source stage's `canLeave` and the
 * destination stage's `canEnter`. The shell consults both.
 *
 * Make-sense does not require score > 0. A doodle that scores 0% is
 * exactly what Make-sense is for.
 */
export const STAGES: Readonly<Record<Stage, StageGate>> = {
  sketch: {
    stage: 'sketch',
    // Always re-enterable: the topbar Sketch button is never disabled.
    canEnter: () => true,
    // Leave Sketch only after the user commits the mask AND no work is
    // running on the foreground.
    canLeave: (state) => state.maskCommitted && state.isProcessing === false,
    enter: noop,
    leave: noop,
  },
  critique: {
    stage: 'critique',
    // Critique becomes available as soon as the Sketch mask is committed.
    canEnter: (state) => state.maskCommitted,
    // Critique never blocks the user from moving on.
    canLeave: () => true,
    enter: noop,
    leave: noop,
  },
  'make-sense': {
    stage: 'make-sense',
    // Committed mask is enough. Score can be 0.
    canEnter: (state) => state.maskCommitted && state.isProcessing === false,
    // Make-sense holds the user until the derivation completes.
    canLeave: (state) => state.makeSenseComplete,
    enter: noop,
    leave: noop,
  },
  worldbuild: {
    stage: 'worldbuild',
    // Worldbuild needs a completed Make-sense world.
    canEnter: (state) => state.makeSenseComplete,
    // Worldbuild never blocks leaving — the user can always go back to Sketch.
    canLeave: () => true,
    enter: noop,
    leave: noop,
  },
}

/** Ordered list of stages for UI iteration (topbar, breadcrumb). */
export const STAGE_ORDER: readonly Stage[] = [
  'sketch',
  'critique',
  'make-sense',
  'worldbuild',
]

/** Human-readable label for each stage button. */
export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  sketch: 'Sketch',
  critique: 'Critique',
  'make-sense': 'Make sense',
  worldbuild: 'Worldbuild',
}

/** Two-digit rail numbers, matching Geoform 1. */
export const STAGE_NUM: Readonly<Record<Stage, string>> = {
  sketch: '01',
  critique: '02',
  'make-sense': '03',
  worldbuild: '04',
}

/** The seven Make-sense pipeline steps shown in the progress bar. */
export const MAKE_SENSE_STEPS: readonly string[] = [
  'Freeze intent',
  'Plates under mask',
  'Orogeny',
  'Seasonal climate',
  'Hydrology',
  'Biomes',
  'Suitability',
]

/** Pipeline stepName → 1-based index for the progress list. */
export const MAKE_SENSE_STEP_INDEX: Readonly<Record<string, number>> = {
  freezeIntent: 1,
  plates: 2,
  orogeny: 3,
  seasonalClimate: 4,
  hydrology: 5,
  biomes: 6,
  suitability: 7,
}

// ---------------------------------------------------------------------------
// App event names
// ---------------------------------------------------------------------------

/**
 * Canonical `app:*` event names the UI fires and the shell listens for.
 * Centralised so the UI and the shell can never drift apart.
 */
export const APP_EVENTS = {
  /** Topbar stage button click. Detail: `{ stage: Stage }`. */
  STAGE_TRANSITION: 'app:stage-transition',
  /** Save button click. No detail. */
  SAVE: 'app:save',
  /** Reset button click (Make-sense only). No detail. */
  RESET: 'app:reset',
  /** Clear sea — wipe mask + world, back to empty ocean. */
  CLEAR_SEA: 'app:clear-sea',
  /** Inspector toggle button click. No detail. */
  TOGGLE_INSPECTOR: 'app:toggle-inspector',
  /** Atlas layer chip. Detail: `{ layer: Layer }`. */
  LAYER_CHANGE: 'app:layer-change',
  /** Summer / winter chip. Detail: `{ season: 'summer' | 'winter' }`. */
  SEASON_CHANGE: 'app:season-change',
  /** Critique button click — commits the Sketch mask. No detail. */
  COMMIT_SKETCH: 'app:commit-sketch',
  /** Make sense button click. No detail. */
  MAKE_SENSE: 'app:make-sense',
  /** Cancel button click (Make-sense). No detail. */
  CANCEL_MAKE_SENSE: 'app:cancel-make-sense',
  /** Worldbuild button click. No detail. */
  WORLDBUILD: 'app:worldbuild',
  /** Back to Sketch button click (Worldbuild). No detail. */
  BACK_TO_SKETCH: 'app:back-to-sketch',
  /** Tool button click. Detail: `{ tool: Tool }`. */
  TOOL_CHANGE: 'app:tool-change',
  /** Meta slider change. Detail: `{ meta: Partial<WorldMeta> }`. */
  META_CHANGE: 'app:meta-change',
  /** Brush size slider change. Detail: `{ size: number }`. */
  BRUSH_CHANGE: 'app:brush-change',
  /** Brush strength slider change. Detail: `{ strength: number }`. */
  STRENGTH_CHANGE: 'app:strength-change',
} as const

/** Type-safe detail for `app:stage-transition`. */
export interface StageTransitionDetail {
  readonly stage: Stage
}

/** Type-safe detail for `app:tool-change`. */
export interface ToolChangeDetail {
  readonly tool: EditorState['tool']
}

/** Type-safe detail for `app:meta-change`. */
export interface MetaChangeDetail {
  readonly meta: Partial<EditorState['meta']>
}

/** Type-safe detail for `app:brush-change`. */
export interface BrushChangeDetail {
  readonly size: number
}

/** Type-safe detail for `app:strength-change`. */
export interface StrengthChangeDetail {
  readonly strength: number
}

/** Type-safe detail for `app:layer-change`. */
export interface LayerChangeDetail {
  readonly layer: Layer
}

/** Type-safe detail for `app:season-change`. */
export interface SeasonChangeDetail {
  readonly season: 'summer' | 'winter'
}

/** Coach message shape — the `coach:message` event detail. */
export interface CoachMessageDetail {
  readonly tone: 'info' | 'success' | 'warn' | 'error'
  readonly text: string
}
