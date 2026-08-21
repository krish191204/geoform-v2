/**
 * DOM scaffolding for the 4-stage shell — Geoform 1 chrome, v2 state.
 *
 * Persistent regions (mounted once by the shell):
 *   chrome overlays the atlas
 *   map shell fills the page
 *   inspector and tools float on the sheet
 *
 * Per-stage regions swap in the left tools column and the inspector
 * work block. Buttons dispatch `app:*` events; the shell owns state.
 */

import type { City, Layer, Stage, Tool } from '../world/types'
import { DEFAULT_META, groupedBiomeLegend } from '../world/types'
import {
  APP_EVENTS,
  MAKE_SENSE_STEPS,
  STAGE_LABEL,
  STAGE_NUM,
  STAGE_ORDER,
  STAGES,
  type BrushChangeDetail,
  type LandformDragDetail,
  type LayerChangeDetail,
  type MetaChangeDetail,
  type SeasonChangeDetail,
  type ShellStateView,
  type StageTransitionDetail,
  type ToolChangeDetail,
  type LayoutChangeDetail,
  type OverlayChangeDetail,
  type PolityCountDetail,
  type ViewChangeDetail,
  type AccountSubmitDetail,
} from './stages'
import { accountsConfigured } from '../auth/account'
import type { Account } from '../auth/account'
import { LAYER_CHIPS } from './atlas'
import { SETTLEMENT_PORT_LABEL, SETTLEMENT_RANK_LABEL, SETTLEMENT_ROLE_LABEL } from '../sketch/settlements'
import { economyLine, meltingPotLabel } from '../sketch/polities'
import { LANDFORM_OPTIONS, stampLandformAt, type LandformKind } from '../sketch/landforms'
import { hasAnyLand } from './canvas_paint'
import { gradeCaption, gradeFromScore } from '../critique/main'

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

/** Transparent 1×1 PNG used when the canvas cannot encode. */
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** Transparent PNG silhouette — no names, no navy plate. Scale is display-only. */
export function landformThumbPng(kind: LandformKind): string {
  const tw = 64
  const th = 32
  const mask = new Float32Array(tw * th)
  stampLandformAt(
    mask,
    { ...DEFAULT_META, width: tw, height: th, seed: 11 },
    kind,
    11,
    tw / 2,
    th / 2,
    1,
  )
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 80
  const ctx = canvas.getContext('2d')
  if (!ctx) return TRANSPARENT_PNG
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const cellW = canvas.width / tw
  const cellH = canvas.height / th
  ctx.fillStyle = '#7eae62'
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if (mask[y * tw + x] < 0.5) continue
      ctx.fillRect(x * cellW, y * cellH, cellW + 0.4, cellH + 0.4)
    }
  }
  try {
    const png = canvas.toDataURL('image/png')
    if (png.startsWith('data:image/png')) return png
  } catch {
    /* happy-dom and some test canvases cannot encode PNG */
  }
  return TRANSPARENT_PNG
}

export function paintLandformThumb(
  target: HTMLCanvasElement | HTMLImageElement,
  kind: LandformKind,
  scale = 1,
): void {
  const png = landformThumbPng(kind)
  const k = Math.max(0.28, Math.min(1.4, scale))
  if (target instanceof HTMLImageElement) {
    target.src = png
    target.style.width = `${6 * k}rem`
    target.style.height = `${3 * k}rem`
    return
  }
  const ctx = target.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, target.width, target.height)
  const img = new Image()
  img.onload = () => ctx.drawImage(img, 0, 0, target.width, target.height)
  img.src = png
}

// ---------------------------------------------------------------------------
// Chrome (brand + actions + stage rail)
// ---------------------------------------------------------------------------

export interface ChromeRefs {
  readonly root: HTMLElement
  readonly stageButtons: Record<Stage, HTMLButtonElement>
  readonly saveBtn: HTMLButtonElement
  readonly downloadBtn: HTMLButtonElement
  readonly clearSeaBtn: HTMLButtonElement
  readonly saveMeta: HTMLElement
  readonly accountBtn: HTMLButtonElement
  readonly accountSheet: HTMLElement
  readonly accountStatus: HTMLElement
  readonly accountSubmit: HTMLButtonElement
  readonly accountSignOut: HTMLButtonElement
}

export type AccountChromeView = {
  readonly account: Account | null
  readonly configured: boolean
  readonly busy: boolean
  readonly message: string
}

export function mountChrome(): ChromeRefs {
  const stageButtons = {} as ChromeRefs['stageButtons']

  const brand = el('a', { class: 'brand-lock', href: '/' }, 'Geoform')
  const saveBtn = el('button', { type: 'button', class: 'action-btn' }, 'Save')
  saveBtn.addEventListener('click', () => fire(APP_EVENTS.SAVE))
  const downloadBtn = el(
    'button',
    {
      type: 'button',
      class: 'action-btn',
      title: 'Download JSON — the library until a cloud project exists',
    },
    'Download JSON',
  )
  downloadBtn.addEventListener('click', () => fire(APP_EVENTS.DOWNLOAD))
  const clearSeaBtn = el(
    'button',
    { type: 'button', class: 'primary', title: 'Wipe the canvas back to empty ocean' },
    'Clear sea',
  )
  clearSeaBtn.addEventListener('click', () => fire(APP_EVENTS.CLEAR_SEA))
  const saveMeta = el('span', { class: 'save-meta' }, 'No save yet')
  const accountBtn = el('button', { type: 'button', class: 'action-btn account-btn' }, 'Sign in')

  const emailInput = el('input', {
    type: 'email',
    name: 'email',
    autocomplete: 'username',
    required: true,
    placeholder: 'you@example.com',
  }) as HTMLInputElement
  const passwordInput = el('input', {
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
    minlength: 8,
    placeholder: 'password',
  }) as HTMLInputElement
  const accountSubmit = el('button', { type: 'submit', class: 'primary' }, 'Sign in')
  const accountSignOut = el('button', { type: 'button', class: 'action-btn' }, 'Sign out')
  const accountStatus = el('p', { class: 'account-status', role: 'status' })
  const modeIn = el('button', { type: 'button', class: 'account-mode active', 'data-mode': 'in' }, 'Sign in')
  const modeUp = el('button', { type: 'button', class: 'account-mode', 'data-mode': 'up' }, 'Make account')
  const accountForm = el(
    'form',
    { class: 'account-form' },
    el('label', {}, 'Email', emailInput),
    el('label', {}, 'Password', passwordInput),
    accountSubmit,
  )
  const unwired = el(
    'p',
    { class: 'account-unwired' },
    'This build has no account server. Add VITE_SUPABASE_URL and the publishable key.',
  )
  const signedIn = el(
    'div',
    { class: 'account-signed-in', hidden: true },
    el('p', { class: 'account-who' }),
    accountSignOut,
  )
  const card = el(
    'div',
    { class: 'account-card', role: 'document' },
    el('h2', {}, 'Your account'),
    el('p', { class: 'account-lede' }, 'The map stays in this browser. The account is just you.'),
    el('div', { class: 'account-modes' }, modeIn, modeUp),
    accountForm,
    signedIn,
    unwired,
    accountStatus,
    el('button', { type: 'button', class: 'account-dismiss' }, 'Close'),
  )
  const accountSheet = el('div', { class: 'account-sheet', hidden: true, role: 'dialog', 'aria-label': 'Sign in' }, card)

  let mode: AccountSubmitDetail['mode'] = 'in'

  function setMode(next: AccountSubmitDetail['mode']): void {
    mode = next
    modeIn.classList.toggle('active', next === 'in')
    modeUp.classList.toggle('active', next === 'up')
    accountSubmit.textContent = next === 'in' ? 'Sign in' : 'Make account'
    passwordInput.autocomplete = next === 'in' ? 'current-password' : 'new-password'
  }

  function openSheet(): void {
    accountSheet.hidden = false
    emailInput.focus()
  }

  function closeSheet(): void {
    accountSheet.hidden = true
  }

  accountBtn.addEventListener('click', () => openSheet())
  modeIn.addEventListener('click', () => setMode('in'))
  modeUp.addEventListener('click', () => setMode('up'))
  accountSignOut.addEventListener('click', () => fire(APP_EVENTS.ACCOUNT_SIGN_OUT))
  card.querySelector('.account-dismiss')?.addEventListener('click', () => closeSheet())
  accountSheet.addEventListener('click', (ev) => {
    if (ev.target === accountSheet) closeSheet()
  })
  accountForm.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const detail: AccountSubmitDetail = {
      mode,
      email: emailInput.value,
      password: passwordInput.value,
    }
    fire(APP_EVENTS.ACCOUNT_SUBMIT, detail)
  })

  const topnav = el(
    'nav',
    { class: 'topnav', 'aria-label': 'Geoform' },
    brand,
    el('p', { class: 'tagline' }, 'Draw land. We ground it in geography.'),
    el('div', { class: 'nav-trailing' }, accountBtn, saveBtn, downloadBtn, clearSeaBtn, saveMeta),
  )

  const rail = el('nav', { class: 'ux-stage-rail', 'aria-label': 'Worldbuilding stages' })
  for (const stage of STAGE_ORDER) {
    const btn = el(
      'button',
      { type: 'button', class: 'ux-stage-btn', 'data-stage': stage },
      el('small', {}, STAGE_NUM[stage]),
      el('strong', {}, STAGE_LABEL[stage]),
    )
    btn.addEventListener('click', () => {
      const detail: StageTransitionDetail = { stage }
      fire(APP_EVENTS.STAGE_TRANSITION, detail)
    })
    stageButtons[stage] = btn
    rail.append(btn)
  }

  const root = el('header', { class: 'chrome' }, topnav, rail)
  if (!accountsConfigured()) unwired.hidden = false
  else unwired.hidden = true
  accountForm.hidden = !accountsConfigured()
  card.querySelector('.account-modes')?.toggleAttribute('hidden', !accountsConfigured())
  setMode('in')
  return {
    root,
    stageButtons,
    saveBtn,
    downloadBtn,
    clearSeaBtn,
    saveMeta,
    accountBtn,
    accountSheet,
    accountStatus,
    accountSubmit,
    accountSignOut,
  }
}

export function updateChrome(refs: ChromeRefs, state: ShellStateView): void {
  for (const stage of STAGE_ORDER) {
    const btn = refs.stageButtons[stage]
    const isActive = state.stage === stage
    const reachable = isActive || STAGES[stage].canEnter(state)
    btn.classList.toggle('active', isActive)
    btn.disabled = !reachable
    if (isActive) btn.setAttribute('aria-current', 'step')
    else btn.removeAttribute('aria-current')
  }
  refs.clearSeaBtn.disabled = state.isProcessing
  refs.downloadBtn.disabled = !state.world && !state.mask
}

export function updateAccountChrome(refs: ChromeRefs, view: AccountChromeView): void {
  const configured = view.configured
  const signedIn = Boolean(view.account)
  refs.accountBtn.textContent = signedIn ? view.account!.email : 'Sign in'
  refs.accountBtn.title = signedIn ? view.account!.email : 'Sign in or make an account'
  refs.accountSubmit.disabled = view.busy || !configured
  refs.accountSignOut.disabled = view.busy
  refs.accountStatus.textContent = view.message
  const sheet = refs.accountSheet
  const form = sheet.querySelector('.account-form') as HTMLElement | null
  const modes = sheet.querySelector('.account-modes') as HTMLElement | null
  const unwired = sheet.querySelector('.account-unwired') as HTMLElement | null
  const signedBlock = sheet.querySelector('.account-signed-in') as HTMLElement | null
  const who = sheet.querySelector('.account-who') as HTMLElement | null
  if (form) form.hidden = !configured || signedIn
  if (modes) modes.hidden = !configured || signedIn
  if (unwired) unwired.hidden = configured
  if (signedBlock) signedBlock.hidden = !signedIn
  if (who && view.account) who.textContent = view.account.email
}

// ---------------------------------------------------------------------------
// Map shell
// ---------------------------------------------------------------------------

export interface MapShellRefs {
  readonly root: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly globe: HTMLCanvasElement
  readonly overlay: HTMLElement
  readonly seasonBar: HTMLElement
  readonly viewAtlas: HTMLButtonElement
  readonly viewPlanet: HTMLButtonElement
  readonly layoutBtn: HTMLButtonElement
  readonly viewEsc: HTMLElement
  readonly stampCursor: HTMLImageElement
  readonly stampHint: HTMLElement
  readonly loading: HTMLElement
  readonly hint: HTMLElement
}

export function mountMapShell(): MapShellRefs {
  const canvas = el('canvas', { id: 'map', class: 'map' })
  const globe = el('canvas', { id: 'globe', hidden: true })
  const overlay = el('div', { class: 'map-overlay', id: 'layers' })
  const seasonBar = el('div', { class: 'map-seasons' })
  const viewAtlas = el(
    'button',
    { type: 'button', class: 'view-toggle active', id: 'viewAtlas', title: 'Flat atlas' },
    'Atlas',
  )
  const viewPlanet = el(
    'button',
    { type: 'button', class: 'view-toggle', id: 'viewPlanet', title: 'Rotate the planet', disabled: true },
    'Planet',
  )
  viewAtlas.addEventListener('click', () => {
    const detail: ViewChangeDetail = { view: 'atlas' }
    fire(APP_EVENTS.VIEW_CHANGE, detail)
  })
  viewPlanet.addEventListener('click', () => {
    const detail: ViewChangeDetail = { view: 'planet' }
    fire(APP_EVENTS.VIEW_CHANGE, detail)
  })
  const hud = el('div', { class: 'map-hud' }, viewAtlas, viewPlanet)
  const layoutBtn = el(
    'button',
    {
      type: 'button',
      class: 'layout-toggle',
      'data-layout': 'chrome',
      title: 'Ground the doodle first',
      disabled: true,
    },
    'View map',
  )
  layoutBtn.addEventListener('click', () => {
    if (layoutBtn.disabled) return
    const detail: LayoutChangeDetail = { layout: 'view-map' }
    fire(APP_EVENTS.LAYOUT_CHANGE, detail)
  })
  const viewEsc = el('div', { class: 'map-view-esc', hidden: true }, 'Esc to return')
  const stampCursor = el('img', {
    class: 'stamp-cursor',
    hidden: true,
    alt: '',
    draggable: 'false',
  }) as HTMLImageElement
  const stampHint = el('div', { class: 'stamp-hint', hidden: true }, 'Empty sea until you drop · click the picture to shrink · Esc to cancel')
  const loading = el('div', { class: 'loading', id: 'loading', hidden: true }, 'Grounding the doodle…')
  const hint = el(
    'div',
    { class: 'map-hint', id: 'mapHint' },
    'Drag a picture onto the map. Click it to make it smaller.',
  )

  const root = el(
    'section',
    { class: 'map-shell' },
    canvas,
    globe,
    overlay,
    seasonBar,
    hud,
    layoutBtn,
    viewEsc,
    stampCursor,
    stampHint,
    loading,
    hint,
  )
  return {
    root,
    canvas,
    globe,
    overlay,
    seasonBar,
    viewAtlas,
    viewPlanet,
    layoutBtn,
    viewEsc,
    stampCursor,
    stampHint,
    loading,
    hint,
  }
}

/** Atlas layers / inspector climate exist only after Make sense, never on Sketch. */
export function showingDerivedWorld(state: Pick<ShellStateView, 'world' | 'stage'>): boolean {
  return Boolean(state.world) && state.stage !== 'sketch'
}

export function updateMapShell(refs: MapShellRefs, state: ShellStateView): void {
  const derived = showingDerivedWorld(state)
  refs.overlay.replaceChildren()
  for (const chip of LAYER_CHIPS) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'chip' + (derived && state.layer === chip.id ? ' active' : ''),
        'data-look': chip.id,
        title: chip.title,
        disabled: !derived,
      },
      chip.label,
    )
    btn.addEventListener('click', () => {
      if (!derived) return
      const detail: LayerChangeDetail = { layer: chip.id }
      fire(APP_EVENTS.LAYER_CHANGE, detail)
    })
    refs.overlay.append(btn)
  }

  if (derived && state.layer === 'biome' && state.world) {
    const groups = groupedBiomeLegend(state.world.biome)
    if (groups.length) {
      const legend = el('div', { class: 'biome-legend', 'aria-label': 'Biome legend' })
      for (const group of groups) {
        const row = el('div', { class: 'biome-legend-group' }, el('span', {}, group.label))
        for (const entry of group.entries) {
          row.append(
            el('span', {
              class: 'biome-swatch',
              title: entry.label,
              style: `background:${entry.color}`,
            }),
          )
        }
        legend.append(row)
      }
      refs.overlay.append(legend)
    }
  }

  refs.seasonBar.replaceChildren()
  for (const season of ['summer', 'winter'] as const) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'chip' + (derived && state.season === season ? ' active' : ''),
        disabled: !derived,
      },
      season === 'summer' ? 'Summer' : 'Winter',
    )
    btn.addEventListener('click', () => {
      if (!derived) return
      const detail: SeasonChangeDetail = { season }
      fire(APP_EVENTS.SEASON_CHANGE, detail)
    })
    refs.seasonBar.append(btn)
  }

  refs.viewAtlas.classList.toggle('active', state.viewMode === 'atlas')
  refs.viewPlanet.classList.toggle('active', state.viewMode === 'planet')
  refs.viewPlanet.disabled = !derived
  const viewing = state.layoutMode === 'view-map'
  const canViewMap = state.makeSenseComplete && !state.isProcessing
  refs.layoutBtn.setAttribute('data-layout', state.layoutMode)
  refs.layoutBtn.textContent = 'View map'
  refs.layoutBtn.hidden = viewing
  refs.layoutBtn.disabled = !canViewMap
  refs.layoutBtn.title = canViewMap
    ? 'Full-screen map. Press Escape to return.'
    : 'Ground the doodle first'
  refs.viewEsc.hidden = !viewing
  refs.canvas.hidden = derived && state.viewMode === 'planet'
  refs.globe.hidden = !(derived && state.viewMode === 'planet')
  refs.loading.hidden = !state.isProcessing
  const empty = !hasAnyLand(state.mask, state.meta.threshold)
  refs.hint.hidden = !empty || state.stage !== 'sketch'
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export interface InspectorRefs {
  readonly root: HTMLElement
  readonly coach: HTMLElement
  readonly workHost: HTMLElement
  readonly inspect: HTMLElement
  readonly status: HTMLElement
}

export function mountInspector(): InspectorRefs {
  const coach = el('div', { id: 'coach', class: 'coach-card', role: 'status', 'aria-live': 'polite' })
  coach.append(
    el(
      'p',
      { class: 'coach-empty' },
      'Empty ocean. Drag a picture onto the map, or paint land.',
    ),
  )
  const workHost = el('div', { id: 'stageWork', class: 'stage-work' })
  const inspect = el('div', { id: 'inspect' })
  inspect.append(
    el('p', { class: 'hint' }, 'Hover the map. After Make sense, this cell is real geography.'),
  )
  const status = el('div', { class: 'status', id: 'status' }, 'Empty ocean.')

  window.addEventListener('coach:message', (ev) => {
    const detail = (ev as CustomEvent).detail as
      | { tone?: string; message?: string; text?: string }
      | undefined
    const tone = detail?.tone ?? 'info'
    const text = detail?.message ?? detail?.text ?? ''
    coach.className = `coach-card coach-${tone}`
    coach.replaceChildren(el('p', { class: 'coach-body' }, text))
  })

  const root = el(
    'aside',
    { class: 'panel inspector' },
    el('h2', {}, 'Coach'),
    coach,
    workHost,
    el('h2', {}, 'Inspector'),
    inspect,
    status,
  )
  return { root, coach, workHost, inspect, status }
}

export function updateInspector(refs: InspectorRefs, state: ShellStateView): void {
  const derived = showingDerivedWorld(state)
  if (state.inspectHtml) {
    refs.inspect.innerHTML = state.inspectHtml
  }
  const land = landCellCount(state.mask, state.meta.threshold)
  const total = state.meta.width * state.meta.height
  const pct = total > 0 ? Math.round((land / total) * 100) : 0
  if (derived) {
    refs.status.textContent = `Grounded world · ${pct}% land · ${gradeFromScore(state.score)}`
  } else if (land > 0) {
    refs.status.textContent = `Sketch · ${land} land cells (${pct}%) · not geography yet`
  } else {
    refs.status.textContent = `Empty ocean · ${state.meta.width}×${state.meta.height}`
  }
}

export function landCellCount(mask: Float32Array | null, threshold: number): number {
  if (!mask) return 0
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] >= threshold) n++
  return n
}

// ---------------------------------------------------------------------------
// Left tools (per stage)
// ---------------------------------------------------------------------------

const SKETCH_TOOLS: readonly { id: Tool; label: string; desc: string }[] = [
  { id: 'draw-land', label: 'Land', desc: 'Paint continent blobs' },
  { id: 'erase-land', label: 'Ocean', desc: 'Erase land back to sea' },
  { id: 'inspect', label: 'Inspect', desc: 'Read the cell under the cursor' },
]

const WORLDBUILD_TOOLS: readonly { id: Tool; label: string; desc: string }[] = [
  { id: 'place-city', label: 'Place city', desc: 'Found a settlement on suitable land' },
  { id: 'remove-city', label: 'Remove city', desc: 'Remove nearest settlement' },
  { id: 'claim-land', label: 'Paint border', desc: 'Claim land for the nearest country' },
  { id: 'inspect', label: 'Inspect', desc: 'Read the cell under the cursor' },
]

export interface ToolsRefs {
  readonly root: HTMLElement
  readonly stage: ShellStateView['stage']
}

export function mountStageTools(state: ShellStateView): ToolsRefs {
  switch (state.stage) {
    case 'sketch':
      return { root: mountSketchTools(state), stage: 'sketch' }
    case 'critique':
      return { root: mountCritiqueTools(), stage: 'critique' }
    case 'make-sense':
      return { root: mountMakeSenseTools(state), stage: 'make-sense' }
    case 'worldbuild':
      return { root: mountWorldbuildTools(state), stage: 'worldbuild' }
  }
}

function mountSketchTools(state: ShellStateView): HTMLElement {
  const toolGrid = el('div', { class: 'tool-grid' })
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
    toolGrid.append(btn)
  }

  const brushVal = el('span', { id: 'brushVal' }, String(state.brushSize))
  const brushSlider = el('input', {
    type: 'range',
    min: 2,
    max: 48,
    value: state.brushSize,
  }) as HTMLInputElement
  brushSlider.addEventListener('input', () => {
    const detail: BrushChangeDetail = { size: Number(brushSlider.value) }
    fire(APP_EVENTS.BRUSH_CHANGE, detail)
    brushVal.textContent = String(brushSlider.value)
  })

  const radiusVal = el('span', { id: 'planetRadiusVal' }, String(state.meta.planetRadiusKm))
  const radiusSlider = el('input', {
    type: 'range',
    id: 'planetRadius',
    min: 2000,
    max: 50000,
    step: 1,
    value: state.meta.planetRadiusKm,
  }) as HTMLInputElement
  radiusSlider.addEventListener('input', () => {
    const detail: MetaChangeDetail = { meta: { planetRadiusKm: Number(radiusSlider.value) } }
    fire(APP_EVENTS.META_CHANGE, detail)
    radiusVal.textContent = String(radiusSlider.value)
  })

  const landformGrid = el('div', { class: 'style-grid', 'aria-label': 'Landform pictures. Drag onto the map.' })
  for (const opt of LANDFORM_OPTIONS) {
    const thumb = el('img', {
      class: 'landform-thumb',
      alt: '',
      draggable: 'false',
      src: landformThumbPng(opt.id),
    }) as HTMLImageElement
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'style-chip',
        'data-landform': opt.id,
        'aria-label': `Drag this shape onto the map`,
        title: 'Drag onto empty ocean. Click the picture to shrink the same shape.',
      },
      thumb,
    )
    let dragging = false
    const drag = (phase: LandformDragDetail['phase'], e: PointerEvent) => {
      const detail: LandformDragDetail = {
        kind: opt.id,
        phase,
        clientX: e.clientX,
        clientY: e.clientY,
      }
      fire(APP_EVENTS.LANDFORM_DRAG, detail)
    }
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      dragging = true
      btn.setPointerCapture?.(e.pointerId)
      btn.classList.add('is-dragging')
      drag('start', e)
    })
    btn.addEventListener('pointermove', (e) => {
      if (!dragging) return
      drag('move', e)
    })
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      btn.classList.remove('is-dragging')
      drag('end', e)
    }
    btn.addEventListener('pointerup', endDrag)
    btn.addEventListener('pointercancel', endDrag)
    landformGrid.append(btn)
  }

  const critiqueBtn = el('button', { type: 'button', class: 'primary' }, 'Critique')
  critiqueBtn.disabled = state.isProcessing || !hasAnyLand(state.mask, state.meta.threshold)
  critiqueBtn.addEventListener('click', () => fire(APP_EVENTS.COMMIT_SKETCH))

  return el(
    'div',
    { class: 'tools-inner' },
    el('h2', {}, 'Draw'),
    toolGrid,
    el('h3', {}, 'Landforms'),
    el('p', { class: 'hint' }, 'Drag a picture onto the map. Click the land to make it smaller.'),
    landformGrid,
    el('div', { class: 'slider-row' }, el('label', {}, 'Brush · ', brushVal), brushSlider),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Planet radius · ', radiusVal, ' km'),
      radiusSlider,
    ),
    el(
      'p',
      { class: 'hint' },
      'Make sense derives mountains — do not paint them.',
    ),
    critiqueBtn,
  )
}

function mountCritiqueTools(): HTMLElement {
  return el(
    'div',
    { class: 'tools-inner' },
    el('h2', {}, 'Critique'),
    el(
      'p',
      { class: 'hint' },
      'This is what is wrong with the doodle. Overlays mark the cells. Make sense will ground the shape, not keep the geology you imagined.',
    ),
  )
}

function mountMakeSenseTools(state: ShellStateView): HTMLElement {
  return el(
    'div',
    { class: 'tools-inner' },
    el('h2', {}, 'Make sense'),
    el(
      'p',
      { class: 'hint' },
      state.makeSenseComplete
        ? 'This atlas is the closest geographically honest planet to your sketch. Switch layers. Hover a cell.'
        : 'Deriving plates, mountains, seasons, rivers, and biomes from the land you painted.',
    ),
  )
}

function mountWorldbuildTools(state: ShellStateView): HTMLElement {
  const toolGrid = el('div', { class: 'tool-grid' })
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
    toolGrid.append(btn)
  }

  const countVal = el('span', { id: 'polityCountVal' }, String(state.polityCount))
  const countSlider = el('input', {
    type: 'range',
    id: 'polityCount',
    min: 1,
    max: 12,
    step: 1,
    value: state.polityCount,
  }) as HTMLInputElement
  countSlider.addEventListener('input', () => {
    const detail: PolityCountDetail = { count: Number(countSlider.value) }
    fire(APP_EVENTS.POLITY_COUNT_CHANGE, detail)
    countVal.textContent = String(countSlider.value)
  })

  const overlays: readonly { id: ShellStateView['worldOverlay']; label: string; title: string }[] = [
    { id: 'countries', label: 'Countries', title: 'Borders grown from seats of power' },
    { id: 'caravans', label: 'Caravans', title: 'Overland trade, width is volume' },
    { id: 'sea-lanes', label: 'Sea lanes', title: 'Port-to-port sea trade' },
  ]
  const overlayRow = el('div', { class: 'overlay-row', 'aria-label': 'Worldbuild overlay' })
  for (const o of overlays) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'chip' + (state.worldOverlay === o.id ? ' active' : ''),
        'data-overlay': o.id,
        title: o.title,
      },
      o.label,
    )
    btn.addEventListener('click', () => {
      const detail: OverlayChangeDetail = { overlay: o.id }
      fire(APP_EVENTS.WORLD_OVERLAY_CHANGE, detail)
    })
    overlayRow.append(btn)
  }

  const backBtn = el('button', { type: 'button' }, 'Back to Sketch')
  backBtn.addEventListener('click', () => fire(APP_EVENTS.BACK_TO_SKETCH))
  return el(
    'div',
    { class: 'tools-inner' },
    el('h2', {}, 'Worldbuild'),
    toolGrid,
    el('div', { class: 'slider-row' }, el('label', {}, 'Countries · ', countVal), countSlider),
    overlayRow,
    el(
      'p',
      { class: 'hint' },
      'Drag the slider to split the land. Overlay is one message: countries, caravans, or sea lanes. Trade ink is surplus and path cost, not GDP. Paint a border to claim. Click a capital to read if it is a melting pot.',
    ),
    backBtn,
  )
}

export function updateStageTools(refs: ToolsRefs, state: ShellStateView): void {
  if (refs.stage !== state.stage) return
  for (const btn of Array.from(refs.root.querySelectorAll<HTMLButtonElement>('[data-tool]'))) {
    btn.classList.toggle('active', btn.dataset.tool === state.tool)
  }
  const brushVal = refs.root.querySelector('#brushVal')
  if (brushVal) brushVal.textContent = String(state.brushSize)
  const radiusVal = refs.root.querySelector('#planetRadiusVal')
  if (radiusVal) radiusVal.textContent = String(state.meta.planetRadiusKm)
  const critiqueBtn = Array.from(refs.root.querySelectorAll('button')).find((b) => b.textContent === 'Critique')
  if (critiqueBtn) {
    critiqueBtn.disabled = state.isProcessing || !hasAnyLand(state.mask, state.meta.threshold)
  }
  const polityVal = refs.root.querySelector('#polityCountVal')
  if (polityVal) polityVal.textContent = String(state.polityCount)
  const politySlider = refs.root.querySelector('#polityCount') as HTMLInputElement | null
  if (politySlider) politySlider.value = String(state.polityCount)
  for (const btn of Array.from(refs.root.querySelectorAll<HTMLButtonElement>('[data-overlay]'))) {
    btn.classList.toggle('active', btn.dataset.overlay === state.worldOverlay)
  }
}

// ---------------------------------------------------------------------------
// Inspector stage work (issues, progress, cities)
// ---------------------------------------------------------------------------

export function mountStageWork(state: ShellStateView): HTMLElement {
  switch (state.stage) {
    case 'sketch':
      return el(
        'div',
        {},
        el('p', { class: 'hint' }, 'Drag a picture onto the map. Click the land to shrink it. Critique when the coast looks right.'),
      )
    case 'critique':
      return mountCritiqueWork(state)
    case 'make-sense':
      return mountMakeSenseWork(state)
    case 'worldbuild':
      return mountWorldbuildWork(state)
  }
}

function mountCritiqueWork(state: ShellStateView): HTMLElement {
  const grade = gradeFromScore(state.score)
  const scoreEl = el('div', { class: 'score' }, grade)
  const caption = el('p', { class: 'score-caption' }, gradeCaption(grade))
  const issueList = el('ul', { class: 'issue-list' })
  renderIssues(issueList, state.issues)
  const makeSenseBtn = el('button', { type: 'button', class: 'primary' }, 'Make sense')
  makeSenseBtn.disabled = state.isProcessing || !state.maskCommitted
  makeSenseBtn.addEventListener('click', () => fire(APP_EVENTS.MAKE_SENSE))
  return el(
    'div',
    {},
    el('h3', {}, 'Grade'),
    scoreEl,
    caption,
    el('h3', {}, 'Issues'),
    issueList,
    makeSenseBtn,
  )
}

function mountMakeSenseWork(state: ShellStateView): HTMLElement {
  const progressList = el('ol', { class: 'progress-list' })
  renderProgress(progressList, state.pipelineStep)
  const worldbuildBtn = el('button', { type: 'button', class: 'primary' }, 'Worldbuild')
  worldbuildBtn.disabled = !state.makeSenseComplete || state.isProcessing
  worldbuildBtn.addEventListener('click', () => fire(APP_EVENTS.WORLDBUILD))
  return el('div', {}, el('h3', {}, 'Pipeline'), progressList, worldbuildBtn)
}

function cityListBlurb(city: City, state: ShellStateView): string {
  const bits: string[] = []
  if (city.role) bits.push(SETTLEMENT_ROLE_LABEL[city.role])
  if (city.port && city.port !== 'none') {
    if (city.role !== 'fishing' || city.port === 'river') {
      bits.push(SETTLEMENT_PORT_LABEL[city.port])
    }
  }
  if (city.rank && city.rank !== 'seat') bits.push(SETTLEMENT_RANK_LABEL[city.rank].toLowerCase())
  if (city.oasis) bits.push('oasis')
  if (city.role === 'seat_of_power' && city.meltingPot !== undefined) {
    bits.push(city.meltingPot >= 0.55 ? 'melting pot' : 'provincial')
  }
  const polity = state.world?.polities.find((p) => p.id === city.polityId)
  if (polity) bits.push(polity.analog.label)
  bits.push(`${city.x}, ${city.y}`)
  return bits.join(' · ')
}

function mountWorldbuildWork(state: ShellStateView): HTMLElement {
  const n = state.world ? state.world.cities.length : 0
  const list = el('ul', { class: 'city-list' })
  if (state.world) {
    for (const p of state.world.polities) {
      list.append(
        el(
          'li',
          {},
          el('span', {}, p.name),
          el('span', {}, `${p.analog.label}. ${economyLine(p)} ${meltingPotLabel(p.meltingPot)}`),
        ),
      )
    }
    for (const city of state.world.cities) {
      if (city.role === 'seat_of_power') continue
      list.append(
        el(
          'li',
          {},
          el('span', {}, city.name),
          el('span', {}, cityListBlurb(city, state)),
        ),
      )
    }
  }
  if (n === 0) list.append(el('li', {}, 'No cities yet — land may be too harsh to settle.'))
  const countries = state.world?.polities.length ?? 0
  return el(
    'div',
    {},
    el('p', { class: 'cities-count' }, `Countries: ${countries} · Towns: ${n}`),
    list,
  )
}

function renderIssues(
  list: HTMLElement,
  issues: readonly { id: string; severity: string; title: string; critique?: string }[],
): void {
  list.innerHTML = ''
  if (issues.length === 0) {
    list.append(el('li', { class: 'issue-empty' }, 'No land/water issues. This is still not a geography grade — run Make sense.'))
    return
  }
  for (const issue of issues) {
    list.append(
      el(
        'li',
        { class: `issue issue-${issue.severity}` },
        el('span', { class: 'issue-title' }, issue.title),
        issue.critique
          ? el('span', { class: 'issue-critique' }, issue.critique)
          : '',
        el('span', { class: 'issue-id' }, issue.id),
      ),
    )
  }
}

function renderProgress(list: HTMLElement, completedCount: number): void {
  list.innerHTML = ''
  MAKE_SENSE_STEPS.forEach((step, idx) => {
    const cls =
      idx < completedCount
        ? 'progress-step done'
        : idx === completedCount
          ? 'progress-step active'
          : 'progress-step'
    list.append(el('li', { class: cls }, `${idx + 1}. ${step}`))
  })
}

// ---------------------------------------------------------------------------
// Inspect markup
// ---------------------------------------------------------------------------

export function emptyInspectHint(hasWorld = false): string {
  return hasWorld
    ? `<p class="hint">Hover a cell. This readout is the derived geography.</p>`
    : `<p class="hint">Hover the map. After Make sense, this cell is real geography.</p>`
}

export function sketchInspectHtml(
  x: number,
  y: number,
  land: boolean,
): string {
  return `
    <div class="inspect-head">
      <strong>${x}, ${y}</strong>
      <span class="pill ${land ? 'land' : 'sea'}">${land ? 'Land' : 'Ocean'}</span>
    </div>
    <p class="hint">Sketch only — elevation and climate do not exist until Make sense.</p>
  `
}

export function worldInspectHtml(
  display: {
    elev: string
    plateId: string
    tempSummer: string
    tempWinter: string
    tempRange: string
    moistSummer: string
    moistWinter: string
    biome: string
    ocean?: string
  },
  x: number,
  y: number,
  land: boolean,
  lore?: {
    polity?: string
    analog?: string
    because?: string
    tradition?: string
    economy?: string
    mix?: string
  },
): string {
  const oceanRow =
    !land && display.ocean && display.ocean !== '—'
      ? `
      <dt>Ocean</dt><dd>${display.ocean}</dd>`
      : ''
  const loreRows = lore
    ? `${lore.polity ? `<dt>Country</dt><dd>${lore.polity}</dd>` : ''}
      ${lore.analog ? `<dt>Feels like</dt><dd>${lore.analog}</dd>` : ''}
      ${lore.because ? `<dt>Why</dt><dd>${lore.because}</dd>` : ''}
      ${lore.tradition ? `<dt>People</dt><dd>${lore.tradition}</dd>` : ''}
      ${lore.economy ? `<dt>Trade</dt><dd>${lore.economy}</dd>` : ''}
      ${lore.mix ? `<dt>Capital</dt><dd>${lore.mix}</dd>` : ''}`
    : ''
  return `
    <div class="inspect-head">
      <strong>${x}, ${y}</strong>
      <span class="pill ${land ? 'land' : 'sea'}">${land ? 'Land' : 'Ocean'}</span>
    </div>
    <dl>
      <dt>Elevation</dt><dd>${display.elev}</dd>
      <dt>Plate</dt><dd>${display.plateId}</dd>
      <dt>Summer</dt><dd>${display.tempSummer}</dd>
      <dt>Winter</dt><dd>${display.tempWinter}</dd>
      <dt>Range</dt><dd>${display.tempRange}</dd>
      <dt>Summer moisture</dt><dd>${display.moistSummer}</dd>
      <dt>Winter moisture</dt><dd>${display.moistWinter}</dd>
      <dt>Biome</dt><dd>${display.biome}</dd>${oceanRow}${loreRows}
    </dl>
  `
}

export { APP_EVENTS }
export type { Layer }
