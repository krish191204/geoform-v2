/**
 * DOM scaffolding for the writer shell. Sketch → Make sense → Worldbuild.
 *
 * Persistent regions (mounted once by the shell):
 *   chrome overlays the atlas
 *   map shell fills the page
 *   inspector and tools float on the sheet
 *
 * Per-stage regions swap in the left tools column and the inspector
 * work block. Buttons dispatch `app:*` events; the shell owns state.
 */

import type { City, Layer, Polity, Tool, World } from '../world/types'
import { DEFAULT_META, groupedBiomeLegend } from '../world/types'
import {
  APP_EVENTS,
  STAGE_LABEL,
  STAGE_NUM,
  WRITER_STAGE_ORDER,
  WORLDBUILD_ACT_LABEL,
  WORLDBUILD_ACT_NEXT,
  WORLDBUILD_ACT_NUM,
  WORLDBUILD_ACT_ORDER,
  isSketchNoteTool,
  stageRailTitle,
  type WorldbuildAct,
  type WriterStage,
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
  type InspectorSheetDetail,
  type StrengthChangeDetail,
  type RenamePlaceDetail,
  type GotoCellDetail,
  type WorldbuildActDetail,
} from './stages'
import { accountsConfigured } from '../auth/account'
import type { Account } from '../auth/account'
import { LAYER_CHIPS, SEASON_LAYERS } from './atlas'
import { SETTLEMENT_PORT_LABEL, SETTLEMENT_RANK_LABEL, SETTLEMENT_ROLE_LABEL } from '../sketch/settlements'
import { entrepotHubs, routeDossier, tradeKindForOverlay, TRADE_GOOD_LABEL, MAX_POLITIES } from '../sketch/polities'
import { wondersFor } from './wondersCache'
import { groupWondersByKind, shortWonderName } from '../sketch/wonders'
import { labelLandmasses } from '../sketch/countBigComponents'
import { LANDFORM_OPTIONS, stampLandformAt, type LandformKind } from '../sketch/landforms'
import { hasAnyLand } from './canvas_paint'
import { analogStillDataUri, ANALOG_STILL_CAPTION } from './analogStills'
import { decorateCoachCopy } from './coach'

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
// Keys sheet — shortcuts live on a reference card, not in the writer's head
// ---------------------------------------------------------------------------

const KEYS_DRAW: readonly [string, string][] = [
  ['1', 'Land'],
  ['2', 'Ocean'],
  ['3', 'Mountain'],
  ['4', 'Fill'],
  ['5', 'River'],
  ['6', 'Hills'],
  ['7', 'Forest'],
  ['8', 'Swamp'],
  ['9', 'Town'],
  ['0', 'Wipe'],
]

const KEYS_GENERAL: readonly [string, string][] = [
  ['I', 'Inspect a cell'],
  ['[ ]', 'Brush smaller · larger'],
  ['Shift-drag', 'Straight stroke'],
  ['Scroll', 'Zoom the atlas'],
  ['Space-drag', 'Pan the atlas'],
  ['Drag coach', 'Title moves · left edge resizes · double-click docks'],
  ['⌘Z · ⇧⌘Z', 'Undo · redo'],
  ['Esc', 'Cancel a drop · close · reset view'],
]

function mountKeysSheet(): HTMLElement {
  const drawGrid = el('dl', { class: 'keys-grid keys-grid-tools' })
  for (const [key, what] of KEYS_DRAW) {
    drawGrid.append(el('dt', {}, el('kbd', {}, key)), el('dd', {}, what))
  }
  const generalGrid = el('dl', { class: 'keys-grid' })
  for (const [key, what] of KEYS_GENERAL) {
    generalGrid.append(el('dt', {}, el('kbd', {}, key)), el('dd', {}, what))
  }
  const dismiss = el('button', { type: 'button', class: 'keys-dismiss action-btn' }, 'Close')
  const card = el(
    'div',
    { class: 'keys-card', role: 'document' },
    el('h2', {}, 'Keys'),
    el('p', { class: 'keys-lede' }, 'The pen stays on the map. The other hand does this.'),
    el('h3', {}, 'Sketch tools'),
    drawGrid,
    el('h3', {}, 'Anywhere'),
    generalGrid,
    dismiss,
  )
  const sheet = el(
    'div',
    {
      class: 'keys-sheet',
      hidden: true,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Keyboard shortcuts',
    },
    card,
  )
  dismiss.addEventListener('click', () => {
    sheet.hidden = true
  })
  sheet.addEventListener('click', (ev) => {
    if (ev.target === sheet) sheet.hidden = true
  })
  return sheet
}

// ---------------------------------------------------------------------------
// Chrome (brand + actions + stage rail)
// ---------------------------------------------------------------------------

export interface ChromeRefs {
  readonly root: HTMLElement
  readonly stageButtons: Record<WriterStage, HTMLButtonElement>
  readonly actRail: HTMLElement
  readonly actButtons: Record<WorldbuildAct, HTMLButtonElement>
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
    { type: 'button', class: 'action-btn', title: 'Wipe the canvas back to empty ocean' },
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
  const accountSheet = el(
    'div',
    {
      class: 'account-sheet',
      hidden: true,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Sign in',
    },
    card,
  )

  let mode: AccountSubmitDetail['mode'] = 'in'

  function setMode(next: AccountSubmitDetail['mode']): void {
    mode = next
    modeIn.classList.toggle('active', next === 'in')
    modeUp.classList.toggle('active', next === 'up')
    accountSubmit.textContent = next === 'in' ? 'Sign in' : 'Make account'
    passwordInput.autocomplete = next === 'in' ? 'current-password' : 'new-password'
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      accountSheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    ).filter((node) => !node.hidden && node.closest('[hidden]') == null)
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
  accountSheet.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab' || accountSheet.hidden) return
    const nodes = focusables()
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault()
      first.focus()
    }
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

  const keysBtn = el(
    'button',
    { type: 'button', class: 'action-btn keys-btn', title: 'Keyboard shortcuts' },
    'Keys',
  )
  const keysSheet = mountKeysSheet()
  keysBtn.addEventListener('click', () => {
    keysSheet.hidden = false
    ;(keysSheet.querySelector('.keys-dismiss') as HTMLElement | null)?.focus()
  })
  // Capture phase so an open Keys sheet swallows Escape before the shell's
  // view-map / stamp handlers see it.
  window.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape' || keysSheet.hidden) return
      ev.stopPropagation()
      keysSheet.hidden = true
      keysBtn.focus()
    },
    true,
  )

  const topnav = el(
    'nav',
    { class: 'topnav', 'aria-label': 'Geoform' },
    brand,
    el('p', { class: 'tagline' }, 'Draw land. We turn it into a planet you could point at.'),
    el('div', { class: 'nav-trailing' }, saveBtn, clearSeaBtn, downloadBtn, keysBtn, accountBtn, saveMeta),
  )

  const rail = el('nav', { class: 'ux-stage-rail', 'aria-label': 'Worldbuilding stages' })
  for (const stage of WRITER_STAGE_ORDER) {
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

  const actButtons = {} as ChromeRefs['actButtons']
  const actRail = el('nav', {
    class: 'ux-act-rail',
    'aria-label': 'Worldbuild chapters',
    hidden: true,
  })
  for (const act of WORLDBUILD_ACT_ORDER) {
    const btn = el(
      'button',
      { type: 'button', class: 'ux-act-btn', 'data-act': act },
      el('small', {}, WORLDBUILD_ACT_NUM[act]),
      el('strong', {}, WORLDBUILD_ACT_LABEL[act]),
    )
    btn.addEventListener('click', () => {
      const detail: WorldbuildActDetail = { act }
      fire(APP_EVENTS.WORLDBUILD_ACT_CHANGE, detail)
    })
    actButtons[act] = btn
    actRail.append(btn)
  }

  const root = el('header', { class: 'chrome' }, topnav, rail, actRail, keysSheet)
  if (!accountsConfigured()) unwired.hidden = false
  else unwired.hidden = true
  accountForm.hidden = !accountsConfigured()
  card.querySelector('.account-modes')?.toggleAttribute('hidden', !accountsConfigured())
  setMode('in')
  return {
    root,
    stageButtons,
    actRail,
    actButtons,
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
  for (const stage of WRITER_STAGE_ORDER) {
    const btn = refs.stageButtons[stage]
    const isActive = state.stage === stage || (stage === 'sketch' && state.stage === 'critique')
    const reachable = isActive || STAGES[stage].canEnter(state)
    btn.classList.toggle('active', isActive)
    btn.disabled = !reachable
    btn.title = stageRailTitle(stage, state)
    if (isActive) btn.setAttribute('aria-current', 'step')
    else btn.removeAttribute('aria-current')
  }
  const inWorldbuild = state.stage === 'worldbuild'
  refs.actRail.hidden = !inWorldbuild
  refs.root.classList.toggle('is-worldbuild-chrome', inWorldbuild)
  for (const act of WORLDBUILD_ACT_ORDER) {
    const btn = refs.actButtons[act]
    const isActive = inWorldbuild && state.worldbuildAct === act
    btn.classList.toggle('active', isActive)
    if (isActive) btn.setAttribute('aria-current', 'step')
    else btn.removeAttribute('aria-current')
  }
  refs.clearSeaBtn.disabled = state.isProcessing
  const canDownload = Boolean(state.world || state.mask)
  refs.downloadBtn.disabled = !canDownload
  refs.downloadBtn.hidden = !canDownload
  refs.saveMeta.hidden = refs.saveMeta.textContent === 'No save yet'
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
  readonly viewReset: HTMLButtonElement
  readonly viewEsc: HTMLElement
  readonly layoutBtn: HTMLButtonElement
  readonly stampCursor: HTMLImageElement
  readonly stampHint: HTMLElement
  readonly brushCursor: HTMLElement
  readonly loading: HTMLElement
  readonly hint: HTMLElement
  readonly cartouche: HTMLElement
  /** Zoom-aware km scale bar next to the cartouche. */
  readonly scaleBar: HTMLElement
  readonly zoomCanvas: HTMLCanvasElement
  readonly labelLayer: HTMLElement
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
  const viewReset = el(
    'button',
    { type: 'button', class: 'view-toggle', hidden: true, title: 'Reset atlas pan and zoom' },
    'Reset view',
  )
  viewReset.addEventListener('click', () => fire(APP_EVENTS.RESET_ATLAS_VIEW))
  const hud = el('div', { class: 'map-hud' }, viewAtlas, viewPlanet, viewReset)
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
  // Zoom populating: HD window re-bake sits over the CSS-scaled base canvas;
  // labelLayer carries town names and wonder marks that appear as you zoom.
  const zoomCanvas = el('canvas', { class: 'map-zoom-canvas', 'aria-hidden': 'true', hidden: true }) as HTMLCanvasElement
  const labelLayer = el('div', { class: 'map-labels', 'aria-hidden': 'true' })
  const stampCursor = el('img', {
    class: 'stamp-cursor',
    hidden: true,
    alt: '',
    draggable: 'false',
  }) as HTMLImageElement
  const stampHint = el('div', { class: 'stamp-hint', hidden: true }, 'Drop anywhere on the map · click the picture to shrink · Esc to cancel')
  const brushCursor = el('div', { class: 'brush-cursor', hidden: true, 'aria-hidden': 'true' })
  const toolsSheetBtn = el('button', { type: 'button', class: 'sheet-dock-btn', 'data-sheet': 'tools' }, 'Tools')
  const inspectSheetBtn = el('button', { type: 'button', class: 'sheet-dock-btn', 'data-sheet': 'inspect' }, 'Coach')
  toolsSheetBtn.addEventListener('click', () => {
    const detail: InspectorSheetDetail = { sheet: 'tools' }
    fire(APP_EVENTS.TOGGLE_INSPECTOR, detail)
  })
  inspectSheetBtn.addEventListener('click', () => {
    const detail: InspectorSheetDetail = { sheet: 'inspect' }
    fire(APP_EVENTS.TOGGLE_INSPECTOR, detail)
  })
  const sheetDock = el('div', { class: 'sheet-dock', 'aria-label': 'Panels' }, toolsSheetBtn, inspectSheetBtn)
  const loading = el(
    'div',
    { class: 'loading', id: 'loading', hidden: true },
    el(
      'div',
      { class: 'loading-card' },
      el('p', { class: 'loading-kicker' }, 'Make sense'),
      el('p', { class: 'loading-title' }, 'Grounding the doodle…'),
      el('p', { class: 'loading-note' }, 'Same continents. The geography is being invented.'),
    ),
  )
  const cartouche = el(
    'aside',
    { class: 'map-cartouche', hidden: true, 'aria-label': 'World plate' },
    el('p', { class: 'cartouche-kicker' }, 'Geoform'),
    el('h2', { class: 'cartouche-title' }, 'Working sketch'),
    el('dl', { class: 'cartouche-data' }),
  )
  const scaleBar = el(
    'div',
    { class: 'map-scale', hidden: true, 'aria-label': 'Map scale' },
    el('div', { class: 'map-scale-rule' }),
    el('span', { class: 'map-scale-label' }, ''),
  )
  const hint = el(
    'div',
    { class: 'map-hint', id: 'mapHint' },
    'Drag a picture onto the map. The continent follows. Click it to make it smaller.',
  )

  const plateDock = el('div', { class: 'map-plate-dock' }, cartouche, scaleBar, layoutBtn)

  const root = el(
    'section',
    { class: 'map-shell' },
    canvas,
    zoomCanvas,
    labelLayer,
    globe,
    overlay,
    seasonBar,
    hud,
    plateDock,
    viewEsc,
    stampCursor,
    stampHint,
    brushCursor,
    sheetDock,
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
    viewReset,
    layoutBtn,
    viewEsc,
    stampCursor,
    stampHint,
    brushCursor,
    loading,
    hint,
    cartouche,
    scaleBar,
    zoomCanvas,
    labelLayer,
  }
}

/**
 * Pick a round kilometre length whose on-screen bar is ~80–120 px at the
 * current zoom. Pure helper so shell can call it without remounting chrome.
 */
export function niceScaleKm(pxPerKm: number, targetPx = 96): { km: number; px: number } {
  const candidates = [25, 50, 100, 200, 250, 500, 750, 1000, 1500, 2000, 5000, 10000]
  let best = candidates[0]
  let bestErr = Infinity
  for (const km of candidates) {
    const px = km * pxPerKm
    if (px < 36 || px > 200) continue
    const err = Math.abs(px - targetPx)
    if (err < bestErr) {
      bestErr = err
      best = km
    }
  }
  const px = best * pxPerKm
  if (px < 28 || !Number.isFinite(px)) return { km: best, px: 48 }
  return { km: best, px: Math.min(200, Math.max(36, px)) }
}

/** Atlas layers / inspector climate exist only after Make sense, never on Sketch. */
export function showingDerivedWorld(state: Pick<ShellStateView, 'world' | 'stage'>): boolean {
  return Boolean(state.world) && state.stage !== 'sketch'
}

export function updateMapShell(refs: MapShellRefs, state: ShellStateView): void {
  const derived = showingDerivedWorld(state)
  const hud = refs.viewAtlas.parentElement
  if (hud) hud.hidden = !derived
  refs.viewReset.hidden = true

  if (!derived) {
    refs.overlay.replaceChildren()
    refs.seasonBar.replaceChildren()
    refs.scaleBar.hidden = true
  } else {
    const existing = refs.overlay.querySelectorAll<HTMLButtonElement>('[data-look]')
    if (existing.length !== LAYER_CHIPS.length) {
      refs.overlay.replaceChildren()
      for (const chip of LAYER_CHIPS) {
        const btn = el(
          'button',
          {
            type: 'button',
            class: 'chip' + (state.layer === chip.id ? ' active' : ''),
            'data-look': chip.id,
            title: chip.title,
          },
          chip.label,
        )
        btn.addEventListener('click', () => {
          const detail: LayerChangeDetail = { layer: chip.id }
          fire(APP_EVENTS.LAYER_CHANGE, detail)
        })
        refs.overlay.append(btn)
      }
    } else {
      for (const btn of Array.from(existing)) {
        btn.classList.toggle('active', btn.dataset.look === state.layer)
      }
      refs.overlay.querySelector('.biome-legend')?.remove()
      refs.overlay.querySelector('.layer-caption')?.remove()
    }

    const chip = LAYER_CHIPS.find((c) => c.id === state.layer)
    if (chip) {
      refs.overlay.append(el('p', { class: 'layer-caption' }, chip.caption))
    }

    if (state.layer === 'biome' && state.world) {
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
    if (SEASON_LAYERS.has(state.layer)) {
      for (const season of ['summer', 'winter'] as const) {
        const btn = el(
          'button',
          {
            type: 'button',
            class: 'chip' + (state.season === season ? ' active' : ''),
          },
          season === 'summer' ? 'Summer' : 'Winter',
        )
        btn.addEventListener('click', () => {
          const detail: SeasonChangeDetail = { season }
          fire(APP_EVENTS.SEASON_CHANGE, detail)
        })
        refs.seasonBar.append(btn)
      }
    }
  }

  refs.viewAtlas.classList.toggle('active', state.viewMode === 'atlas')
  refs.viewPlanet.classList.toggle('active', state.viewMode === 'planet')
  refs.viewPlanet.disabled = !derived
  const viewing = state.layoutMode === 'view-map'
  const canViewMap = state.makeSenseComplete && !state.isProcessing
  refs.layoutBtn.setAttribute('data-layout', state.layoutMode)
  refs.layoutBtn.textContent = 'View map'
  refs.layoutBtn.hidden = viewing || !canViewMap
  refs.layoutBtn.disabled = !canViewMap
  refs.layoutBtn.title = canViewMap
    ? 'Full-screen map. Press Escape to return.'
    : 'Ground the doodle first'
  refs.viewEsc.hidden = !viewing
  refs.canvas.hidden = derived && state.viewMode === 'planet'
  refs.globe.hidden = !(derived && state.viewMode === 'planet')
  refs.loading.hidden = !state.isProcessing

  // Cartouche — the atlas plate. Drafting facts on Sketch; the plate legend
  // once the world is grounded. Hidden on empty ocean so first-run stays calm.
  const landCells = landCellCount(state.mask, state.meta.threshold)
  const totalCells = state.meta.width * state.meta.height
  const landPct = totalCells > 0 ? Math.round((landCells / totalCells) * 100) : 0
  const showCartouche = derived || landCells > 0
  refs.cartouche.hidden = !showCartouche
  if (showCartouche) {
    const title = refs.cartouche.querySelector('.cartouche-title')
    if (title) title.textContent = derived ? 'Grounded world' : 'Working sketch'
    const cellKm = (2 * Math.PI * (state.meta.planetRadiusKm > 0 ? state.meta.planetRadiusKm : 6371)) / state.meta.width
    const rows: [string, string][] = [['Land', `${landPct}%`]]
    rows.push(['Cell', `≈${Math.round(cellKm)} km`])
    if (derived) {
      const chipNow = LAYER_CHIPS.find((c) => c.id === state.layer)
      if (chipNow) {
        rows.push([
          'Layer',
          SEASON_LAYERS.has(state.layer) ? `${chipNow.label} · ${state.season}` : chipNow.label,
        ])
      }
      const countries = Array.isArray(state.world?.polities) ? state.world!.polities.length : null
      const towns = Array.isArray(state.world?.cities) ? state.world!.cities.length : null
      if (countries != null && towns != null && (countries > 0 || towns > 0)) {
        rows.push(['Peopled', `${countries} ctry · ${towns} towns`])
      }
      rows.push(['Seed', String(state.meta.seed)])
    } else {
      rows.push(['Seed', String(state.meta.seed)])
      rows.push(['Radius', `${state.meta.planetRadiusKm} km`])
      rows.push(['Tilt', `${state.meta.obliquityDeg}°`])
    }
    const data = refs.cartouche.querySelector('.cartouche-data')
    if (data) {
      data.replaceChildren()
      for (const [k, v] of rows) data.append(el('dt', {}, k), el('dd', {}, v))
    }
  }

  const empty = !hasAnyLand(state.mask, state.meta.threshold)
  const showEmptyHint =
    state.stage === 'sketch' && empty && !state.hasSketchNotes && !isSketchNoteTool(state.tool)
  refs.hint.hidden = !showEmptyHint
  if (showEmptyHint) {
    refs.hint.textContent =
      'Drag a picture onto the map. The continent follows. Click it to make it smaller.'
  }
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

const COACH_TONES = ['coach-info', 'coach-success', 'coach-warn', 'coach-error'] as const
const COACH_SIZE_KEY = 'geoform:coachSize:v1'
export const TOOLS_SIZE_KEY = 'geoform:toolsSize:v1'
const PANEL_MIN_W = 240
const PANEL_MIN_H = 180

function loadPanelSize(key: string): { width: number; height: number } | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown }
    const width = typeof parsed.width === 'number' ? parsed.width : NaN
    const height = typeof parsed.height === 'number' ? parsed.height : NaN
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    return { width, height }
  } catch {
    return null
  }
}

function savePanelSize(key: string, width: number, height: number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ width, height }))
  } catch {
    /* quota / private mode */
  }
}

function applyPanelSize(panel: HTMLElement, width: number, height: number): void {
  const maxW = Math.max(PANEL_MIN_W, window.innerWidth - 24)
  const maxH = Math.max(PANEL_MIN_H, window.innerHeight - 24)
  const w = Math.min(maxW, Math.max(PANEL_MIN_W, Math.round(width)))
  const h = Math.min(maxH, Math.max(PANEL_MIN_H, Math.round(height)))
  panel.style.width = `${w}px`
  panel.style.height = `${h}px`
  panel.style.maxHeight = 'none'
}

export interface PanelChromeOpts {
  readonly dragFrom: readonly HTMLElement[]
  readonly edge: 'left' | 'right'
  readonly sizeKey: string
}

/** Drag the whole card off the map; resize; double-click title or edge to dock/reset. */
export function attachPanelChrome(panel: HTMLElement, opts: PanelChromeOpts): void {
  const saved = loadPanelSize(opts.sizeKey)
  if (saved) applyPanelSize(panel, saved.width, saved.height)

  const xClass = opts.edge === 'left' ? 'inspector-resize-x' : 'tools-resize-x'
  const xyClass = opts.edge === 'left' ? 'inspector-resize-xy' : 'tools-resize-xy'
  const edge = el('button', {
    type: 'button',
    class: `inspector-resize ${xClass}`,
    'aria-label': 'Resize panel width',
    title: 'Drag to change width · double-click to reset',
  })
  const foot = el('button', {
    type: 'button',
    class: 'inspector-resize inspector-resize-y',
    'aria-label': 'Resize panel height',
    title: 'Drag to change height · double-click to reset',
  })
  const corner = el('button', {
    type: 'button',
    class: `inspector-resize ${xyClass}`,
    'aria-label': 'Resize panel',
    title: 'Drag to change size · double-click to reset',
  })
  panel.append(edge, foot, corner)

  let mode: 'x' | 'y' | 'xy' | null = null
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let startW = 0
  let startH = 0
  let startLeft = 0
  let grab: HTMLElement | null = null

  const pid = (e: MouseEvent): number =>
    'pointerId' in e && typeof (e as PointerEvent).pointerId === 'number'
      ? (e as PointerEvent).pointerId
      : 1

  const capture = (node: HTMLElement, e: MouseEvent): void => {
    if (!('pointerId' in e)) return
    try {
      node.setPointerCapture((e as PointerEvent).pointerId)
    } catch {
      /* jsdom / unsupported */
    }
  }

  const release = (node: HTMLElement, e: MouseEvent): void => {
    if (!('pointerId' in e)) return
    try {
      node.releasePointerCapture((e as PointerEvent).pointerId)
    } catch {
      /* already released */
    }
  }

  const onDown = (which: 'x' | 'y' | 'xy') => (e: MouseEvent) => {
    if (e.button !== 0) return
    if (mode) return
    e.preventDefault()
    e.stopPropagation()
    const r = panel.getBoundingClientRect()
    mode = which
    pointerId = pid(e)
    startX = e.clientX
    startY = e.clientY
    startW = r.width
    startH = r.height
    startLeft = r.left
    grab = e.currentTarget as HTMLElement
    panel.classList.add('is-resizing')
    capture(grab, e)
  }

  const onMove = (e: MouseEvent) => {
    if (!mode || pid(e) !== pointerId) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    const growX = opts.edge === 'left' ? -dx : dx
    const w = mode === 'y' ? startW : startW + growX
    const h = mode === 'x' ? startH : startH + dy
    applyPanelSize(panel, w, h)
    if (panel.classList.contains('is-floating') && mode !== 'y' && opts.edge === 'left') {
      const applied = parseFloat(panel.style.width) || w
      panel.style.left = `${startLeft + startW - applied}px`
      panel.style.right = 'auto'
    }
  }

  const onUp = (e: MouseEvent) => {
    if (!mode || pid(e) !== pointerId) return
    mode = null
    pointerId = null
    panel.classList.remove('is-resizing')
    if (grab) release(grab, e)
    grab = null
    const w = parseFloat(panel.style.width)
    const h = parseFloat(panel.style.height)
    if (Number.isFinite(w) && Number.isFinite(h)) savePanelSize(opts.sizeKey, w, h)
  }

  for (const [node, which] of [
    [edge, 'x'],
    [foot, 'y'],
    [corner, 'xy'],
  ] as const) {
    node.addEventListener('pointerdown', onDown(which))
    node.addEventListener('mousedown', onDown(which))
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('pointercancel', onUp)

  const reset = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    panel.style.width = ''
    panel.style.height = ''
    panel.style.maxHeight = ''
    try {
      localStorage.removeItem(opts.sizeKey)
    } catch {
      /* private mode */
    }
  }
  for (const node of [edge, foot, corner]) node.addEventListener('dblclick', reset)

  let floating = false
  let dragging = false
  let dragPointer: number | null = null
  let dragStartX = 0
  let dragStartY = 0
  let origLeft = 0
  let origTop = 0
  let dragGrab: HTMLElement | null = null

  const clamp = (left: number, top: number) => {
    const pad = 8
    const r = panel.getBoundingClientRect()
    const maxL = Math.max(pad, window.innerWidth - r.width - pad)
    const maxT = Math.max(pad, window.innerHeight - r.height - pad)
    return {
      left: Math.max(pad, Math.min(maxL, left)),
      top: Math.max(pad, Math.min(maxT, top)),
    }
  }

  const floatAt = (left: number, top: number) => {
    if (!floating) {
      const r = panel.getBoundingClientRect()
      origLeft = r.left
      origTop = r.top
      panel.classList.add('is-floating')
      floating = true
    }
    const p = clamp(left, top)
    panel.style.left = `${p.left}px`
    panel.style.right = 'auto'
    panel.style.top = `${p.top}px`
  }

  const dockBack = () => {
    if (!floating) return
    panel.classList.remove('is-floating', 'is-dragging')
    panel.style.left = ''
    panel.style.right = ''
    panel.style.top = ''
    floating = false
  }

  const ignoreChrome = (e: Event) => {
    const t = e.target
    return t instanceof Element && Boolean(t.closest('.panel-collapse, .inspector-resize'))
  }

  const onDragDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    if (dragging) return
    if (ignoreChrome(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragGrab = e.currentTarget as HTMLElement
    capture(dragGrab, e)
    dragPointer = pid(e)
    dragging = true
    const r = panel.getBoundingClientRect()
    dragStartX = e.clientX
    dragStartY = e.clientY
    origLeft = r.left
    origTop = r.top
    panel.classList.add('is-dragging')
  }

  const onDragMove = (e: MouseEvent) => {
    if (!dragging || pid(e) !== dragPointer) return
    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY
    if (!floating && Math.hypot(dx, dy) < 4) return
    floatAt(origLeft + dx, origTop + dy)
  }

  const onDragUp = (e: MouseEvent) => {
    if (!dragging || pid(e) !== dragPointer) return
    dragging = false
    dragPointer = null
    panel.classList.remove('is-dragging')
    if (dragGrab) release(dragGrab, e)
    dragGrab = null
  }

  const onDbl = (e: Event) => {
    if (ignoreChrome(e)) return
    e.preventDefault()
    e.stopPropagation()
    dockBack()
  }

  for (const node of opts.dragFrom) {
    node.classList.add('coach-title-drag')
    node.title = node.title || 'Drag to move · double-click to dock'
    node.addEventListener('pointerdown', onDragDown)
    node.addEventListener('mousedown', onDragDown)
    node.addEventListener('pointermove', onDragMove)
    node.addEventListener('pointerup', onDragUp)
    node.addEventListener('pointercancel', onDragUp)
    node.addEventListener('dblclick', onDbl)
  }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('pointerup', onDragUp)
  window.addEventListener('mouseup', onDragUp)
}

export function attachPanelCollapse(panel: HTMLElement, btn: HTMLButtonElement): void {
  const hideLabel = btn.getAttribute('aria-label') ?? 'Hide panel'
  const showLabel = hideLabel.replace(/^Hide\b/, 'Show')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const next = !panel.classList.contains('is-collapsed')
    panel.classList.toggle('is-collapsed', next)
    btn.textContent = next ? 'Show' : 'Hide'
    btn.title = next ? 'Show panel' : 'Hide panel so the map is clear'
    btn.setAttribute('aria-label', next ? showLabel : hideLabel)
  })
}

export function mountInspector(): InspectorRefs {
  const handle = el('button', {
    type: 'button',
    class: 'panel-handle',
    'aria-label': 'Drag gazetteer',
    title: 'Drag to move · double-click to dock',
  })
  const title = el('h2', { class: 'panel-title' }, 'Coach')
  const collapse = el(
    'button',
    {
      type: 'button',
      class: 'panel-collapse',
      title: 'Hide panel so the map is clear',
      'aria-label': 'Hide gazetteer',
    },
    'Hide',
  )
  const head = el('div', { class: 'panel-head' }, handle, title, collapse)
  const coach = el('p', {
    id: 'coach',
    class: 'gazetteer-status coach-info',
    role: 'status',
    'aria-live': 'polite',
  }, 'Drop a continent, or paint land.')
  const workHost = el('div', { id: 'stageWork', class: 'stage-work' })
  const inspect = el('div', { id: 'inspect' })
  inspect.append(
    el('p', { class: 'hint' }, 'Hover the map. After Make sense, this cell is real geography.'),
  )
  const status = el('div', { class: 'status', id: 'status' }, 'Empty ocean.')
  const inspectHead = el('h2', { class: 'inspect-head-label' }, 'Inspect')
  const inspectBlock = el('div', { class: 'inspect-block' }, inspectHead, inspect, status)

  window.addEventListener('coach:message', (ev) => {
    const detail = (ev as CustomEvent).detail as
      | { tone?: string; message?: string; text?: string }
      | undefined
    const tone = detail?.tone ?? 'info'
    const text = detail?.message ?? detail?.text ?? ''
    for (const t of COACH_TONES) coach.classList.remove(t)
    coach.classList.add(`coach-${tone}`)
    coach.textContent = text
  })

  const root = el('aside', { class: 'panel inspector' }, head, coach, workHost, inspectBlock)
  attachPanelCollapse(root, collapse)
  attachPanelChrome(root, { dragFrom: [head], edge: 'left', sizeKey: COACH_SIZE_KEY })
  return { root, coach, workHost, inspect, status }
}


export function updateInspector(refs: InspectorRefs, state: ShellStateView): void {
  const title = refs.root.querySelector('.panel-title')
  if (title) title.textContent = state.stage === 'worldbuild' ? 'Gazetteer' : 'Coach'
  const derived = showingDerivedWorld(state)
  const inspectBlock = refs.root.querySelector('.inspect-block') as HTMLElement | null
  const land = landCellCount(state.mask, state.meta.threshold)
  const sketchReadout =
    state.stage === 'sketch' &&
    (land > 0 || state.hasSketchNotes || isSketchNoteTool(state.tool))
  if (inspectBlock) inspectBlock.hidden = !(derived || sketchReadout)
  if (
    state.stage === 'sketch' &&
    isSketchNoteTool(state.tool) &&
    (!state.inspectHtml || state.inspectHtml.includes('Hover the map'))
  ) {
    refs.inspect.innerHTML = `<p class="hint">${decorateCoachCopy(state.tool)}</p>`
  } else if (state.inspectHtml) {
    refs.inspect.innerHTML = state.inspectHtml
  }
  const total = state.meta.width * state.meta.height
  const pct = total > 0 ? Math.round((land / total) * 100) : 0
  if (derived) {
    refs.status.textContent = `Grounded world · ${pct}% land`
    refs.status.hidden = false
  } else if (sketchReadout) {
    refs.status.textContent =
      land > 0
        ? `Sketch · ${land} land cells (${pct}%) · not geography yet`
        : 'Sketch notes — not geography yet'
    refs.status.hidden = false
  } else {
    refs.status.textContent = 'Empty ocean.'
    refs.status.hidden = true
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

const SKETCH_LAND_TOOLS: readonly { id: Tool; label: string; glyph: string; desc: string; keys?: string }[] = [
  { id: 'draw-land', label: 'Land', glyph: '●', desc: 'Paint continent blobs', keys: '1' },
  { id: 'erase-land', label: 'Ocean', glyph: '≈', desc: 'Erase land back to sea', keys: '2' },
  { id: 'fill-mask', label: 'Fill', glyph: '◌', desc: 'Flip a blob or a lake — not the open ocean', keys: '4' },
]

const SKETCH_NOTE_TOOLS: readonly { id: Tool; label: string; glyph: string; desc: string; keys?: string }[] = [
  { id: 'draw-ridge', label: 'Mountain', glyph: '▲', desc: 'Paint a mountain range — a note, not metres', keys: '3' },
  { id: 'mark-hills', label: 'Hills', glyph: '∩', desc: 'Paint rolling hills — a note, not metres', keys: '6' },
  { id: 'mark-forest', label: 'Forest', glyph: '♣', desc: 'Paint forest cover — a note, not a biome', keys: '7' },
  { id: 'erase-channel', label: 'River', glyph: '∿', desc: 'Paint a river — a note, not a river yet', keys: '5' },
  { id: 'mark-swamp', label: 'Swamp', glyph: '≡', desc: 'Paint marsh — a note, not a biome', keys: '8' },
  { id: 'mark-town', label: 'Town', glyph: '◉', desc: 'Paint a town — a note, not a settlement yet', keys: '9' },
  { id: 'wipe-note', label: 'Wipe', glyph: '✕', desc: 'Erase notes. Land stays.', keys: '0' },
]

const WORLDBUILD_TOOLS: readonly { id: Tool; label: string; desc: string }[] = [
  { id: 'place-city', label: 'Place town', desc: 'Found a settlement on suitable land' },
  { id: 'remove-city', label: 'Raze town', desc: 'Remove nearest settlement' },
  { id: 'claim-land', label: 'Paint border', desc: 'Claim land for the nearest country' },
  { id: 'trace-route', label: 'Trace route', desc: 'Click two towns. Overlay picks caravan or sea lane' },
  { id: 'cut-route', label: 'Cut route', desc: 'Remove the nearest caravan or sea lane' },
  { id: 'inspect', label: 'Inspect', desc: 'Read the cell under the cursor' },
]

function toolsForAct(act: WorldbuildAct): readonly { id: Tool; label: string; desc: string }[] {
  if (act === 'land') return []
  if (act === 'kingdoms') {
    return WORLDBUILD_TOOLS.filter((t) => t.id === 'claim-land' || t.id === 'inspect')
  }
  if (act === 'towns') {
    return WORLDBUILD_TOOLS.filter(
      (t) => t.id === 'place-city' || t.id === 'remove-city' || t.id === 'inspect',
    )
  }
  return WORLDBUILD_TOOLS.filter(
    (t) => t.id === 'trace-route' || t.id === 'cut-route' || t.id === 'inspect',
  )
}

export interface ToolsRefs {
  readonly root: HTMLElement
  readonly stage: ShellStateView['stage']
  readonly plane?: ShellStateView['sketchPlane']
  readonly act?: WorldbuildAct
}

export function mountStageTools(state: ShellStateView): ToolsRefs {
  switch (state.stage) {
    case 'sketch':
      return { root: mountSketchTools(state), stage: 'sketch', plane: state.sketchPlane }
    case 'critique':
      return { root: mountCritiqueTools(), stage: 'critique' }
    case 'make-sense':
      return { root: mountMakeSenseTools(state), stage: 'make-sense' }
    case 'worldbuild':
      return {
        root: mountWorldbuildTools(state),
        stage: 'worldbuild',
        act: state.worldbuildAct,
      }
  }
}

function appendToolButtons(
  grid: HTMLElement,
  tools: readonly { id: Tool; label: string; glyph: string; desc: string; keys?: string }[],
  active: Tool,
): void {
  for (const tool of tools) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'tool tool-icon' + (active === tool.id ? ' active' : ''),
        'data-tool': tool.id,
        title: tool.keys ? `${tool.desc} (${tool.keys})` : tool.desc,
        'aria-label': tool.desc,
      },
      el('span', { class: 'tool-glyph', 'aria-hidden': 'true' }, tool.glyph),
      tool.label,
    )
    btn.addEventListener('click', () => {
      const detail: ToolChangeDetail = { tool: tool.id }
      fire(APP_EVENTS.TOOL_CHANGE, detail)
    })
    grid.append(btn)
  }
}

function mountSketchTools(state: ShellStateView): HTMLElement {
  const landGrid = el('div', { class: 'tool-grid tool-grid-icons' })
  appendToolButtons(landGrid, SKETCH_LAND_TOOLS, state.tool)
  const decorateGrid = el('div', { class: 'tool-grid tool-grid-icons' })
  appendToolButtons(decorateGrid, SKETCH_NOTE_TOOLS, state.tool)

  const brushVal = el('span', { id: 'brushVal' }, String(state.brushSize))
  const brushSlider = el('input', {
    type: 'range',
    min: 2,
    max: 48,
    value: state.brushSize,
    title: 'Brush size. [ smaller, ] larger. Shift-drag a straight stroke.',
  }) as HTMLInputElement
  brushSlider.addEventListener('input', () => {
    const detail: BrushChangeDetail = { size: Number(brushSlider.value) }
    fire(APP_EVENTS.BRUSH_CHANGE, detail)
    brushVal.textContent = String(brushSlider.value)
  })

  const strengthPct = Math.round(state.strength * 100)
  const strengthVal = el('span', { id: 'strengthVal' }, `${strengthPct}%`)
  const strengthSlider = el('input', {
    type: 'range',
    id: 'brushStrength',
    min: 20,
    max: 100,
    step: 5,
    value: strengthPct,
    title: 'How hard the ink writes 0–1. Not metres.',
  }) as HTMLInputElement
  strengthSlider.addEventListener('input', () => {
    const detail: StrengthChangeDetail = { strength: Number(strengthSlider.value) / 100 }
    fire(APP_EVENTS.STRENGTH_CHANGE, detail)
    strengthVal.textContent = `${strengthSlider.value}%`
  })

  const undoBtn = el(
    'button',
    {
      type: 'button',
      class: 'action-btn',
      id: 'undoBtn',
      title: 'Undo the last stroke (Ctrl/⌘ Z)',
      disabled: !state.canUndo,
    },
    'Undo',
  )
  undoBtn.addEventListener('click', () => fire(APP_EVENTS.UNDO))
  const redoBtn = el(
    'button',
    {
      type: 'button',
      class: 'action-btn',
      id: 'redoBtn',
      title: 'Redo (Ctrl/⌘ Shift Z)',
      disabled: !state.canRedo,
    },
    'Redo',
  )
  redoBtn.addEventListener('click', () => fire(APP_EVENTS.REDO))

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

  const tiltVal = el('span', { id: 'planetTiltVal' }, String(state.meta.obliquityDeg))
  const tiltSlider = el('input', {
    type: 'range',
    id: 'planetTilt',
    min: 0,
    max: 45,
    step: 0.5,
    value: state.meta.obliquityDeg,
    title: 'Axial tilt. 0 is no seasons. Earth is 23.5°.',
  }) as HTMLInputElement
  tiltSlider.addEventListener('input', () => {
    const detail: MetaChangeDetail = { meta: { obliquityDeg: Number(tiltSlider.value) } }
    fire(APP_EVENTS.META_CHANGE, detail)
    tiltVal.textContent = String(tiltSlider.value)
  })

  const seedVal = el('span', { id: 'planetSeedVal' }, String(state.meta.seed))
  const shuffleSeed = el(
    'button',
    {
      type: 'button',
      class: 'action-btn',
      id: 'shuffleSeed',
      title: 'Same doodle, different plates and climate after Make sense',
    },
    'Shuffle seed',
  )
  shuffleSeed.addEventListener('click', () => {
    const seed = 1 + Math.floor(Math.random() * 999998)
    const detail: MetaChangeDetail = { meta: { seed } }
    fire(APP_EVENTS.META_CHANGE, detail)
    seedVal.textContent = String(seed)
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
        'aria-label': `Drag ${opt.label} onto the map`,
        title: `${opt.label}. ${opt.desc}. Drag onto the map — the land follows the pointer. Click the picture to shrink the same shape.`,
      },
      thumb,
      el('span', { class: 'style-chip-label' }, opt.label),
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

  const planet = el(
    'details',
    { class: 'planet-size' },
    el('summary', {}, 'Planet size'),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Radius · ', radiusVal, ' km'),
      radiusSlider,
    ),
    el(
      'div',
      { class: 'slider-row' },
      el('label', {}, 'Tilt · ', tiltVal, '°'),
      tiltSlider,
    ),
    el('p', { class: 'seed-row' }, el('span', {}, 'Seed · ', seedVal), shuffleSeed),
    el(
      'p',
      { class: 'hint' },
      'Radius sets how big a cell is. Tilt makes seasons. Shuffle seed keeps your land and invents a different neighbour.',
    ),
  )
  const brushes = el(
    'div',
    {},
    landGrid,
    el('h3', {}, 'Decorate'),
    el(
      'p',
      { class: 'hint' },
      'Mountains, forest, rivers, towns — notes, not geography. Make sense still invents the planet.',
    ),
    decorateGrid,
    el('div', { class: 'tool-row' }, undoBtn, redoBtn),
    el('div', { class: 'slider-row' }, el('label', {}, 'Brush · ', brushVal), brushSlider),
    el('div', { class: 'slider-row' }, el('label', {}, 'Ink · ', strengthVal), strengthSlider),
  )
  return el(
    'div',
    { class: 'tools-inner' },
    el('h2', {}, 'Draw'),
    el('h3', {}, 'Landforms'),
    landformGrid,
    brushes,
    planet,
  )
}

function mountCritiqueTools(): HTMLElement {
  return el(
    'div',
    { class: 'tools-inner' },
    el('h2', {}, 'Make sense'),
    el('p', { class: 'hint' }, 'Ground the doodle from the Coach panel.'),
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
        ? 'Same land, grounded. Switch layers. Hover a cell.'
        : 'Deriving plates, mountains, seasons, rivers, and biomes from the land you painted.',
    ),
  )
}

function mountWorldbuildTools(state: ShellStateView): HTMLElement {
  const act = state.worldbuildAct
  const chapterTools = toolsForAct(act)
  const toolGrid = el('div', { class: 'tool-grid' })
  for (const tool of chapterTools) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'tool' + (state.tool === tool.id ? ' active' : ''),
        'data-tool': tool.id,
        title:
          tool.id === 'claim-land' && state.viewMode === 'planet'
            ? 'Paint borders on the atlas'
            : tool.desc,
        disabled:
          (tool.id === 'claim-land' || tool.id === 'trace-route' || tool.id === 'cut-route') &&
          state.viewMode === 'planet',
      },
      tool.label,
    )
    btn.addEventListener('click', () => {
      const detail: ToolChangeDetail = { tool: tool.id }
      fire(APP_EVENTS.TOOL_CHANGE, detail)
    })
    toolGrid.append(btn)
  }

  const kids: Node[] = [el('h2', {}, WORLDBUILD_ACT_LABEL[act])]
  if (chapterTools.length) kids.push(toolGrid)

  if (act === 'kingdoms') {
    const countVal = el('span', { id: 'polityCountVal' }, String(state.polityCount))
    const countSlider = el('input', {
      type: 'range',
      id: 'polityCount',
      min: 1,
      max: MAX_POLITIES,
      step: 1,
      value: state.polityCount,
    }) as HTMLInputElement
    countSlider.addEventListener('input', () => {
      const detail: PolityCountDetail = { count: Number(countSlider.value) }
      fire(APP_EVENTS.POLITY_COUNT_CHANGE, detail)
      countVal.textContent = String(countSlider.value)
    })
    kids.push(el('div', { class: 'slider-row' }, el('label', {}, 'Countries · ', countVal), countSlider))
    kids.push(el('p', { class: 'hint' }, 'Split the land. Rename in the gazetteer.'))
  }

  if (act === 'land') {
    kids.push(
      el('p', { class: 'hint' }, 'Look at the plate. Layers stay on the map. Hover a cell to inspect.'),
    )
  }

  if (act === 'towns') {
    kids.push(el('p', { class: 'hint' }, 'Found, raze, or rename. Towns sit under their kingdom.'))
  }

  if (act === 'trade') {
    const overlays: readonly { id: 'caravans' | 'sea-lanes'; label: string; title: string }[] = [
      { id: 'caravans', label: 'Caravans', title: 'Overland travel. Width is cargo volume.' },
      { id: 'sea-lanes', label: 'Sea lanes', title: 'Port-to-port travel. Width is cargo volume.' },
    ]
    const overlayRow = el('div', { class: 'overlay-row', 'aria-label': 'Trade overlay' })
    const active = state.worldOverlay === 'sea-lanes' ? 'sea-lanes' : 'caravans'
    for (const o of overlays) {
      const btn = el(
        'button',
        {
          type: 'button',
          class: 'chip' + (active === o.id ? ' active' : ''),
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
    kids.push(overlayRow)
    kids.push(el('p', { class: 'hint' }, 'One overlay. Width is surplus and path cost, not GDP.'))
  }

  const next = WORLDBUILD_ACT_NEXT[act]
  if (next) {
    const nextBtn = el('button', { type: 'button', class: 'primary', 'data-act-next': next.act }, next.label)
    nextBtn.addEventListener('click', () => {
      const detail: WorldbuildActDetail = { act: next.act }
      fire(APP_EVENTS.WORLDBUILD_ACT_CHANGE, detail)
    })
    kids.push(nextBtn)
  }

  const backBtn = el('button', { type: 'button' }, 'Back to Sketch')
  backBtn.addEventListener('click', () => fire(APP_EVENTS.BACK_TO_SKETCH))
  kids.push(backBtn)
  return el('div', { class: 'tools-inner' }, ...kids)
}

export function updateStageTools(refs: ToolsRefs, state: ShellStateView): void {
  if (refs.stage !== state.stage) return
  for (const btn of Array.from(refs.root.querySelectorAll<HTMLButtonElement>('[data-tool]'))) {
    btn.classList.toggle('active', btn.dataset.tool === state.tool)
    if (btn.dataset.tool === 'claim-land' || btn.dataset.tool === 'trace-route' || btn.dataset.tool === 'cut-route') {
      btn.disabled = state.viewMode === 'planet'
      if (state.viewMode === 'planet') btn.title = 'Use the atlas for routes and borders'
    }
  }
  const brushVal = refs.root.querySelector('#brushVal')
  if (brushVal) brushVal.textContent = String(state.brushSize)
  const strengthVal = refs.root.querySelector('#strengthVal')
  if (strengthVal) strengthVal.textContent = `${Math.round(state.strength * 100)}%`
  const strengthSlider = refs.root.querySelector('#brushStrength') as HTMLInputElement | null
  if (strengthSlider) strengthSlider.value = String(Math.round(state.strength * 100))
  const undoBtn = refs.root.querySelector('#undoBtn') as HTMLButtonElement | null
  if (undoBtn) undoBtn.disabled = !state.canUndo
  const redoBtn = refs.root.querySelector('#redoBtn') as HTMLButtonElement | null
  if (redoBtn) redoBtn.disabled = !state.canRedo
  const radiusVal = refs.root.querySelector('#planetRadiusVal')
  if (radiusVal) radiusVal.textContent = String(state.meta.planetRadiusKm)
  const tiltVal = refs.root.querySelector('#planetTiltVal')
  if (tiltVal) tiltVal.textContent = String(state.meta.obliquityDeg)
  const seedVal = refs.root.querySelector('#planetSeedVal')
  if (seedVal) seedVal.textContent = String(state.meta.seed)
  const polityVal = refs.root.querySelector('#polityCountVal')
  if (polityVal) polityVal.textContent = String(state.polityCount)
  const politySlider = refs.root.querySelector('#polityCount') as HTMLInputElement | null
  if (politySlider) politySlider.value = String(state.polityCount)
  for (const btn of Array.from(refs.root.querySelectorAll<HTMLButtonElement>('[data-overlay]'))) {
    btn.classList.toggle('active', btn.dataset.overlay === state.worldOverlay)
  }
  for (const btn of Array.from(refs.root.querySelectorAll<HTMLButtonElement>('[data-sketch-plane]'))) {
    btn.classList.toggle('active', btn.dataset.sketchPlane === state.sketchPlane)
  }
}

// ---------------------------------------------------------------------------
// Inspector stage work (issues, progress, cities)
// ---------------------------------------------------------------------------

export function mountStageWork(state: ShellStateView): HTMLElement {
  switch (state.stage) {
    case 'sketch':
    case 'critique':
      return mountSketchAdvance(state)
    case 'make-sense':
      return mountMakeSenseWork(state)
    case 'worldbuild':
      return mountWorldbuildWork(state)
  }
}

function mountSketchAdvance(state: ShellStateView): HTMLElement {
  const makeSenseBtn = el('button', { type: 'button', class: 'primary', id: 'makeSenseBtn' }, 'Make sense')
  const can = hasAnyLand(state.mask, state.meta.threshold) && !state.isProcessing
  makeSenseBtn.disabled = !can
  makeSenseBtn.title = can ? 'Ground the doodle. Same continents, invented geography.' : 'Paint some land first'
  makeSenseBtn.addEventListener('click', () => fire(APP_EVENTS.MAKE_SENSE))
  return el('div', {}, makeSenseBtn)
}

function mountMakeSenseWork(state: ShellStateView): HTMLElement {
  const worldbuildBtn = el('button', { type: 'button', class: 'primary' }, 'Worldbuild')
  worldbuildBtn.disabled = !state.makeSenseComplete || state.isProcessing
  worldbuildBtn.addEventListener('click', () => fire(APP_EVENTS.WORLDBUILD))
  const cancelBtn = el('button', { type: 'button', class: 'action-btn' }, 'Cancel')
  cancelBtn.hidden = !state.isProcessing
  cancelBtn.addEventListener('click', () => fire(APP_EVENTS.CANCEL_MAKE_SENSE))
  return el('div', {}, cancelBtn, worldbuildBtn)
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
  void state
  return bits.join(' · ')
}

function cellKm(state: ShellStateView): number {
  const circ = 2 * Math.PI * state.meta.planetRadiusKm
  return circ / Math.max(1, state.meta.width)
}

function isFocus(state: ShellStateView, x: number, y: number): boolean {
  return Boolean(state.focusCell && state.focusCell.x === x && state.focusCell.y === y)
}

function goTo(x: number, y: number): void {
  const detail: GotoCellDetail = { x, y }
  fire(APP_EVENTS.GOTO_CELL, detail)
}

function groupPolitiesByLandmass(world: World): { name: string; polities: Polity[] }[] {
  const mask = world.mask
  const width = world.meta?.width ?? 0
  const height = world.meta?.height ?? 0
  if (!mask || !width || mask.length !== width * height) {
    return [{ name: 'The land', polities: [...world.polities] }]
  }
  const labels = labelLandmasses(mask, width, height, world.meta.threshold)
  const groups = new Map<number, Polity[]>()
  const unknown: Polity[] = []
  for (const p of world.polities) {
    const i = p.capitalY * world.meta.width + p.capitalX
    const id = labels.id[i] ?? -1
    if (id < 0) {
      unknown.push(p)
      continue
    }
    const list = groups.get(id)
    if (list) list.push(p)
    else groups.set(id, [p])
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0])
  const out = ordered.map(([id, polities]) => ({ name: labels.name[id] ?? 'Land', polities }))
  if (unknown.length) out.push({ name: 'Unclaimed islets', polities: unknown })
  return out
}

function countryBlock(p: Polity, state: ShellStateView): HTMLElement {
  const country = el('input', {
    type: 'text',
    class: 'place-name',
    value: p.name,
    maxlength: 40,
    'aria-label': 'Country name',
    title: 'The state. Independent of the people who live there.',
  }) as HTMLInputElement
  country.addEventListener('change', () => {
    const detail: RenamePlaceDetail = { kind: 'polity', id: p.id, name: country.value }
    fire(APP_EVENTS.RENAME_PLACE, detail)
  })
  const people = el('input', {
    type: 'text',
    class: 'place-name place-name-people',
    value: p.tradition,
    maxlength: 60,
    'aria-label': 'People name',
    title: 'Who names this country. Landscape analog stays climate, not an ethnicity.',
  }) as HTMLInputElement
  people.addEventListener('change', () => {
    const detail: RenamePlaceDetail = { kind: 'people', id: p.id, name: people.value }
    fire(APP_EVENTS.RENAME_PLACE, detail)
  })
  const sells = p.exports.map((g) => TRADE_GOOD_LABEL[g]).join(', ') || 'little surplus'
  const wants = p.imports.map((g) => TRADE_GOOD_LABEL[g]).join(', ') || 'little want'
  const selected = isFocus(state, p.capitalX, p.capitalY)
  const row = el(
    'div',
    { class: 'country-block' + (selected ? ' is-selected' : ''), 'data-x': p.capitalX, 'data-y': p.capitalY },
    el('div', { class: 'place-fields' }, el('label', {}, 'Country', country), el('label', {}, 'People', people)),
    el(
      'div',
      { class: 'polity-dossier' },
      el('span', { class: 'dossier-chip dossier-land' }, p.analog.label),
      el('span', { class: 'dossier-chip' }, `Sells ${sells}`),
      el('span', { class: 'dossier-chip' }, `Wants ${wants}`),
    ),
  )
  row.addEventListener('click', (e) => {
    if (e.target instanceof HTMLInputElement) return
    goTo(p.capitalX, p.capitalY)
  })
  return row
}

function townRow(city: City, state: ShellStateView): HTMLElement {
  const name = el('input', {
    type: 'text',
    class: 'place-name',
    value: city.name,
    maxlength: 40,
    'aria-label': 'Town name',
    title: 'Rename this town. Auto-placed towns are a first guess.',
  }) as HTMLInputElement
  name.addEventListener('change', () => {
    const detail: RenamePlaceDetail = { kind: 'city', x: city.x, y: city.y, name: name.value }
    fire(APP_EVENTS.RENAME_PLACE, detail)
  })
  const selected = isFocus(state, city.x, city.y)
  const row = el(
    'li',
    { class: 'town-row' + (selected ? ' is-selected' : ''), 'data-x': city.x, 'data-y': city.y },
    name,
    el('span', {}, cityListBlurb(city, state)),
  )
  row.addEventListener('click', (e) => {
    if (e.target instanceof HTMLInputElement) return
    goTo(city.x, city.y)
  })
  return row
}

function mountLandPage(state: ShellStateView): HTMLElement {
  const land = landCellCount(state.mask, state.meta.threshold)
  const total = state.meta.width * state.meta.height
  const pct = total > 0 ? Math.round((land / total) * 100) : 0
  const list = el('div', { class: 'gazetteer-page' })
  list.append(
    el(
      'p',
      { class: 'cities-count' },
      `${pct}% land · ~${Math.round(cellKm(state))} km / cell · seed ${state.meta.seed}`,
    ),
  )
  if (!state.world) {
    list.append(el('p', { class: 'hint' }, 'Ground the doodle first.'))
    return list
  }
  const groups = groupWondersByKind(wondersFor(state.world))
  if (!groups.length) {
    list.append(el('p', { class: 'hint' }, 'No standout wonders on this plate — hover a cell anyway.'))
    return list
  }
  for (const group of groups) {
    const body = el('div', { class: 'wonder-group-body' })
    body.append(el('p', { class: 'wonder-mechanism' }, group.mechanism))
    const places = el('ul', { class: 'wonder-places' })
    for (const w of group.places) {
      const goBtn = el(
        'button',
        { type: 'button', class: 'wonder-goto', title: `Zoom to ${w.name}` },
        shortWonderName(w),
      )
      goBtn.addEventListener('click', () => goTo(w.x, w.y))
      places.append(
        el(
          'li',
          {
            class: 'wonder-place' + (isFocus(state, w.x, w.y) ? ' is-selected' : ''),
            'data-x': w.x,
            'data-y': w.y,
          },
          goBtn,
          el('span', { class: 'wonder-fact' }, w.fact),
          el('span', { class: 'wonder-earth' }, w.earthCousin),
        ),
      )
    }
    body.append(places)
    const open = group.places.some((w) => isFocus(state, w.x, w.y)) || groups.length === 1
    const box = el(
      'details',
      { class: 'gazetteer-fold', open: open ? true : null },
      el('summary', {}, `${group.label} (${group.places.length})`),
      body,
    )
    list.append(box)
  }
  return list
}

function mountKingdomsPage(state: ShellStateView): HTMLElement {
  const world = state.world
  const n = world?.polities.length ?? 0
  const page = el('div', { class: 'gazetteer-page' })
  page.append(el('p', { class: 'cities-count' }, `${n} ${n === 1 ? 'country' : 'countries'}`))
  if (!world || n === 0) {
    page.append(el('p', { class: 'hint' }, 'No countries yet — land may be too harsh to settle.'))
    return page
  }
  const masses = groupPolitiesByLandmass(world)
  let opened = false
  for (const mass of masses) {
    const body = el('div', { class: 'landmass-body' })
    for (const p of mass.polities) {
      const focus = isFocus(state, p.capitalX, p.capitalY)
      const card = el(
        'details',
        { class: 'gazetteer-fold gazetteer-kingdom', open: focus || (!opened && masses.length === 1) ? true : null },
        el('summary', {}, p.name),
        countryBlock(p, state),
      )
      if (focus || (!opened && masses.length === 1)) opened = true
      body.append(card)
    }
    const massOpen = mass.polities.some((p) => isFocus(state, p.capitalX, p.capitalY)) || masses.length === 1
    page.append(
      el(
        'details',
        { class: 'gazetteer-fold gazetteer-landmass', open: massOpen ? true : null },
        el('summary', {}, `${mass.name} · ${mass.polities.length}`),
        body,
      ),
    )
  }
  return page
}

function mountTownsPage(state: ShellStateView): HTMLElement {
  const world = state.world
  const n = world?.cities.length ?? 0
  const page = el('div', { class: 'gazetteer-page' })
  page.append(el('p', { class: 'cities-count' }, `${n} ${n === 1 ? 'town' : 'towns'}`))
  if (!world || n === 0) {
    page.append(el('p', { class: 'hint' }, 'No towns yet — land may be too harsh to settle.'))
    return page
  }
  const byPolity = new Map<number, City[]>()
  const stray: City[] = []
  for (const city of world.cities) {
    const pid = city.polityId ?? -1
    if (pid < 0) {
      stray.push(city)
      continue
    }
    const list = byPolity.get(pid)
    if (list) list.push(city)
    else byPolity.set(pid, [city])
  }
  for (const p of world.polities) {
    const towns = byPolity.get(p.id) ?? []
    const ul = el('ul', { class: 'city-list' })
    for (const city of towns) ul.append(townRow(city, state))
    const open = towns.some((c) => isFocus(state, c.x, c.y))
    page.append(
      el(
        'details',
        { class: 'gazetteer-fold', open: open ? true : null },
        el('summary', {}, `${p.name} · ${towns.length}`),
        ul,
      ),
    )
  }
  if (stray.length) {
    const ul = el('ul', { class: 'city-list' })
    for (const city of stray) ul.append(townRow(city, state))
    page.append(el('details', { class: 'gazetteer-fold', open: true }, el('summary', {}, 'Unclaimed'), ul))
  }
  return page
}

function mountTradePage(state: ShellStateView): HTMLElement {
  const page = el('div', { class: 'gazetteer-page' })
  const overlay = state.worldOverlay === 'sea-lanes' ? 'sea-lanes' : 'caravans'
  const kind = tradeKindForOverlay(overlay)
  const world = state.world
  if (!kind || !world) {
    page.append(el('p', { class: 'hint' }, 'Open trade after towns exist.'))
    return page
  }
  const routes = world.routes.filter((r) => r.kind === kind && r.path.length >= 2)
  const hubs = entrepotHubs(world)
  if (hubs.length) {
    page.append(el('p', { class: 'cities-count' }, `Entrepôts: ${hubs.map((c) => c.name).join(', ')}`))
  }
  page.append(
    el(
      'p',
      { class: 'cities-count' },
      `${routes.length} ${kind === 'sea' ? 'sea lanes' : 'caravans'}`,
    ),
  )
  const list = el('ul', { class: 'city-list' })
  if (!routes.length) {
    list.append(
      el(
        'li',
        { class: 'route-line' },
        kind === 'sea'
          ? 'No sea lanes yet — Trace route between two ports, or found a coastal town.'
          : 'No caravans yet — Trace route between two towns.',
      ),
    )
  } else {
    const ranked = [...routes].sort((a, b) => b.volume - a.volume).slice(0, 12)
    for (const r of ranked) {
      const mid = r.path[Math.floor(r.path.length / 2)]
      const row = el('li', { class: 'route-line', 'data-x': mid?.x ?? 0, 'data-y': mid?.y ?? 0 }, routeDossier(world, r))
      if (mid) {
        row.addEventListener('click', () => goTo(mid.x, mid.y))
        if (isFocus(state, mid.x, mid.y)) row.classList.add('is-selected')
      }
      list.append(row)
    }
  }
  page.append(list)
  return page
}

function mountWorldbuildWork(state: ShellStateView): HTMLElement {
  const act = state.worldbuildAct
  if (act === 'kingdoms') return mountKingdomsPage(state)
  if (act === 'towns') return mountTownsPage(state)
  if (act === 'trade') return mountTradePage(state)
  return mountLandPage(state)
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
  mark?: string | null,
): string {
  const note = mark
    ? `<p class="hint">${mark.charAt(0).toUpperCase()}${mark.slice(1)} note — you placed this. Make sense still invents the geography.</p>`
    : `<p class="hint">Sketch only — elevation and climate do not exist until Make sense.</p>`
  return `
    <div class="inspect-head">
      <strong>${x}, ${y}</strong>
      <span class="pill ${land ? 'land' : 'sea'}">${land ? 'Land' : 'Ocean'}</span>
    </div>
    ${note}
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
    settle?: string
  },
  x: number,
  y: number,
  land: boolean,
  lore?: {
    polity?: string
    analog?: string
    analogId?: import('../world/types').PlaceAnalogId
    because?: string
    tradition?: string
    economy?: string
    mix?: string
    route?: string
    /** Town dossier headline, e.g. "Harbour — sea port, market town". */
    town?: string
    /** Population band, e.g. "≈12,000 people". */
    townPeople?: string
    /** Trade partners line, e.g. "Trades with Seat, Fisherton". */
    townPartners?: string
    /** A natural wonder at this cell. */
    wonder?: string
    /** Real Earth place that formed the same way. */
    wonderEarth?: string
  },
  layer: Layer = 'relief',
): string {
  const oceanRow =
    !land && display.ocean && display.ocean !== '—'
      ? `<dt>Ocean</dt><dd>${display.ocean}</dd>`
      : ''
  const still =
    land && lore?.analogId
      ? `<figure class="analog-still">
          <img src="${analogStillDataUri(lore.analogId)}" alt="" width="160" height="72"/>
          <figcaption>${lore.analog ?? ''}. ${ANALOG_STILL_CAPTION}</figcaption>
        </figure>`
      : ''
  const lead: [string, string][] =
    layer === 'temperature'
      ? [
          ['Summer', display.tempSummer],
          ['Winter', display.tempWinter],
          ['Range', display.tempRange],
        ]
      : layer === 'moisture'
        ? [
            ['Summer moisture', display.moistSummer],
            ['Winter moisture', display.moistWinter],
          ]
        : layer === 'plates'
          ? [['Plate', display.plateId]]
          : layer === 'suitability'
            ? [['Settle', display.settle ?? '—']]
            : layer === 'biome'
              ? [['Biome', display.biome]]
              : [['Elevation', display.elev]]

  const loreRows = [
    lore?.polity ? `<dt>Country</dt><dd>${lore.polity}</dd>` : '',
    lore?.tradition ? `<dt>People</dt><dd>${lore.tradition}</dd>` : '',
    lore?.economy ? `<dt>Trade</dt><dd>${lore.economy}</dd>` : '',
    lore?.mix ? `<dt>Capital</dt><dd>${lore.mix}</dd>` : '',
  ].join('')

  const moistNote =
    layer === 'moisture' ? `<p class="layer-gloss">0 dry, 1 wet; not millimetres.</p>` : ''
  const leadDl = lead.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
  const analogLine = lore?.analog
    ? `<p class="analog-line"><strong>Feels like</strong> ${lore.analog}${lore.because ? ` — ${lore.because}` : ''}</p>`
    : ''
  const routeLine = lore?.route ? `<p class="route-line"><strong>${lore.route}</strong></p>` : ''
  const townBlock = lore?.town
    ? `<div class="town-dossier">
        <p class="town-head"><strong>${lore.town}</strong></p>
        ${lore.townPeople ? `<p class="town-line">${lore.townPeople}</p>` : ''}
        ${lore.townPartners ? `<p class="town-line">${lore.townPartners}</p>` : ''}
      </div>`
    : ''
  const wonderLine = lore?.wonder
    ? `<p class="wonder-inspect"><span class="wonder-mark">✦</span> ${lore.wonder}</p>`
    : ''
  const wonderEarth = lore?.wonderEarth
    ? `<p class="wonder-earth">On Earth this is ${lore.wonderEarth}.</p>`
    : ''

  return `
    <div class="inspect-head">
      <strong>${x}, ${y}</strong>
      <span class="pill ${land ? 'land' : 'sea'}">${land ? 'Land' : 'Ocean'}</span>
    </div>
    ${still}
    ${townBlock}
    ${wonderLine}
    ${wonderEarth}
    ${routeLine}
    ${analogLine}
    ${moistNote}
    <dl>${leadDl}${oceanRow}${loreRows}</dl>
  `
}

export { APP_EVENTS }
export type { Layer }
