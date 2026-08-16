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
 *   - canvas pointer events on the Sketch stage — wired by the shell
 *     to `paintMask` from the brush module.
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
import { renderMaskToCanvas } from './canvas_paint'
import { createMaskBrushes } from '../sketch/maskBrushes'
import { placeCity, removeNearestCity } from '../sketch/worldbuild'
import { makeSenseInline } from '../pipeline/makeSense_inline'
import { critiqueMask, critiqueWorld } from '../critique/main'
import {
  saveMask,
  saveWorld,
  serializeMask,
  serializeWorld,
} from '../world/persist'
import { announce as announceCoach } from './coach'

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

  // ----- Boot: always start with an empty ocean per the Phase 0 spec. ---
  // The user can opt in to resume a saved sketch via a future "Resume"
  // button; for Phase 0 we leave the canvas untouched until the user
  // paints. This also keeps the boot deterministic for tests.

  // Mask brush module — owns the dab logic. Created once, reused for
  // every canvas pointer event.
  const brushes = createMaskBrushes()

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
      // Wire canvas pointer events to the brush. The canvas is in the
      // SketchStageRefs only; the other stages don't have one. When the
      // stage changes, we re-attach the listener.
      const sketchRefs = next.refs as { canvas?: HTMLCanvasElement } | undefined
      if (sketchRefs?.canvas) {
        attachCanvasDab(sketchRefs.canvas)
      }
      stageBody.mount(next.refs.root)
      currentStageUI = next
    } else {
      updateStageUI(currentStageUI, view)
    }
  }

  /** Bind a single `pointerdown` + `pointermove` to the brush / city router. */
  function attachCanvasDab(canvas: HTMLCanvasElement): void {
    let painting = false
    const dab = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const x = Math.floor(((clientX - rect.left) / rect.width) * state.meta.width)
      const y = Math.floor(((clientY - rect.top) / rect.height) * state.meta.height)
      if (x < 0 || x >= state.meta.width || y < 0 || y >= state.meta.height) return

      // Worldbuild tools route to city placement; sketch tools route to the
      // mask brushes. The routing is tool-driven so the same canvas
      // listener works on every stage.
      if (state.tool === 'place-city' || state.tool === 'remove-city') {
        if (!state.world) {
          announce('warn', 'No derived world yet — run Make sense first.')
          return
        }
        if (state.tool === 'place-city') {
          const next = `City ${state.world.cities.length + 1}`
          const result = placeCity(state.world, x, y, next)
          if (result.rejected) {
            announce('warn', 'No city placed — need land, suitability ≥ 0.4, no neighbour within 5 cells.')
          } else if (result.city) {
            announce('success', `Placed ${result.city.name} at (${x}, ${y}).`)
          }
        } else {
          const result = removeNearestCity(state.world, x, y)
          if (result.matched && result.removed) {
            announce('info', `Removed ${result.removed.name}.`)
          } else {
            announce('warn', 'No city within range.')
          }
        }
        render()
        return
      }

      // Sketch tool: mutate the mask.
      if (!flags.mask) {
        flags.mask = new Float32Array(state.meta.width * state.meta.height)
      }
      const tool = state.tool === 'erase-land' ? 'erase-land' : 'draw-land'
      brushes.dab({
        mask: flags.mask,
        meta: state.meta,
        x,
        y,
        brushSize: state.brushSize,
        strength: state.strength,
        tool,
      })
      // Always repaint the canvas so the user sees the new dab.
      renderMaskToCanvas(canvas, flags.mask, state.meta)
      flagOnlyMaskDirty()
    }
    canvas.addEventListener('pointerdown', (e) => {
      painting = true
      dab(e.clientX, e.clientY)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!painting) return
      dab(e.clientX, e.clientY)
    })
    canvas.addEventListener('pointerup', () => {
      painting = false
    })
    canvas.addEventListener('pointercancel', () => {
      painting = false
    })
  }

  /**
   * Re-render once after a mask dab. Updates the topbar (so the
   * "Critique" button enables as soon as the mask has any land) AND
   * the current stage UI (so any in-stage sliders/badges refresh).
   * Cheap enough that we don't bother with throttling.
   */
  function flagOnlyMaskDirty(): void {
    const view = buildView(bundle)
    updateTopbar(topbarRefs, view)
    if (currentStageUI !== null) {
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
    // Save whatever is currently mounted. If we have a derived world,
    // save it; otherwise save the mask. Both succeed or fail honestly —
    // a bare "Saved (seed N)" message without any storage write is B02.
    if (state.world) {
      const json = serializeWorld(state.world)
      const bytes = json.length
      const ok = saveWorld(state.world)
      if (ok) {
        announceCoach({ kind: 'persist.saved', key: 'world', bytes, ok: true })
      } else {
        announceCoach({
          kind: 'persist.failed',
          key: 'world',
          reason: 'quota',
          bytes,
        })
      }
    } else if (flags.mask) {
      const json = serializeMask(state.meta, flags.mask)
      const bytes = json.length
      const ok = saveMask(state.meta, flags.mask)
      if (ok) {
        announceCoach({ kind: 'persist.saved', key: 'mask', bytes, ok: true })
      } else {
        announceCoach({
          kind: 'persist.failed',
          key: 'mask',
          reason: 'quota',
          bytes,
        })
      }
    } else {
      announceCoach({
        kind: 'persist.failed',
        key: 'mask',
        reason: 'shape',
        bytes: 0,
      })
    }
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
    // Run the real pre-Make-sense critique on the mask. Score now comes
    // from the real grader, not a hardcoded 0.6 demo.
    const result = critiqueMask(flags.mask ?? new Float32Array(0), state.meta, state.meta.threshold)
    state.issues = result.issues
    flags.score = result.score
    announce('info', `Sketch committed. Critique score: ${result.score}.`)
    render()
  })

  window.addEventListener(APP_EVENTS.MAKE_SENSE, () => {
    if (state.stage !== 'critique') return
    const view = buildView(bundle)
    if (!STAGES['make-sense'].canEnter(view)) return
    void runMakeSense()
  })

  /** The actual Make-sense pipeline run. */
  async function runMakeSense(): Promise<void> {
    STAGES[state.stage].leave(buildView(bundle))
    state.stage = 'make-sense'
    state.isProcessing = true
    render()
    announce('info', 'Make-sense running…')
    try {
      const result = await makeSenseInline({
        meta: state.meta,
        mask: flags.mask ?? new Float32Array(state.meta.width * state.meta.height),
      })
      state.world = result.world
      state.provenance = result.provenance
      // Post-Make-sense critique on the derived world.
      const c = critiqueWorld(result.world)
      state.issues = c.issues
      flags.score = c.score
      flags.makeSenseComplete = true
      state.isProcessing = false
      announce(
        'success',
        `Make-sense complete. Score: ${c.score}. Rivers: ${c.issues.length === 0 ? '✓' : 'needs review'}.`,
      )
    } catch (err) {
      state.isProcessing = false
      announce('error', `Make-sense failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      render()
    }
  }

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
