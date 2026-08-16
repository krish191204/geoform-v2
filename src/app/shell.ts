/**
 * Shell module: the 4-stage editor surface.
 *
 * Owns the `EditorState` (the source of truth) plus the shell-only
 * flags (`mask`, `maskCommitted`, `makeSenseComplete`, `score`) that
 * the stage gates need to read but `EditorState` does not declare.
 *
 * Listens for:
 *   - `app:*` events fired by the UI (topbar buttons, stage buttons,
 *     sliders, tool picks).
 *   - `coach:message` events fired by anyone — passed through to the
 *     coach-bar UI.
 *
 * On every state change the shell re-renders the affected DOM regions
 * via the `ui` module. There is no external state library.
 */

import type { EditorState } from '../world/types'
import { DEFAULT_META } from '../world/types'
import {
  APP_EVENTS,
  STAGES,
  type BrushChangeDetail,
  type MetaChangeDetail,
  type ShellStateView,
  type StageTransitionDetail,
  type StrengthChangeDetail,
  type ToolChangeDetail,
} from './stages'
import {
  mountCoachBar,
  mountStageBody,
  mountStageUI,
  mountTopbar,
  updateStageUI,
  updateTopbar,
  type StageRefs,
} from './ui'

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Shell-owned flags not in `EditorState`. Kept separate so `EditorState`
 * stays clean and gates read a single combined view.
 */
interface ShellFlags {
  /** Live mask being painted during Sketch; null until the user dabs. */
  mask: Float32Array | null
  /** True iff the user clicked the Sketch Critique button (committed the mask). */
  maskCommitted: boolean
  /** True iff Make-sense produced a `World`. */
  makeSenseComplete: boolean
  /** Latest Critique score; 0 if Critique has not run. */
  score: number
}

interface ShellBundle {
  state: EditorState
  flags: ShellFlags
}

/** Build the initial state + flags for a fresh session. */
function makeInitialBundle(): ShellBundle {
  const state: EditorState = {
    stage: 'sketch',
    world: null,
    meta: { ...DEFAULT_META },
    tool: 'draw-land',
    brushSize: 8,
    strength: 0.5,
    issues: [],
    provenance: null,
    isProcessing: false,
  }
  const flags: ShellFlags = {
    mask: null,
    maskCommitted: false,
    makeSenseComplete: false,
    score: 0,
  }
  return { state, flags }
}

/** Snapshot the current bundle into a `ShellStateView` the gates / UI can read. */
function buildView(bundle: ShellBundle): ShellStateView {
  return { ...bundle.state, ...bundle.flags }
}

/** Dispatch a coach message — exported so external code can talk to the coach-bar. */
export function announce(
  tone: 'info' | 'success' | 'warn' | 'error',
  text: string,
): void {
  window.dispatchEvent(
    new CustomEvent('coach:message', { detail: { tone, text } }),
  )
}

// ---------------------------------------------------------------------------
// mountApp — the single entry point
// ---------------------------------------------------------------------------

/**
 * Mount the 4-stage editor into `root`. Wires up all global event
 * listeners. Returns nothing — the shell owns state for the lifetime
 * of the page.
 */
export function mountApp(root: HTMLElement): void {
  const bundle = makeInitialBundle()
  const { state, flags } = bundle

  // Mount the three regions: topbar, stage body, coach bar.
  const topbarRefs = mountTopbar()
  const stageBody = mountStageBody()
  const coachBar = mountCoachBar()

  root.append(topbarRefs.root)
  root.append(stageBody.root)
  root.append(coachBar)

  // Currently mounted stage UI; null until the first render.
  let currentStageUI: StageRefs | null = null

  function render(): void {
    const view = buildView(bundle)
    updateTopbar(topbarRefs, view)
    if (currentStageUI === null || currentStageUI.stage !== state.stage) {
      const next = mountStageUI(view)
      stageBody.mount(next.refs.root)
      currentStageUI = next
    } else {
      updateStageUI(currentStageUI, view)
    }
  }

  // ----- Topbar events ---------------------------------------------------

  window.addEventListener(APP_EVENTS.STAGE_TRANSITION, (ev) => {
    const detail = (ev as CustomEvent).detail as StageTransitionDetail | undefined
    if (!detail) return
    const target = detail.stage
    const view = buildView(bundle)
    if (target === state.stage) return
    if (!STAGES[target].canEnter(view)) {
      announce('warn', `Cannot enter ${target} yet.`)
      return
    }
    STAGES[state.stage].leave(view)
    state.stage = target
    render()
    STAGES[target].enter(view)
  })

  window.addEventListener(APP_EVENTS.SAVE, () => {
    announce('info', `Saved (seed ${state.meta.seed}).`)
  })

  window.addEventListener(APP_EVENTS.RESET, () => {
    if (state.stage !== 'make-sense') return
    state.world = null
    state.provenance = null
    state.issues = []
    state.isProcessing = false
    flags.makeSenseComplete = false
    flags.score = 0
    announce('warn', 'Derived world cleared.')
    render()
  })

  window.addEventListener(APP_EVENTS.TOGGLE_INSPECTOR, () => {
    announce('info', 'Inspector toggled.')
  })

  // ----- Stage button events --------------------------------------------

  window.addEventListener(APP_EVENTS.COMMIT_SKETCH, () => {
    if (state.stage !== 'sketch') return
    flags.maskCommitted = true
    flags.score = 0.6 // demo: ensure Make-sense canEnter passes for Phase 0
    announce('info', 'Sketch committed. Critique available.')
    render()
  })

  window.addEventListener(APP_EVENTS.MAKE_SENSE, () => {
    if (state.stage !== 'critique') return
    const view = buildView(bundle)
    if (!STAGES['make-sense'].canEnter(view)) return
    STAGES[state.stage].leave(view)
    state.stage = 'make-sense'
    state.isProcessing = true
    announce('info', 'Make-sense running…')
    render()
    // Phase 0 placeholder: real pipeline is Phase 1+. Simulate completion.
    window.setTimeout(() => {
      flags.makeSenseComplete = true
      state.isProcessing = false
      announce('success', 'Make-sense complete. Worldbuild available.')
      render()
    }, 1500)
  })

  window.addEventListener(APP_EVENTS.CANCEL_MAKE_SENSE, () => {
    if (state.stage !== 'make-sense') return
    state.isProcessing = false
    flags.makeSenseComplete = false
    announce('warn', 'Make-sense cancelled.')
    render()
  })

  window.addEventListener(APP_EVENTS.WORLDBUILD, () => {
    if (state.stage !== 'make-sense') return
    const view = buildView(bundle)
    if (!STAGES[state.stage].canLeave(view)) return
    STAGES[state.stage].leave(view)
    state.stage = 'worldbuild'
    announce('success', 'Worldbuild active.')
    render()
    STAGES[state.stage].enter(view)
  })

  window.addEventListener(APP_EVENTS.BACK_TO_SKETCH, () => {
    if (state.stage !== 'worldbuild') return
    const view = buildView(bundle)
    STAGES[state.stage].leave(view)
    state.stage = 'sketch'
    // Cities are preserved per spec — they live on `state.world.cities`.
    announce('info', 'Back to Sketch. Cities preserved.')
    render()
  })

  // ----- Within-stage controls ------------------------------------------

  window.addEventListener(APP_EVENTS.TOOL_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as ToolChangeDetail | undefined
    if (!detail) return
    state.tool = detail.tool
    render()
  })

  window.addEventListener(APP_EVENTS.META_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as MetaChangeDetail | undefined
    if (!detail) return
    state.meta = { ...state.meta, ...detail.meta }
    render()
  })

  window.addEventListener(APP_EVENTS.BRUSH_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as BrushChangeDetail | undefined
    if (!detail) return
    state.brushSize = detail.size
    render()
  })

  window.addEventListener(APP_EVENTS.STRENGTH_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as StrengthChangeDetail | undefined
    if (!detail) return
    state.strength = detail.strength
    render()
  })

  // ----- coach:message passthrough --------------------------------------

  // The coach-bar's UI already updates itself on `coach:message`. The
  // shell also forwards the event onto its own listener so any future
  // shell-side state (e.g., toasts) can react. For Phase 0 this is a
  // pass-through: re-dispatch on a `shell:coach-message` channel so
  // downstream modules can subscribe without touching `window` directly.
  window.addEventListener('coach:message', (ev) => {
    root.dispatchEvent(
      new CustomEvent('shell:coach-message', {
        detail: (ev as CustomEvent).detail,
        bubbles: false,
      }),
    )
  })

  // First render
  render()
}
