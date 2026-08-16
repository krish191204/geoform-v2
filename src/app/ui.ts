/**
 * DOM scaffolding for the 4-stage shell.
 *
 * Three regions mount into `root`:
 *
 *   ┌─ topbar (always visible) ──────────────────────────────────────┐
 *   │ [Sketch]  Critique  Make sense  Worldbuild                    │
 *   │                              [Save]  [Reset]  [Inspector]     │
 *   └────────────────────────────────────────────────────────────────┘
 *   ┌─ stage-body ───────────────────────────────────────────────────┐
 *   │   <per-stage UI mounts here>                                  │
 *   └────────────────────────────────────────────────────────────────┘
 *   ┌─ coach-bar (bottom) ───────────────────────────────────────────┐
 *   │   Last `coach:message` (tone-colored badge)                   │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Pure DOM. No state mutation — the shell owns the state and passes it
 * in. Buttons dispatch `app:*` events on `window`; the shell listens.
 */

import type { Stage, Tool } from '../world/types'
import {
  APP_EVENTS,
  MAKE_SENSE_STEPS,
  STAGE_LABEL,
  STAGE_ORDER,
  STAGES,
  type BrushChangeDetail,
  type MetaChangeDetail,
  type ShellStateView,
  type StageTransitionDetail,
  type StrengthChangeDetail,
  type ToolChangeDetail,
} from './stages'

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | null | undefined>

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue
      if (v === true) node.setAttribute(k, '')
      else node.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

function fire<T>(type: string, detail?: T): void {
  window.dispatchEvent(new CustomEvent(type, { detail }))
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------

export interface TopbarRefs {
  readonly root: HTMLElement
  readonly stageButtons: Readonly<Record<Stage, HTMLButtonElement>>
  readonly saveBtn: HTMLButtonElement
  readonly resetBtn: HTMLButtonElement
  readonly inspectorBtn: HTMLButtonElement
  readonly saveMeta: HTMLElement
}

export function mountTopbar(): TopbarRefs {
  const stageButtons = {} as Record<Stage, HTMLButtonElement>

  const nav = el('nav', { class: 'stage-nav', 'aria-label': 'Pipeline stages' })
  for (const stage of STAGE_ORDER) {
    const btn = el(
      'button',
      { type: 'button', class: 'stage-btn', 'data-stage': stage },
      STAGE_LABEL[stage],
    )
    btn.addEventListener('click', () => {
      const detail: StageTransitionDetail = { stage }
      fire(APP_EVENTS.STAGE_TRANSITION, detail)
    })
    stageButtons[stage] = btn
    nav.append(btn)
  }

  const saveBtn = el(
    'button',
    { type: 'button', class: 'action-btn', title: 'Save current state' },
    'Save',
  )
  saveBtn.addEventListener('click', () => fire(APP_EVENTS.SAVE))

  const resetBtn = el(
    'button',
    { type: 'button', class: 'action-btn', title: 'Clear derived world' },
    'Reset',
  )
  resetBtn.addEventListener('click', () => fire(APP_EVENTS.RESET))

  const inspectorBtn = el(
    'button',
    { type: 'button', class: 'action-btn', title: 'Toggle inspector' },
    'Inspector',
  )
  inspectorBtn.addEventListener('click', () => fire(APP_EVENTS.TOGGLE_INSPECTOR))

  const saveMeta = el('span', { class: 'save-meta' }, 'No save yet')

  const actions = el(
    'div',
    { class: 'topbar-actions' },
    saveBtn,
    resetBtn,
    inspectorBtn,
    saveMeta,
  )

  const brand = el(
    'div',
    { class: 'brand' },
    el('h1', {}, 'Geoform'),
    el(
      'p',
      {},
      'Sketch a mask. Critique finds issues. Make-sense derives a world. Worldbuild places cities.',
    ),
  )

  const root = el(
    'header',
    { class: 'topbar' },
    brand,
    nav,
    actions,
  )

  return { root, stageButtons, saveBtn, resetBtn, inspectorBtn, saveMeta }
}

/** Apply current state to the topbar — disabled flags, active highlight, Reset visibility. */
export function updateTopbar(refs: TopbarRefs, state: ShellStateView): void {
  for (const stage of STAGE_ORDER) {
    const btn = refs.stageButtons[stage]
    const isActive = state.stage === stage
    const reachable = isActive || STAGES[stage].canEnter(state)
    btn.classList.toggle('active', isActive)
    btn.disabled = !reachable
    btn.setAttribute('aria-current', isActive ? 'step' : 'false')
  }
  refs.resetBtn.style.display = state.stage === 'make-sense' ? '' : 'none'
}

// ---------------------------------------------------------------------------
// Stage body
// ---------------------------------------------------------------------------

export interface StageBody {
  readonly root: HTMLElement
  /** Replace the current stage UI with `content`. */
  mount(content: HTMLElement): void
  /** Clear the current stage UI (used during processing transitions). */
  clear(): void
}

export function mountStageBody(): StageBody {
  const root = el('section', { class: 'stage-body', 'aria-label': 'Stage content' })
  let current: HTMLElement | null = null
  return {
    root,
    mount(content) {
      if (current && current !== content) root.removeChild(current)
      current = content
      if (content.parentNode !== root) root.append(content)
    },
    clear() {
      if (current) {
        root.removeChild(current)
        current = null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Coach bar
// ---------------------------------------------------------------------------

/**
 * Mount the bottom coach bar. Listens for `coach:message` events on
 * `window` and shows the last message in a tone-colored badge.
 */
export function mountCoachBar(): HTMLElement {
  const root = el('footer', { class: 'coach-bar', 'aria-label': 'Coach' })
  const badge = el('span', { class: 'coach-badge coach-empty' }, 'Ready')
  root.append(badge)

  window.addEventListener('coach:message', (ev) => {
    const detail = (ev as CustomEvent).detail as
      | { tone?: 'info' | 'success' | 'warn' | 'error'; text?: string }
      | undefined
    const tone = detail?.tone ?? 'info'
    const text = detail?.text ?? ''
    badge.className = `coach-badge coach-${tone}`
    badge.textContent = text
  })

  return root
}

// ---------------------------------------------------------------------------
// Stage UI — shared bits
// ---------------------------------------------------------------------------

function makeCanvas(idSuffix: string): HTMLCanvasElement {
  return el('canvas', { class: 'map', id: `map-${idSuffix}` })
}

function makeMapShell(canvas: HTMLCanvasElement): HTMLElement {
  return el('section', { class: 'map-shell' }, canvas)
}

// ---------------------------------------------------------------------------
// Sketch stage
// ---------------------------------------------------------------------------

const SKETCH_TOOLS: readonly { id: Tool; label: string; desc: string }[] = [
  { id: 'draw-land', label: 'Draw land', desc: 'Stamp a soft land dab onto the mask' },
  { id: 'erase-land', label: 'Erase land', desc: 'Subtract from the mask' },
  { id: 'place-city', label: 'Place city', desc: 'Found a settlement (Worldbuild only)' },
  { id: 'remove-city', label: 'Remove city', desc: 'Remove nearest settlement (Worldbuild only)' },
  { id: 'inspect', label: 'Inspect', desc: 'Read the cell under the cursor' },
  { id: 'none', label: 'Cursor', desc: 'Default cursor (no-op)' },
]

export interface SketchStageRefs {
  readonly root: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly toolButtons: Readonly<Record<Tool, HTMLButtonElement>>
  readonly brushVal: HTMLElement
  readonly planetRadiusVal: HTMLElement
  readonly obliquityVal: HTMLElement
  readonly seaLevelVal: HTMLElement
  readonly thresholdVal: HTMLElement
  readonly critiqueBtn: HTMLButtonElement
}

/** Build the Sketch-stage UI. Buttons fire `app:*` events. */
export function mountSketchStage(state: ShellStateView): SketchStageRefs {
  const root = el('div', { class: 'stage stage-sketch' })

  // Left: tools + brush + strength
  const toolGrid = el('div', { class: 'tool-grid' })
  const toolButtons = {} as Record<Tool, HTMLButtonElement>
  for (const tool of SKETCH_TOOLS) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'tool' + (state.tool === tool.id ? ' active' : ''),
        'data-tool': tool.id,
      },
      tool.label,
      el('small', {}, tool.desc),
    )
    btn.addEventListener('click', () => {
      const detail: ToolChangeDetail = { tool: tool.id }
      fire(APP_EVENTS.TOOL_CHANGE, detail)
    })
    toolButtons[tool.id] = btn
    toolGrid.append(btn)
  }

  const brushVal = el('span', { id: 'brushVal' }, String(state.brushSize))
  const brushSlider = el('input', {
    type: 'range',
    min: 2,
    max: 64,
    value: state.brushSize,
  }) as HTMLInputElement
  brushSlider.addEventListener('input', () => {
    const detail: BrushChangeDetail = { size: Number(brushSlider.value) }
    fire(APP_EVENTS.BRUSH_CHANGE, detail)
  })

  const strengthSlider = el('input', {
    type: 'range',
    min: 1,
    max: 100,
    value: Math.round(state.strength * 100),
  }) as HTMLInputElement
  strengthSlider.addEventListener('input', () => {
    const detail: StrengthChangeDetail = { strength: Number(strengthSlider.value) / 100 }
    fire(APP_EVENTS.STRENGTH_CHANGE, detail)
  })

  const left = el(
    'aside',
    { class: 'panel' },
    el('h2', {}, 'Tools'),
    toolGrid,
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Brush size · ', brushVal),
      brushSlider,
    ),
    el('div', { class: 'slider-row' }, el('label', {}, 'Strength'), strengthSlider),
    el(
      'p',
      { class: 'hint' },
      'Paint the mask. The Critique button commits the mask and runs critique.',
    ),
  )
  root.append(left)

  // Center: canvas
  const canvas = makeCanvas('sketch')
  root.append(makeMapShell(canvas))

  // Right: meta controls + commit button
  const meta = state.meta
  const planetRadiusVal = el('span', { id: 'planetRadiusVal' }, String(meta.planetRadiusKm))
  const planetRadiusSlider = el('input', {
    type: 'range',
    min: 2000,
    max: 50000,
    step: 100,
    value: meta.planetRadiusKm,
  }) as HTMLInputElement
  planetRadiusSlider.addEventListener('input', () => {
    const detail: MetaChangeDetail = { meta: { planetRadiusKm: Number(planetRadiusSlider.value) } }
    fire(APP_EVENTS.META_CHANGE, detail)
  })

  const obliquityVal = el('span', { id: 'obliquityVal' }, String(meta.obliquityDeg))
  const obliquitySlider = el('input', {
    type: 'range',
    min: 0,
    max: 45,
    step: 0.5,
    value: meta.obliquityDeg,
  }) as HTMLInputElement
  obliquitySlider.addEventListener('input', () => {
    const detail: MetaChangeDetail = { meta: { obliquityDeg: Number(obliquitySlider.value) } }
    fire(APP_EVENTS.META_CHANGE, detail)
  })

  const seaLevelVal = el('span', { id: 'seaLevelVal' }, String(meta.seaLevel))
  const seaLevelSlider = el('input', {
    type: 'range',
    min: 0,
    max: 100,
    value: Math.round(meta.seaLevel * 100),
  }) as HTMLInputElement
  seaLevelSlider.addEventListener('input', () => {
    const detail: MetaChangeDetail = {
      meta: { seaLevel: Number(seaLevelSlider.value) / 100 },
    }
    fire(APP_EVENTS.META_CHANGE, detail)
  })

  const thresholdVal = el('span', { id: 'thresholdVal' }, String(meta.threshold))
  const thresholdSlider = el('input', {
    type: 'range',
    min: 0,
    max: 100,
    value: Math.round(meta.threshold * 100),
  }) as HTMLInputElement
  thresholdSlider.addEventListener('input', () => {
    const detail: MetaChangeDetail = {
      meta: { threshold: Number(thresholdSlider.value) / 100 },
    }
    fire(APP_EVENTS.META_CHANGE, detail)
  })

  const critiqueBtn = el('button', { type: 'button', class: 'primary' }, 'Critique')
  critiqueBtn.disabled = !state.maskCommitted || state.isProcessing
  critiqueBtn.addEventListener('click', () => fire(APP_EVENTS.COMMIT_SKETCH))

  const right = el(
    'aside',
    { class: 'panel' },
    el('h2', {}, 'Planet'),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Planet radius (km) · ', planetRadiusVal),
      planetRadiusSlider,
    ),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Obliquity (deg) · ', obliquityVal),
      obliquitySlider,
    ),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Sea level · ', seaLevelVal),
      seaLevelSlider,
    ),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Threshold · ', thresholdVal),
      thresholdSlider,
    ),
    el('p', { class: 'hint' }, 'Meta is locked at Make-sense entry.'),
    critiqueBtn,
  )
  root.append(right)

  return {
    root,
    canvas,
    toolButtons,
    brushVal,
    planetRadiusVal,
    obliquityVal,
    seaLevelVal,
    thresholdVal,
    critiqueBtn,
  }
}

/** Apply state to the Sketch stage UI in place. */
export function updateSketchStage(refs: SketchStageRefs, state: ShellStateView): void {
  for (const tool of SKETCH_TOOLS) {
    refs.toolButtons[tool.id].classList.toggle('active', state.tool === tool.id)
  }
  refs.brushVal.textContent = String(state.brushSize)
  refs.planetRadiusVal.textContent = String(state.meta.planetRadiusKm)
  refs.obliquityVal.textContent = String(state.meta.obliquityDeg)
  refs.seaLevelVal.textContent = String(state.meta.seaLevel)
  refs.thresholdVal.textContent = String(state.meta.threshold)
  refs.critiqueBtn.disabled = !state.maskCommitted || state.isProcessing
}

// ---------------------------------------------------------------------------
// Critique stage
// ---------------------------------------------------------------------------

export interface CritiqueStageRefs {
  readonly root: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly scoreEl: HTMLElement
  readonly issueList: HTMLElement
  readonly makeSenseBtn: HTMLButtonElement
}

/** Build the Critique-stage UI. */
export function mountCritiqueStage(state: ShellStateView): CritiqueStageRefs {
  const root = el('div', { class: 'stage stage-critique' })

  const canvas = makeCanvas('critique')
  root.append(makeMapShell(canvas))

  const scoreEl = el('div', { class: 'score' }, formatScore(state.score))

  const issueList = el('ul', { class: 'issue-list' })
  renderIssues(issueList, state.issues)

  const makeSenseBtn = el(
    'button',
    { type: 'button', class: 'primary' },
    'Make sense',
  )
  makeSenseBtn.disabled = state.score <= 0 || state.isProcessing
  makeSenseBtn.addEventListener('click', () => fire(APP_EVENTS.MAKE_SENSE))

  const right = el(
    'aside',
    { class: 'panel' },
    el('h2', {}, 'Critique'),
    el('p', { class: 'score-label' }, 'Score'),
    scoreEl,
    el('h3', {}, 'Issues'),
    issueList,
    makeSenseBtn,
  )
  root.append(right)

  return { root, canvas, scoreEl, issueList, makeSenseBtn }
}

/** Apply state to the Critique stage UI in place. */
export function updateCritiqueStage(refs: CritiqueStageRefs, state: ShellStateView): void {
  refs.scoreEl.textContent = formatScore(state.score)
  renderIssues(refs.issueList, state.issues)
  refs.makeSenseBtn.disabled = state.score <= 0 || state.isProcessing
}

function formatScore(score: number): string {
  if (score <= 0) return '—'
  return `${Math.round(score * 100)}%`
}

function renderIssues(list: HTMLElement, issues: readonly { id: string; severity: string; title: string }[]): void {
  list.innerHTML = ''
  if (issues.length === 0) {
    list.append(el('li', { class: 'issue-empty' }, 'No issues.'))
    return
  }
  for (const issue of issues) {
    list.append(
      el(
        'li',
        { class: `issue issue-${issue.severity}` },
        el('span', { class: 'issue-title' }, issue.title),
        el('span', { class: 'issue-id' }, issue.id),
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// Make-sense stage
// ---------------------------------------------------------------------------

export interface MakeSenseStageRefs {
  readonly root: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly progressList: HTMLElement
  readonly cancelBtn: HTMLButtonElement
  readonly worldbuildBtn: HTMLButtonElement
}

export function mountMakeSenseStage(state: ShellStateView): MakeSenseStageRefs {
  const root = el('div', { class: 'stage stage-make-sense' })

  const canvas = makeCanvas('make-sense')
  root.append(makeMapShell(canvas))

  const progressList = el('ol', { class: 'progress-list' })
  renderProgress(progressList, state.makeSenseComplete ? MAKE_SENSE_STEPS.length : 0)

  const cancelBtn = el('button', { type: 'button' }, 'Cancel')
  cancelBtn.disabled = !state.isProcessing
  cancelBtn.addEventListener('click', () => fire(APP_EVENTS.CANCEL_MAKE_SENSE))

  const worldbuildBtn = el(
    'button',
    { type: 'button', class: 'primary' },
    'Worldbuild',
  )
  worldbuildBtn.disabled = !state.makeSenseComplete || state.isProcessing
  worldbuildBtn.addEventListener('click', () => fire(APP_EVENTS.WORLDBUILD))

  const right = el(
    'aside',
    { class: 'panel' },
    el('h2', {}, 'Make sense'),
    el('p', { class: 'hint' }, 'Deriving world from the committed mask…'),
    el('h3', {}, 'Pipeline'),
    progressList,
    el('div', { class: 'action-row' }, cancelBtn, worldbuildBtn),
  )
  root.append(right)

  return { root, canvas, progressList, cancelBtn, worldbuildBtn }
}

export function updateMakeSenseStage(refs: MakeSenseStageRefs, state: ShellStateView): void {
  const completed = state.makeSenseComplete ? MAKE_SENSE_STEPS.length : 0
  renderProgress(refs.progressList, completed)
  refs.cancelBtn.disabled = !state.isProcessing
  refs.worldbuildBtn.disabled = !state.makeSenseComplete || state.isProcessing
}

function renderProgress(list: HTMLElement, completedCount: number): void {
  list.innerHTML = ''
  MAKE_SENSE_STEPS.forEach((step, idx) => {
    const cls =
      idx < completedCount ? 'progress-step done' : idx === completedCount ? 'progress-step active' : 'progress-step'
    list.append(el('li', { class: cls }, `${idx + 1}. ${step}`))
  })
}

// ---------------------------------------------------------------------------
// Worldbuild stage
// ---------------------------------------------------------------------------

const WORLDBUILD_TOOLS: readonly { id: Tool; label: string; desc: string }[] = [
  { id: 'place-city', label: 'Place city', desc: 'Found a settlement on a suitable cell' },
  { id: 'remove-city', label: 'Remove city', desc: 'Remove nearest settlement' },
  { id: 'inspect', label: 'Inspect', desc: 'Read the cell under the cursor' },
  { id: 'none', label: 'Cursor', desc: 'Default cursor (no-op)' },
]

export interface WorldbuildStageRefs {
  readonly root: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly toolButtons: Readonly<Record<Tool, HTMLButtonElement>>
  readonly backBtn: HTMLButtonElement
}

export function mountWorldbuildStage(state: ShellStateView): WorldbuildStageRefs {
  const root = el('div', { class: 'stage stage-worldbuild' })

  const toolGrid = el('div', { class: 'tool-grid' })
  const toolButtons = {} as Record<Tool, HTMLButtonElement>
  for (const tool of WORLDBUILD_TOOLS) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'tool' + (state.tool === tool.id ? ' active' : ''),
        'data-tool': tool.id,
      },
      tool.label,
      el('small', {}, tool.desc),
    )
    btn.addEventListener('click', () => {
      const detail: ToolChangeDetail = { tool: tool.id }
      fire(APP_EVENTS.TOOL_CHANGE, detail)
    })
    toolButtons[tool.id] = btn
    toolGrid.append(btn)
  }

  const left = el(
    'aside',
    { class: 'panel' },
    el('h2', {}, 'Tools'),
    toolGrid,
    el(
      'p',
      { class: 'hint' },
      'Worldbuild works on the derived world. Cities persist if you go back to Sketch.',
    ),
  )
  root.append(left)

  const canvas = makeCanvas('worldbuild')
  root.append(makeMapShell(canvas))

  const backBtn = el('button', { type: 'button' }, 'Back to Sketch')
  backBtn.addEventListener('click', () => fire(APP_EVENTS.BACK_TO_SKETCH))

  const citiesCount = state.world ? state.world.cities.length : 0
  const right = el(
    'aside',
    { class: 'panel' },
    el('h2', {}, 'Worldbuild'),
    el('p', { class: 'cities-count' }, `Cities: ${citiesCount}`),
    backBtn,
  )
  root.append(right)

  return { root, canvas, toolButtons, backBtn }
}

export function updateWorldbuildStage(refs: WorldbuildStageRefs, state: ShellStateView): void {
  for (const tool of WORLDBUILD_TOOLS) {
    refs.toolButtons[tool.id].classList.toggle('active', state.tool === tool.id)
  }
  const citiesCount = state.world ? state.world.cities.length : 0
  const countEl = refs.root.querySelector<HTMLElement>('.cities-count')
  if (countEl) countEl.textContent = `Cities: ${citiesCount}`
}

// ---------------------------------------------------------------------------
// Per-stage dispatcher
// ---------------------------------------------------------------------------

export type StageRefs =
  | { readonly stage: 'sketch'; readonly refs: SketchStageRefs }
  | { readonly stage: 'critique'; readonly refs: CritiqueStageRefs }
  | { readonly stage: 'make-sense'; readonly refs: MakeSenseStageRefs }
  | { readonly stage: 'worldbuild'; readonly refs: WorldbuildStageRefs }

/** Mount the stage UI for the given state. */
export function mountStageUI(state: ShellStateView): StageRefs {
  switch (state.stage) {
    case 'sketch':
      return { stage: 'sketch', refs: mountSketchStage(state) }
    case 'critique':
      return { stage: 'critique', refs: mountCritiqueStage(state) }
    case 'make-sense':
      return { stage: 'make-sense', refs: mountMakeSenseStage(state) }
    case 'worldbuild':
      return { stage: 'worldbuild', refs: mountWorldbuildStage(state) }
  }
}

/** Update an already-mounted stage UI in place. */
export function updateStageUI(stage: StageRefs, state: ShellStateView): void {
  switch (stage.stage) {
    case 'sketch':
      updateSketchStage(stage.refs, state)
      return
    case 'critique':
      updateCritiqueStage(stage.refs, state)
      return
    case 'make-sense':
      updateMakeSenseStage(stage.refs, state)
      return
    case 'worldbuild':
      updateWorldbuildStage(stage.refs, state)
      return
  }
}

// ---------------------------------------------------------------------------
// Re-export for callers that want the canonical event names
// ---------------------------------------------------------------------------

export { APP_EVENTS }
