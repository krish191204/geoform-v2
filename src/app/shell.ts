/**
 * Shell: 3-stage writer path. Sketch a mask, Make sense grounds it, Worldbuild sits on top.
 * Critique stays in the factory for silent scoring; it is not a product stage.
 */

import type { EditorState, Layer, WorldOverlay } from '../world/types'
import { DEFAULT_META } from '../world/types'
import {
  APP_EVENTS,
  MAKE_SENSE_STEP_INDEX,
  MAKE_SENSE_STEPS,
  STAGES,
  brushCursorGlyph,
  isSketchInkTool,
  isSketchMaskTool,
  isSketchNoteTool,
  overlayForWorldbuildAct,
  defaultToolForAct,
  actStatusLine,
  paintModeForTool,
  presetBrushForTool,
  sketchPlaneForTool,
  type BrushChangeDetail,
  type LandformDragDetail,
  type LayerChangeDetail,
  type MetaChangeDetail,
  type SeasonChangeDetail,
  type ShellStateView,
  type SketchPlaneDetail,
  type StageTransitionDetail,
  type ToolChangeDetail,
  type ContinentCountDetail,
  type OverlayChangeDetail,
  type PolityCountDetail,
  type LayoutChangeDetail,
  type ViewChangeDetail,
  type AccountSubmitDetail,
  type InspectorSheetDetail,
  type StrengthChangeDetail,
  type RenamePlaceDetail,
  type GotoCellDetail,
  type ContinentFocusDetail,
  type LoreEditDetail,
  type WorldbuildActDetail,
  type WorldbuildAct,
} from './stages'
import {
  emptyInspectHint,
  mountChrome,
  mountInspector,
  mountMapShell,
  mountStageTools,
  mountStageWork,
  paintLandformThumb,
  showingDerivedWorld,
  sketchInspectHtml,
  niceScaleKm,
  updateAccountChrome,
  updateChrome,
  updateInspector,
  updateMapShell,
  updateStageTools,
  worldInspectHtml,
  attachPanelChrome,
  attachPanelCollapse,
  TOOLS_SIZE_KEY,
  type ToolsRefs,
} from './ui'
import { cellFromPointer, createIdleBakeScheduler, paintAtlas, paintCities, paintFeatureNames, paintWorldOverlay } from './atlas'
import { bakeWorldWindowImageData, clientToContainedBitmap, inspectCell } from '../render/draw'
import { wondersFor } from './wondersCache'
import { hasAnyLand } from './canvas_paint'
import { createMaskBrushes, fireCommitHook } from '../sketch/maskBrushes'
import { fillMaskComponent } from '../sketch/fillMask'
import {
  clearMarksWhereMaskChanged,
  emptyMarks,
  markKindLabel,
  markValueForTool,
  noteStampRadius,
  stampSketchMarks,
} from '../sketch/sketchMarks'
import { MaskHistory } from '../world/history'
import { landformStampCopy, stampLandformAt, clampContinentCount, isLandformKind, shrinkLandBlob, landformStampSeed, landBlobContains } from '../sketch/landforms'
import { placeCity, removeNearestCity } from '../sketch/worldbuild'
import { fillContinent, listContinents } from '../sketch/continents'
import {
  inferSettlementRole,
  seedSettlements,
  annotateSettlement,
  formatSettlementPeople,
  SETTLEMENT_PORT_LABEL,
  SETTLEMENT_ROLE_LABEL,
} from '../sketch/settlements'
import {
  analogAt,
  economyLine,
  ensureWorldbuild,
  isSeaPortCity,
  meltingPotLabel,
  nearestPolityId,
  nearestTradeCity,
  paintClaim,
  polityAt,
  refreshWorldbuildAfterPaint,
  defaultPolityCount,
  clampPolityCount,
  removeRouteNearCell,
  routeDossier,
  routeNearCell,
  tradeKindForOverlay,
  traceTradeRoute,
  endpointName,
} from '../sketch/polities'
import {
  makeSenseInline,
  provenanceFromResult,
  worldFromMakeSense,
} from '../pipeline/makeSense'
import { ageContinent, SITE_MIRROR, SITE_SLOT, SITE_SPRING } from '../pipeline/ageLand'
import { critiqueMask, critiqueWorld } from '../critique/main'
import {
  saveMask,
  saveWorld,
  serializeMask,
  serializeWorld,
  downloadWorld,
  downloadMask,
} from '../world/persist'
import { announce as announceCoach } from './coach'
import {
  accountsConfigured,
  loadAccount,
  signInAccount,
  signOutAccount,
  signUpAccount,
  watchAccount,
  type Account,
} from '../auth/account'

/**
 * Minimum on-screen time for the Make sense reveal. Pacing only — the
 * pipeline itself is never slowed. Zero under vitest so tests stay fast.
 */
const GROUND_REVEAL_MIN_MS = import.meta.env.MODE === 'test' ? 0 : 2800

interface ShellFlags {
  mask: Float32Array | null
  maskCommitted: boolean
  makeSenseComplete: boolean
  score: number
  layer: Layer
  season: 'summer' | 'winter'
  pipelineStep: number
  inspectHtml: string
  viewMode: 'atlas' | 'planet'
  layoutMode: 'chrome' | 'view-map'
  continentCount: number
  polityCount: number
  worldbuildAct: WorldbuildAct
  focusCell: { x: number; y: number } | null
  focusContinentId: number | null
  worldOverlay: WorldOverlay
  canUndo: boolean
  canRedo: boolean
  marks: Uint8Array | null
  sketchPlane: import('./stages').SketchPlane
}

interface ShellBundle {
  state: EditorState
  flags: ShellFlags
}

function makeInitialBundle(): ShellBundle {
  const state: EditorState = {
    stage: 'sketch',
    world: null,
    meta: { ...DEFAULT_META },
    tool: 'draw-land',
    brushSize: 22,
    strength: 1,
    issues: [],
    provenance: null,
    isProcessing: false,
  }
  const flags: ShellFlags = {
    mask: null,
    maskCommitted: false,
    makeSenseComplete: false,
    score: 0,
    layer: 'relief',
    season: 'summer',
    pipelineStep: 0,
    inspectHtml: emptyInspectHint(),
    viewMode: 'atlas',
    layoutMode: 'chrome',
    continentCount: 4,
    polityCount: 4,
    worldbuildAct: 'land',
    focusCell: null,
    focusContinentId: null,
    worldOverlay: 'countries',
    canUndo: false,
    canRedo: false,
    marks: null,
    sketchPlane: 'land',
  }
  return { state, flags }
}

function hasAnyMark(marks: Uint8Array | null): boolean {
  if (!marks) return false
  for (let i = 0; i < marks.length; i++) if (marks[i] !== 0) return true
  return false
}

function buildView(bundle: ShellBundle): ShellStateView {
  return {
    ...bundle.state,
    ...bundle.flags,
    hasSketchNotes: hasAnyMark(bundle.flags.marks),
  }
}

/** Dispatch a coach message — kept for pipeline failures without a CoachEvent. */
export function announce(
  tone: 'info' | 'success' | 'warn' | 'error',
  text: string,
): void {
  window.dispatchEvent(
    new CustomEvent('coach:message', { detail: { tone, text, message: text } }),
  )
}

export function mountApp(root: HTMLElement): void {
  const bundle = makeInitialBundle()
  const { state, flags } = bundle
  const { brushes, bindMask } = createMaskBrushes()
  const maskHistory = new MaskHistory()

  function syncHistoryFlags(): void {
    flags.canUndo = maskHistory.canUndo()
    flags.canRedo = maskHistory.canRedo()
  }

  function recordMask(): void {
    if (!flags.mask) return
    maskHistory.push({
      meta: { ...state.meta },
      mask: flags.mask,
      marks: ensureMarks(),
    })
    syncHistoryFlags()
  }

  let sketchAnnouncedLand = false
  function maybeAnnounceSketchLand(): void {
    if (state.stage !== 'sketch') return
    const land = hasAnyLand(flags.mask, state.meta.threshold)
    if (land && !sketchAnnouncedLand) {
      sketchAnnouncedLand = true
      announceCoach({ kind: 'sketch.hasLand' })
    } else if (!land && sketchAnnouncedLand) {
      sketchAnnouncedLand = false
      announceCoach({
        kind: 'sketch.ready',
        width: state.meta.width,
        height: state.meta.height,
        landCells: 0,
      })
    }
  }

  root.classList.add('app', 'is-layout-chrome', 'is-sheet-tools')

  const chrome = mountChrome()
  const map = mountMapShell()
  const inspector = mountInspector()
  const toolsHost = document.createElement('aside')
  toolsHost.className = 'panel tools-panel'
  const toolsHandle = document.createElement('button')
  toolsHandle.type = 'button'
  toolsHandle.className = 'panel-handle'
  toolsHandle.setAttribute('aria-label', 'Drag tools')
  toolsHandle.title = 'Drag to move · double-click to dock'
  const toolsTitle = document.createElement('h2')
  toolsTitle.className = 'panel-title'
  toolsTitle.textContent = 'Draw'
  const toolsCollapse = document.createElement('button')
  toolsCollapse.type = 'button'
  toolsCollapse.className = 'panel-collapse'
  toolsCollapse.textContent = 'Hide'
  toolsCollapse.title = 'Hide panel so the map is clear'
  toolsCollapse.setAttribute('aria-label', 'Hide tools')
  const toolsHead = document.createElement('div')
  toolsHead.className = 'panel-head'
  toolsHead.append(toolsHandle, toolsTitle, toolsCollapse)
  const toolsBody = document.createElement('div')
  toolsBody.className = 'panel-body'
  toolsHost.append(toolsHead, toolsBody)
  attachPanelCollapse(toolsHost, toolsCollapse)
  attachPanelChrome(toolsHost, {
    dragFrom: [toolsHead],
    edge: 'right',
    sizeKey: TOOLS_SIZE_KEY,
  })
  const layout = document.createElement('div')
  layout.className = 'layout'
  layout.append(map.root, toolsHost, inspector.root)
  root.append(chrome.root, layout, chrome.accountSheet)

  let account: Account | null = null
  let accountBusy = false
  let accountMessage = ''

  function paintAccount(): void {
    updateAccountChrome(chrome, {
      account,
      configured: accountsConfigured(),
      busy: accountBusy,
      message: accountMessage,
    })
  }

  paintAccount()
  void loadAccount().then((next) => {
    account = next
    paintAccount()
  })
  watchAccount((next) => {
    account = next
    paintAccount()
  })

  let toolsRefs: ToolsRefs | null = null
  let painting = false
  let stampDrag: {
    kind: import('../sketch/landforms').LandformKind
    snapshot: Float32Array
    stampSeed: number
    scale: number
    originX: number
    originY: number
    lastCell: { x: number; y: number } | null
    armed: boolean
  } | null = null
  let stampEndLock = false
  let stampPreviewRaf = 0
  let stampPreviewCell: { x: number; y: number } | null = null
  let lastStamp: {
    kind: import('../sketch/landforms').LandformKind
    seed: number
    scale: number
    x: number
    y: number
    before: Float32Array
  } | null = null
  let dragOrigin: { x: number; y: number } | null = null
  let paintRaf = 0
  let sketchEpoch = 0
  let strokeNeedsHd = false
  const hdBake = createIdleBakeScheduler()
  const DRAG_HIDE_PX = 10
  let atlasScale = 1
  let atlasPanX = 0
  let atlasPanY = 0
  let atlasPanning: { x: number; y: number } | null = null
  let spaceHeld = false
  let routeAnchor: { x: number; y: number; name: string } | null = null
  const ATLAS_ZOOM_MIN = 1
  const ATLAS_ZOOM_MAX = 6

  function atlasViewIdentity(): boolean {
    return atlasScale === 1 && atlasPanX === 0 && atlasPanY === 0
  }

  function applyAtlasView(): void {
    map.canvas.style.transformOrigin = '0 0'
    map.canvas.style.transform = atlasViewIdentity()
      ? ''
      : `translate(${atlasPanX}px, ${atlasPanY}px) scale(${atlasScale})`
    const derived = showingDerivedWorld(state)
    map.viewReset.hidden =
      flags.viewMode !== 'atlas' || atlasViewIdentity() || !derived
    updateMapLabels()
    updateScaleBar()
    scheduleZoomBake()
  }

  function updateScaleBar(): void {
    const host = map.scaleBar
    if (!showingDerivedWorld(state) || flags.viewMode !== 'atlas' || state.isProcessing) {
      host.hidden = true
      return
    }
    const box = letterboxCss()
    if (!box) {
      host.hidden = true
      return
    }
    const R = state.meta.planetRadiusKm > 0 ? state.meta.planetRadiusKm : 6371
    const cellKm = (2 * Math.PI * R) / state.meta.width
    if (!(cellKm > 0)) {
      host.hidden = true
      return
    }
    const pxPerKm = ((box.w / state.meta.width) * atlasScale) / cellKm
    const { km, px } = niceScaleKm(pxPerKm)
    const rule = host.querySelector('.map-scale-rule') as HTMLElement | null
    const label = host.querySelector('.map-scale-label')
    if (rule) rule.style.width = `${px}px`
    if (label) label.textContent = `${km.toLocaleString('en-US')} km`
    host.hidden = false
  }

  function resetAtlasView(): void {
    atlasScale = 1
    atlasPanX = 0
    atlasPanY = 0
    applyAtlasView()
  }

  function zoomAtlasAt(clientX: number, clientY: number, factor: number): void {
    if (flags.viewMode !== 'atlas') return
    const shell = map.root.getBoundingClientRect()
    const x = clientX - shell.left
    const y = clientY - shell.top
    const next = Math.min(ATLAS_ZOOM_MAX, Math.max(ATLAS_ZOOM_MIN, atlasScale * factor))
    if (next === atlasScale) return
    atlasPanX = x - ((x - atlasPanX) * next) / atlasScale
    atlasPanY = y - ((y - atlasPanY) * next) / atlasScale
    atlasScale = next
    if (atlasScale === 1) {
      atlasPanX = 0
      atlasPanY = 0
    }
    applyAtlasView()
  }

  // --- Zoom populating -------------------------------------------------------
  // Past ZOOM_HD_MIN the CSS-scaled bake goes soft, so once the gesture rests
  // we re-bake just the visible window straight from the fields at screen
  // density, and the label layer fills in names by zoom tier. Memory budget:
  // one reusable overlay canvas, at most ZOOM_MAX_PIXELS per bake, nothing
  // cached across zoom levels.
  const ZOOM_HD_MIN = 1.6
  const ZOOM_BAKE_DELAY_MS = 200
  const ZOOM_MAX_PIXELS = 1_800_000
  const LABEL_TIER_SEAT = 1.35
  const LABEL_TIER_PORT = 2.1
  const LABEL_TIER_ALL = 3
  let zoomBakeTimer: ReturnType<typeof setTimeout> | 0 = 0

  /** Letterbox of the grid inside the canvas, in CSS pixels (pre-transform). */
  function letterboxCss(): { x: number; y: number; w: number; h: number } | null {
    const cssW = map.canvas.offsetWidth
    const cssH = map.canvas.offsetHeight
    if (!cssW || !cssH) return null
    const aspect = state.meta.width / Math.max(1, state.meta.height)
    let w: number
    let h: number
    if (cssW / Math.max(1, cssH) > aspect) {
      h = cssH
      w = Math.max(1, Math.round(cssH * aspect))
    } else {
      w = cssW
      h = Math.max(1, Math.round(cssW / Math.max(1e-6, aspect)))
    }
    return { x: Math.floor((cssW - w) / 2), y: Math.floor((cssH - h) / 2), w, h }
  }

  function scheduleZoomBake(): void {
    if (zoomBakeTimer) clearTimeout(zoomBakeTimer)
    zoomBakeTimer = 0
    map.zoomCanvas.hidden = true
    if (!state.world || !showingDerivedWorld(state) || state.isProcessing) return
    if (flags.viewMode !== 'atlas' || atlasScale < ZOOM_HD_MIN) return
    zoomBakeTimer = setTimeout(() => {
      zoomBakeTimer = 0
      runZoomBake()
    }, ZOOM_BAKE_DELAY_MS)
  }

  function runZoomBake(): void {
    const world = state.world
    if (!world || !showingDerivedWorld(state) || state.isProcessing) return
    if (flags.viewMode !== 'atlas' || atlasScale < ZOOM_HD_MIN) return
    const box = letterboxCss()
    if (!box) return
    const shellW = map.canvas.offsetWidth
    const shellH = map.canvas.offsetHeight
    // Visible viewport in pre-transform canvas coordinates, clipped to the map.
    const vx0 = Math.max((0 - atlasPanX) / atlasScale, box.x)
    const vy0 = Math.max((0 - atlasPanY) / atlasScale, box.y)
    const vx1 = Math.min((shellW - atlasPanX) / atlasScale, box.x + box.w)
    const vy1 = Math.min((shellH - atlasPanY) / atlasScale, box.y + box.h)
    if (vx1 - vx0 < 2 || vy1 - vy0 < 2) return
    const cellsPerPx = state.meta.width / box.w
    const win = {
      x0: (vx0 - box.x) * cellsPerPx,
      y0: (vy0 - box.y) * cellsPerPx,
      w: (vx1 - vx0) * cellsPerPx,
      h: (vy1 - vy0) * cellsPerPx,
    }
    let outW = Math.round((vx1 - vx0) * atlasScale)
    let outH = Math.round((vy1 - vy0) * atlasScale)
    const wanted = outW * outH
    if (wanted > ZOOM_MAX_PIXELS) {
      const k = Math.sqrt(ZOOM_MAX_PIXELS / wanted)
      outW = Math.max(1, Math.round(outW * k))
      outH = Math.max(1, Math.round(outH * k))
    }
    const image = bakeWorldWindowImageData(world, flags.season, flags.layer, win, outW, outH, {
      showRivers: flags.layer === 'relief',
    })
    const zc = map.zoomCanvas
    if (zc.width !== outW || zc.height !== outH) {
      zc.width = outW
      zc.height = outH
    }
    const ctx = zc.getContext('2d')
    if (!ctx) return
    ctx.putImageData(image, 0, 0)
    // Cities and worldbuild ink live on the base canvas, which this overlay
    // covers — repaint them against a synthetic full-grid box so clipping is
    // free and the drawing code stays shared with paintAtlas.
    const sx = outW / win.w
    const sy = outH / win.h
    const gridBox = {
      x: -win.x0 * sx,
      y: -win.y0 * sy,
      w: state.meta.width * sx,
      h: state.meta.height * sy,
    }
    if (world.cities.length > 0) paintCities(ctx, world, gridBox)
    const overlay =
      state.stage === 'worldbuild'
        ? overlayForWorldbuildAct(flags.worldbuildAct, flags.worldOverlay)
        : null
    if (overlay) paintWorldOverlay(ctx, world, gridBox, overlay)
    paintFeatureNames(ctx, world, gridBox, atlasScale)
    zc.style.left = `${atlasPanX + vx0 * atlasScale}px`
    zc.style.top = `${atlasPanY + vy0 * atlasScale}px`
    zc.style.width = `${(vx1 - vx0) * atlasScale}px`
    zc.style.height = `${(vy1 - vy0) * atlasScale}px`
    zc.hidden = false
  }

  /** Town names and wonder marks populate the map as the writer zooms in. */
  function updateMapLabels(): void {
    const host = map.labelLayer
    const world = state.world
    if (
      !world ||
      !showingDerivedWorld(state) ||
      flags.viewMode !== 'atlas' ||
      state.isProcessing ||
      atlasScale < LABEL_TIER_SEAT
    ) {
      host.replaceChildren()
      return
    }
    const box = letterboxCss()
    if (!box) {
      host.replaceChildren()
      return
    }
    const s = atlasScale
    const cellW = box.w / state.meta.width
    const cellH = box.h / state.meta.height
    const nodes: HTMLElement[] = []
    const place = (node: HTMLElement, cx: number, cy: number): void => {
      node.style.left = `${atlasPanX + (box.x + cx * cellW) * s}px`
      node.style.top = `${atlasPanY + (box.y + cy * cellH) * s}px`
    }
    for (const city of world.cities) {
      const isPort = Boolean(city.port && city.port !== 'none')
      const tier =
        city.role === 'seat_of_power'
          ? LABEL_TIER_SEAT
          : city.role === 'trade' || isPort
            ? LABEL_TIER_PORT
            : LABEL_TIER_ALL
      if (s < tier) continue
      const node = document.createElement('div')
      node.className =
        city.role === 'seat_of_power' ? 'map-label map-label-seat' : 'map-label map-label-town'
      node.textContent = city.name
      node.title = 'Click to rename'
      node.contentEditable = 'true'
      node.spellcheck = false
      node.setAttribute('role', 'textbox')
      node.setAttribute('aria-label', `Rename ${city.name}`)
      // Keep strokes / pan from stealing the rename gesture.
      node.addEventListener('pointerdown', (e) => e.stopPropagation())
      node.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true })
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          node.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          node.textContent = city.name
          node.blur()
        }
      })
      node.addEventListener('blur', () => {
        const next = (node.textContent ?? '').trim().slice(0, 40)
        if (!next || next === city.name) {
          node.textContent = city.name
          return
        }
        const detail: RenamePlaceDetail = {
          kind: 'city',
          name: next,
          x: city.x,
          y: city.y,
        }
        window.dispatchEvent(new CustomEvent(APP_EVENTS.RENAME_PLACE, { detail }))
      })
      place(node, city.x + 0.5, city.y + 0.5)
      nodes.push(node)
    }
    for (const wonder of wondersFor(world)) {
      const node = document.createElement('div')
      node.className = 'map-label map-label-wonder'
      const mark = document.createElement('span')
      mark.className = 'wonder-mark'
      mark.textContent = '✦'
      node.append(mark)
      if (s >= LABEL_TIER_PORT) node.append(document.createTextNode(wonder.name))
      node.title = `${wonder.blurb} ${wonder.futures} On Earth: ${wonder.earthCousin}`
      place(node, wonder.x + 0.5, wonder.y + 0.5)
      nodes.push(node)
    }
    host.replaceChildren(...nodes)
  }

  function bumpSketchEpoch(): void {
    sketchEpoch++
  }

  function beginPointerStroke(clientX: number, clientY: number): void {
    painting = true
    hdBake.cancel()
    dragOrigin = { x: clientX, y: clientY }
  }

  function hideChromeIfDragging(clientX: number, clientY: number): void {
    if (stampDrag || flags.layoutMode === 'view-map' || flags.makeSenseComplete) return
    if (state.stage !== 'sketch') return
    if (!isSketchInkTool(state.tool)) return
    if (!painting || !dragOrigin) return
    const dx = clientX - dragOrigin.x
    const dy = clientY - dragOrigin.y
    if (dx * dx + dy * dy < DRAG_HIDE_PX * DRAG_HIDE_PX) return
    root.classList.add('is-doodling')
  }

  function setStampCursor(clientX: number, clientY: number, onMap: boolean): void {
    const live = Boolean(stampDrag && onMap)
    map.stampCursor.hidden = !stampDrag || live
    map.stampHint.hidden = !stampDrag
    root.classList.toggle('is-stamping', Boolean(stampDrag))
    if (!stampDrag || live) return
    const w = map.stampCursor.offsetWidth || 96
    const h = map.stampCursor.offsetHeight || 48
    map.stampCursor.style.left = `${clientX - w / 2}px`
    map.stampCursor.style.top = `${clientY - h / 2}px`
  }

  function clearStampDrag(): void {
    if (stampPreviewRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(stampPreviewRaf)
    }
    stampPreviewRaf = 0
    stampPreviewCell = null
    stampDrag = null
    map.stampCursor.hidden = true
    map.stampHint.hidden = true
    root.classList.remove('is-stamping')
  }

  function endPointerStroke(): void {
    painting = false
    dragOrigin = null
    root.classList.remove('is-doodling')
  }
  let planet: import('../render/globe').PlanetView | null = null
  let planetLoad: Promise<import('../render/globe').PlanetView | null> | null = null
  let planetLayout = { w: 0, h: 0 }
  let planetPaintGen = 0

  function syncLayoutClasses(): void {
    root.classList.toggle('is-view-map', flags.layoutMode === 'view-map')
    root.classList.toggle('is-layout-chrome', flags.layoutMode === 'chrome')
  }

  function exitViewMap(): void {
    if (flags.layoutMode !== 'view-map') return
    flags.layoutMode = 'chrome'
    syncLayoutClasses()
    updateMapShell(map, buildView(bundle))
    applyAtlasView()
  }

  async function ensurePlanet(): Promise<import('../render/globe').PlanetView | null> {
    if (planet) return planet
    if (planetLoad) return planetLoad
    planetLoad = import('../render/globe').then(({ PlanetView }) => {
      planet = new PlanetView(map.globe)
      planetLoad = null
      return planet
    })
    return planetLoad
  }

  function layoutPlanet(): void {
    if (!planet) return
    const parent = map.globe.parentElement
    const w = Math.max(1, parent?.clientWidth ?? map.globe.clientWidth ?? 0)
    const h = Math.max(1, parent?.clientHeight ?? map.globe.clientHeight ?? 0)
    if (w === planetLayout.w && h === planetLayout.h) return
    planetLayout = { w, h }
    planet.layout()
  }

  function render(opts: { remount?: boolean } = {}): void {
    const view = buildView(bundle)
    syncLayoutClasses()
    updateChrome(chrome, view)
    updateMapShell(map, view)
    updateInspector(inspector, view)
    applyAtlasView()
    const remount =
      opts.remount ||
      !toolsRefs ||
      toolsRefs.stage !== state.stage ||
      toolsRefs.act !== view.worldbuildAct
    if (remount) {
      toolsRefs = mountStageTools(view)
      toolsBody.replaceChildren(toolsRefs.root)
      const innerTitle = toolsRefs.root.querySelector('h2')
      if (innerTitle) {
        toolsTitle.textContent = innerTitle.textContent || 'Tools'
        innerTitle.hidden = true
      }
      inspector.workHost.replaceChildren(mountStageWork(view))
    } else {
      updateStageTools(toolsRefs, view)
      inspector.workHost.replaceChildren(mountStageWork(view))
    }
    requestPaint()
  }

  function requestPaint(): void {
    if (paintRaf) return
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0
      paintNow()
    })
  }

  function paintNow(): void {
    const showWorld = showingDerivedWorld(state)
    if (flags.viewMode === 'planet' && showWorld && state.world) {
      const gen = ++planetPaintGen
      const layer = flags.layer
      const season = flags.season
      const src = state.world
      const dirty = `${src.meta.seed}|${src.meta.width}|${src.cities.length}|${layer}|${season}`
      void (async () => {
        const view = await ensurePlanet()
        if (!view || planetPaintGen !== gen || flags.viewMode !== 'planet' || state.world !== src) return
        layoutPlanet()
        view.sync(src, layer, season, dirty)
        view.render()
      })()
      return
    }
    paintAtlas(map.canvas, {
      world: showWorld ? state.world : null,
      mask: flags.mask,
      meta: state.meta,
      layer: flags.layer,
      season: flags.season,
      issues: state.stage === 'critique' ? state.issues : [],
      showCities: Boolean(showWorld && state.world && state.world.cities.length > 0),
      preview: (painting || hdBake.pending) && !showWorld && !stampDrag,
      sketchEpoch,
      worldOverlay:
        state.stage === 'worldbuild'
          ? overlayForWorldbuildAct(flags.worldbuildAct, flags.worldOverlay)
          : null,
      marks: showWorld ? null : flags.marks,
      zoom: 1,
    })
  }

  function ensureMask(): Float32Array {
    if (!flags.mask) {
      flags.mask = new Float32Array(state.meta.width * state.meta.height)
      flags.marks = emptyMarks(state.meta.width * state.meta.height)
      bindMask(flags.mask)
      bumpSketchEpoch()
      maskHistory.clear()
      recordMask()
    }
    return flags.mask
  }

  function deferSketchHd(): void {
    if (showingDerivedWorld(state) || stampDrag) return
    hdBake.afterStroke(() => requestPaint())
  }

  function ensureMarks(): Uint8Array {
    const n = state.meta.width * state.meta.height
    if (!flags.marks || flags.marks.length !== n) flags.marks = emptyMarks(n)
    return flags.marks
  }

  function invalidateDerivedWorld(): void {
    if (!state.world && !flags.makeSenseComplete) return
    state.world = null
    state.provenance = null
    flags.makeSenseComplete = false
    flags.pipelineStep = 0
    flags.maskCommitted = false
    flags.score = 0
    flags.viewMode = 'atlas'
    state.issues = []
  }

  /**
   * People line for the inspector. Uses the stored count and cause when the
   * town was scored. Older saves without a count fall back to a role guess.
   */
  function populationBand(city: { role?: string; population?: number; sizeCause?: string }, suitability: number): string {
    const earned = formatSettlementPeople(city)
    if (earned) return earned
    const base =
      city.role === 'seat_of_power' ? 30000 : city.role === 'trade' ? 12000 : city.role === 'fishing' ? 4000 : 6000
    const s = Number.isFinite(suitability) ? Math.max(0, Math.min(1, suitability)) : 0.5
    const pop = Math.round((base * (0.4 + s * 1.2)) / 500) * 500
    return `≈${pop.toLocaleString('en-US')} people`
  }

  /** Equatorial cell width, same formula as the cartouche. */
  function hoveredCellKmLine(): string {
    const R = state.meta.planetRadiusKm > 0 ? state.meta.planetRadiusKm : 6371
    const cellKm = (2 * Math.PI * R) / state.meta.width
    if (!(cellKm > 0) || !Number.isFinite(cellKm)) return ''
    return `<p class="hint">≈${Math.round(cellKm)} km</p>`
  }

  function inspectAt(x: number, y: number): void {
    flags.focusCell = { x, y }
    const i = y * state.meta.width + x
    if (showingDerivedWorld(state) && state.world) {
      const cell = inspectCell(state.world, x, y)
      const land = state.world.mask[i] >= state.world.meta.threshold
      const p = polityAt(state.world, x, y)
      const analog = land ? analogAt(state.world, x, y) : null
      const capital = p
        ? state.world.cities.find((c) => c.x === p.capitalX && c.y === p.capitalY)
        : undefined
      const s = state.world.suitability[i]
      const settle = Number.isFinite(s)
        ? `${s >= 0.7 ? 'Good for towns' : s >= 0.4 ? 'Marginal' : 'Harsh'} (${s.toFixed(2)}, 0–1)`
        : '—'
      const world = state.world
      const cityHere = world.cities.find((c) => Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1)
      let town: string | undefined
      let townPeople: string | undefined
      let townPartners: string | undefined
      if (cityHere) {
        const bits: string[] = []
        if (cityHere.role) bits.push(SETTLEMENT_ROLE_LABEL[cityHere.role])
        if (cityHere.port && cityHere.port !== 'none') bits.push(SETTLEMENT_PORT_LABEL[cityHere.port])
        if (cityHere.entrepot) bits.push('entrepôt')
        town = `${cityHere.name}${bits.length ? ` — ${bits.join(', ').toLowerCase()}` : ''}`
        const si = world.suitability[cityHere.y * world.meta.width + cityHere.x]
        townPeople = populationBand(cityHere, si)
        const partners = world.routes
          .filter(
            (r) =>
              (r.ax === cityHere.x && r.ay === cityHere.y) ||
              (r.bx === cityHere.x && r.by === cityHere.y),
          )
          .map((r) =>
            r.ax === cityHere.x && r.ay === cityHere.y
              ? endpointName(world, r.bx, r.by)
              : endpointName(world, r.ax, r.ay),
          )
        const unique = [...new Set(partners)].slice(0, 3)
        if (unique.length) townPartners = `Trades with ${unique.join(', ')}`
      }
      const wonderHere = wondersFor(world).find(
        (wd) => Math.abs(wd.x - x) <= 1 && Math.abs(wd.y - y) <= 1,
      )
      flags.inspectHtml = worldInspectHtml(
        { ...cell.display, settle },
        x,
        y,
        land,
        {
          polity: p?.name,
          analog: analog?.label,
          analogId: analog?.id,
          because: analog?.because,
          tradition: p?.tradition ?? analog?.tradition,
          economy: p ? economyLine(p) : undefined,
          mix: capital && p ? meltingPotLabel(p.meltingPot) : undefined,
          town,
          townPeople,
          townPartners,
          wonder: wonderHere ? `${wonderHere.name}. ${wonderHere.blurb} ${wonderHere.futures}` : undefined,
          wonderEarth: wonderHere?.earthCousin,
          route: (() => {
            const painted = overlayForWorldbuildAct(flags.worldbuildAct, flags.worldOverlay)
            const kind = tradeKindForOverlay(painted ?? flags.worldOverlay)
            if (!kind || state.stage !== 'worldbuild') return undefined
            const hit = routeNearCell(state.world, x, y, kind)
            return hit ? routeDossier(state.world, hit) : undefined
          })(),
        },
        flags.layer,
      )
    } else {
      const land = Boolean(flags.mask && flags.mask[i] >= state.meta.threshold)
      const note = flags.marks?.[i]
      flags.inspectHtml = sketchInspectHtml(x, y, land, markKindLabel(note ?? 0))
    }
    flags.inspectHtml += hoveredCellKmLine()
    updateInspector(inspector, buildView(bundle))
  }

  function refreshGazetteer(): void {
    if (state.stage !== 'worldbuild') return
    inspector.workHost.replaceChildren(mountStageWork(buildView(bundle)))
  }

  function applyWorldbuildAct(act: WorldbuildAct): void {
    flags.worldbuildAct = act
    const allowed =
      act === 'land'
        ? new Set(['inspect'])
        : act === 'kingdoms'
          ? new Set(['claim-land', 'inspect'])
          : act === 'towns'
            ? new Set(['place-city', 'remove-city', 'inspect'])
            : new Set(['trace-route', 'cut-route', 'inspect'])
    if (!allowed.has(state.tool)) state.tool = defaultToolForAct(act)
    if (act === 'land') state.tool = 'inspect'
    if (act === 'kingdoms') {
      flags.worldOverlay = 'countries'
      if (state.world) ensureWorldbuild(state.world, flags.polityCount)
    }
    if (act === 'trade' && flags.worldOverlay === 'countries') flags.worldOverlay = 'caravans'
    announce('info', actStatusLine(act))
  }

  function applyRouteClick(x: number, y: number): boolean {
    if (state.stage !== 'worldbuild' || !state.world) return false
    if (state.tool !== 'trace-route' && state.tool !== 'cut-route') return false
    const painted = overlayForWorldbuildAct(flags.worldbuildAct, flags.worldOverlay)
    const kind = tradeKindForOverlay(painted ?? flags.worldOverlay) ?? 'land'
    if (state.tool === 'cut-route') {
      const hit = removeRouteNearCell(state.world, x, y, kind)
      announce(
        hit ? 'success' : 'warn',
        hit ? `Cut: ${routeDossier(state.world, hit)}` : 'No route near that click.',
      )
      routeAnchor = null
      render()
      return true
    }
    const city = nearestTradeCity(state.world, x, y, 8)
    if (!city) {
      announce('warn', 'Click a town to start or finish the route.')
      return true
    }
    if (kind === 'sea' && !isSeaPortCity(city)) {
      announce('warn', `${city.name} is not a sea port. Switch to Caravans, or found a coastal town.`)
      return true
    }
    if (!routeAnchor) {
      routeAnchor = { x: city.x, y: city.y, name: city.name }
      announce('info', `From ${city.name}. Click another town to trace the ${kind === 'sea' ? 'sea lane' : 'caravan'}.`)
      return true
    }
    if (routeAnchor.x === city.x && routeAnchor.y === city.y) {
      routeAnchor = null
      announce('info', 'Route cancelled.')
      return true
    }
    const drawn = traceTradeRoute(
      state.world,
      routeAnchor.x,
      routeAnchor.y,
      city.x,
      city.y,
      kind,
    )
    const from = routeAnchor.name
    routeAnchor = null
    if (!drawn) {
      announce(
        'warn',
        kind === 'sea'
          ? `No sea path from ${from} to ${city.name}.`
          : `No land path from ${from} to ${city.name}.`,
      )
    } else {
      announce('success', `Traced: ${routeDossier(state.world, drawn)}`)
    }
    render()
    return true
  }

  function enterSketchSurface(from: typeof state.stage | null): void {
    flags.viewMode = 'atlas'
    flags.inspectHtml = emptyInspectHint(false)
    flags.layer = 'relief'
    if (from && from !== 'sketch') {
      announce(
        'info',
        'This is the doodle, not the planet. Paint or stamp, then Make sense — same continents, invented geography.',
      )
    }
  }

  function placeBrushCursor(clientX: number, clientY: number): void {
    const ink =
      state.stage === 'sketch' &&
      isSketchMaskTool(state.tool) &&
      !stampDrag &&
      flags.viewMode === 'atlas'
    if (!ink) {
      map.brushCursor.hidden = true
      map.canvas.style.cursor = ''
      return
    }
    const rect = map.canvas.getBoundingClientRect()
    const hit = clientToContainedBitmap(
      clientX,
      clientY,
      rect,
      state.meta.width,
      state.meta.height,
    )
    if (!hit) {
      map.brushCursor.hidden = true
      map.canvas.style.cursor = 'crosshair'
      return
    }
    const aspect = state.meta.width / Math.max(1, state.meta.height)
    const bw =
      rect.width / Math.max(1, rect.height) > aspect ? rect.height * aspect : rect.width
    const cell = bw / state.meta.width
    const d =
      state.tool === 'fill-mask' ? Math.max(12, cell * 2.4) : Math.max(10, state.brushSize * 2 * cell)
    const glyph = brushCursorGlyph(state.tool)
    map.brushCursor.hidden = false
    map.brushCursor.dataset.glyph = glyph
    map.brushCursor.classList.toggle('has-glyph', Boolean(glyph))
    map.brushCursor.style.setProperty('--brush-d', `${d}px`)
    map.brushCursor.style.width = `${d}px`
    map.brushCursor.style.height = `${d}px`
    map.brushCursor.style.left = `${clientX}px`
    map.brushCursor.style.top = `${clientY}px`
    map.brushCursor.classList.toggle('is-erase', state.tool === 'erase-land' || state.tool === 'wipe-note')
    map.brushCursor.classList.toggle('is-fill', state.tool === 'fill-mask')
    map.brushCursor.classList.toggle('is-range', state.tool === 'draw-ridge' || state.tool === 'mark-hills')
    map.brushCursor.classList.toggle('is-river', state.tool === 'erase-channel')
    map.brushCursor.classList.toggle('is-forest', state.tool === 'mark-forest' || state.tool === 'mark-swamp')
    map.brushCursor.classList.toggle('is-town', state.tool === 'mark-town')
    map.canvas.style.cursor = 'none'
  }

  function attachCanvas(): void {
    const canvas = map.canvas

    let lastPaintCell: { x: number; y: number } | null = null
    let downCell: { x: number; y: number } | null = null
    let strokeMoved = false
    let strokeDirty = false
    let lastLineCell: { x: number; y: number } | null = null

    function dabAt(x: number, y: number): void {
      const mode = paintModeForTool(state.tool)
      const note = markValueForTool(state.tool)
      if (!mode && note === null) return
      lastStamp = null
      if (mode) {
        if (state.world) invalidateDerivedWorld()
        const mask = ensureMask()
        brushes.dab({
          mask,
          meta: state.meta,
          cx: x,
          cy: y,
          brushSize: state.brushSize,
          strength: state.strength,
          tool: mode,
        })
      } else {
        ensureMask()
      }
      if (note !== null && (isSketchNoteTool(state.tool) || state.tool === 'draw-land' || state.tool === 'erase-land')) {
        stampSketchMarks(
          ensureMarks(),
          state.meta.width,
          state.meta.height,
          x,
          y,
          isSketchNoteTool(state.tool) ? noteStampRadius(state.tool, state.brushSize) : state.brushSize,
          note,
        )
      }
      lastPaintCell = { x, y }
      strokeDirty = true
      bumpSketchEpoch()
      strokeNeedsHd = true
      requestPaint()
    }

    function dabLine(x0: number, y0: number, x1: number, y1: number): void {
      const dist = Math.hypot(x1 - x0, y1 - y0)
      const n = Math.max(1, Math.ceil(dist * 1.35))
      for (let i = 0; i <= n; i++) {
        const t = i / n
        dabAt(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))
      }
    }

    const onPoint = (
      clientX: number,
      clientY: number,
      isDown: boolean,
      paintStroke: boolean,
      straight = false,
    ) => {
      if (stampDrag) return
      const cell = cellFromPointer(
        canvas,
        clientX,
        clientY,
        state.meta.width,
        state.meta.height,
      )
      if (!cell) return
      const { x, y } = cell

      const hovering = !isDown && !painting
      if (state.tool === 'inspect' || hovering) {
        inspectAt(x, y)
        if (isDown && state.stage === 'worldbuild') refreshGazetteer()
        if (state.tool === 'inspect') return
        if (hovering) return
      }

      if (state.tool === 'trace-route' || state.tool === 'cut-route') {
        if (!isDown) return
        applyRouteClick(x, y)
        return
      }

      if (state.tool === 'place-city' || state.tool === 'remove-city') {
        if (!isDown) return
        if (!state.world) {
          announce('warn', 'No derived world yet — run Make sense first.')
          return
        }
        if (state.tool === 'place-city') {
          const next = `City ${state.world.cities.length + 1}`
          const result = placeCity(state.world, x, y, next)
          if (result.rejected) {
            announce(
              'warn',
              'No city placed — need land, suitability ≥ 0.4, no neighbour within 5 cells.',
            )
          } else if (result.city) {
            const seats = state.world.cities.filter((c) => c.role === 'seat_of_power').length
            result.city.role = inferSettlementRole(state.world, x, y, {
              allowSeat: seats < flags.polityCount,
            })
            annotateSettlement(state.world, result.city, {
              allowSeat: seats < flags.polityCount,
            })
            ensureWorldbuild(state.world, flags.polityCount)
            announce('success', `${result.city.name} founded.`)
          }
        } else {
          const result = removeNearestCity(state.world, x, y)
          if (!result.matched) announce('warn', 'No city within range.')
          else ensureWorldbuild(state.world, flags.polityCount)
        }
        render()
        return
      }

      if (state.tool === 'claim-land') {
        if (!state.world || state.stage !== 'worldbuild') return
        if (!isDown && !paintStroke) return
        const pid = nearestPolityId(state.world, x, y)
        paintClaim(state.world, x, y, Math.max(2, Math.round(state.brushSize / 6)), pid)
        lastPaintCell = { x, y }
        requestPaint()
        return
      }

      if (state.tool === 'fill-mask') {
        if (!isDown || paintStroke || state.stage !== 'sketch' || state.isProcessing) return
        const mask = ensureMask()
        const result = fillMaskComponent(
          mask,
          state.meta.width,
          state.meta.height,
          state.meta.threshold,
          x,
          y,
          ensureMarks(),
        )
        if (result.ok === false) {
          announce(
            'info',
            result.reason === 'land'
              ? 'That’s the whole continent. Use Ocean to erase, or Undo.'
              : 'That’s the open ocean. Paint or stamp land instead.',
          )
          return
        }
        lastStamp = null
        if (state.world) invalidateDerivedWorld()
        bumpSketchEpoch()
        recordMask()
        lastLineCell = { x, y }
        maybeAnnounceSketchLand()
        announce('success', result.flippedTo === 'land' ? 'Lake filled.' : 'Island erased.')
        render()
        return
      }

      if (!paintStroke) return
      if (state.stage !== 'sketch') return
      if (!paintModeForTool(state.tool) && markValueForTool(state.tool) === null) return

      if (straight && lastLineCell) dabLine(lastLineCell.x, lastLineCell.y, x, y)
      else dabAt(x, y)
      lastLineCell = { x, y }
    }

    function atlasPanGesture(e: PointerEvent): boolean {
      if (flags.viewMode !== 'atlas') return false
      if (e.button === 1 || spaceHeld) return true
      if (state.tool === 'place-city' || state.tool === 'remove-city') return false
      if (state.tool === 'trace-route' || state.tool === 'cut-route') return false
      if (state.tool === 'claim-land' && state.stage === 'worldbuild') return false
      if (state.stage === 'sketch' && isSketchMaskTool(state.tool)) return false
      return e.button === 0
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (stampDrag) {
        e.preventDefault()
        return
      }
      if (atlasPanGesture(e)) {
        atlasPanning = { x: e.clientX, y: e.clientY }
        canvas.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        return
      }
      beginPointerStroke(e.clientX, e.clientY)
      strokeMoved = false
      strokeDirty = false
      downCell = cellFromPointer(canvas, e.clientX, e.clientY, state.meta.width, state.meta.height)
      lastPaintCell = downCell
      canvas.setPointerCapture?.(e.pointerId)
      onPoint(e.clientX, e.clientY, true, isSketchNoteTool(state.tool), e.shiftKey)
    })
    canvas.addEventListener('pointermove', (e) => {
      placeBrushCursor(e.clientX, e.clientY)
      if (atlasPanning) {
        atlasPanX += e.clientX - atlasPanning.x
        atlasPanY += e.clientY - atlasPanning.y
        atlasPanning = { x: e.clientX, y: e.clientY }
        applyAtlasView()
        return
      }
      hideChromeIfDragging(e.clientX, e.clientY)
      if (stampDrag) return
      if (painting && dragOrigin) {
        const dx = e.clientX - dragOrigin.x
        const dy = e.clientY - dragOrigin.y
        if (dx * dx + dy * dy >= DRAG_HIDE_PX * DRAG_HIDE_PX) {
          if (
            !strokeMoved &&
            downCell &&
            (isSketchInkTool(state.tool) || state.tool === 'claim-land')
          ) {
            strokeMoved = true
            onPoint(dragOrigin.x, dragOrigin.y, true, true, e.shiftKey)
          }
          if (strokeMoved) onPoint(e.clientX, e.clientY, true, true, e.shiftKey)
          return
        }
      }
      onPoint(e.clientX, e.clientY, false, false)
    })
    canvas.addEventListener('pointerup', () => {
      if (atlasPanning) {
        atlasPanning = null
        return
      }
      if (
        !stampDrag &&
        !strokeMoved &&
        downCell &&
        state.stage === 'sketch' &&
        state.tool === 'draw-land' &&
        !state.isProcessing
      ) {
        const mask = ensureMask()
        if (
          lastStamp &&
          landBlobContains(
            mask,
            state.meta.width,
            state.meta.height,
            state.meta.threshold,
            downCell.x,
            downCell.y,
            lastStamp.x,
            lastStamp.y,
          )
        ) {
          lastStamp.scale = Math.max(STAMP_MIN_SCALE, lastStamp.scale * STAMP_SHRINK)
          mask.set(lastStamp.before)
          stampLandformAt(
            mask,
            state.meta,
            lastStamp.kind,
            state.meta.seed,
            lastStamp.x,
            lastStamp.y,
            lastStamp.scale,
            lastStamp.seed,
          )
          if (state.world) invalidateDerivedWorld()
          bindMask(mask)
          bumpSketchEpoch()
          strokeNeedsHd = true
          announce('success', 'Smaller. Same continent type. Click again to shrink more.')
        } else if (
          shrinkLandBlob(
            mask,
            state.meta.width,
            state.meta.height,
            state.meta.threshold,
            downCell.x,
            downCell.y,
          )
        ) {
          lastStamp = null
          if (state.world) invalidateDerivedWorld()
          bindMask(mask)
          bumpSketchEpoch()
          strokeNeedsHd = true
          announce('success', 'Smaller. Click again to shrink more.')
        }
      }
      if (state.tool === 'claim-land' && state.world && state.stage === 'worldbuild') {
        refreshWorldbuildAfterPaint(state.world)
      }
      if (strokeDirty) {
        recordMask()
        maybeAnnounceSketchLand()
        if (lastPaintCell) lastLineCell = lastPaintCell
        strokeDirty = false
      }
      endPointerStroke()
      if (strokeNeedsHd) {
        deferSketchHd()
        strokeNeedsHd = false
      }
      downCell = null
      strokeMoved = false
      if (lastPaintCell) inspectAt(lastPaintCell.x, lastPaintCell.y)
      render()
    })
    canvas.addEventListener('pointercancel', () => {
      atlasPanning = null
      endPointerStroke()
      if (strokeNeedsHd) {
        deferSketchHd()
        strokeNeedsHd = false
      }
      downCell = null
      strokeMoved = false
      render()
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (flags.viewMode !== 'atlas') return
        e.preventDefault()
        zoomAtlasAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.11)
      },
      { passive: false },
    )
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener('pointerleave', () => {
      map.brushCursor.hidden = true
    })
  }

  function attachGlobe(): void {
    const globe = map.globe
    let moved = false
    globe.addEventListener('pointerdown', (e) => {
      if (!planet) return
      globe.setPointerCapture?.(e.pointerId)
      moved = false
      beginPointerStroke(e.clientX, e.clientY)
      planet.onPointerDown(e.clientX, e.clientY)
    })
    globe.addEventListener('pointermove', (e) => {
      if (!planet) return
      hideChromeIfDragging(e.clientX, e.clientY)
      if (planet.onPointerMove(e.clientX, e.clientY)) {
        moved = true
        planet.render()
      } else if (state.world) {
        const cell = planet.pick(e.clientX, e.clientY, state.world)
        if (cell) inspectAt(cell.x, cell.y)
      }
    })
    globe.addEventListener('pointerup', (e) => {
      endPointerStroke()
      if (!planet || !state.world) {
        planet?.onPointerUp()
        return
      }
      if (!moved) {
        const cell = planet.pick(e.clientX, e.clientY, state.world)
        if (cell) {
          inspectAt(cell.x, cell.y)
          if (state.tool === 'place-city' || state.tool === 'remove-city') {
            const { x, y } = cell
            if (state.tool === 'place-city') {
              const next = `City ${state.world.cities.length + 1}`
              const result = placeCity(state.world, x, y, next)
              if (result.rejected) {
                announce(
                  'warn',
                  'No city placed — need land, suitability ≥ 0.4, no neighbour within 5 cells.',
                )
              } else if (result.city) {
                const seats = state.world.cities.filter((c) => c.role === 'seat_of_power').length
                result.city.role = inferSettlementRole(state.world, x, y, {
                  allowSeat: seats < flags.polityCount,
                })
                annotateSettlement(state.world, result.city, {
                  allowSeat: seats < flags.polityCount,
                })
                ensureWorldbuild(state.world, flags.polityCount)
                announce('success', `${result.city.name} founded.`)
              }
            } else {
              const result = removeNearestCity(state.world, x, y)
              if (!result.matched) announce('warn', 'No city within range.')
              else ensureWorldbuild(state.world, flags.polityCount)
            }
            render()
          }
        }
      }
      planet.onPointerUp()
    })
    globe.addEventListener('pointercancel', () => {
      endPointerStroke()
      planet?.onPointerUp()
    })
    globe.addEventListener('wheel', (e) => {
      if (!planet || flags.viewMode !== 'planet') return
      e.preventDefault()
      planet.dolly(e.deltaY > 0 ? 1.08 : 0.92)
      planet.render()
    }, { passive: false })
    globe.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  window.addEventListener(APP_EVENTS.STAGE_TRANSITION, (ev) => {
    const detail = (ev as CustomEvent).detail as StageTransitionDetail | undefined
    if (!detail) return
    const target = detail.stage
    const view = buildView(bundle)
    if (target === state.stage) return
    if (target === 'critique') return
    if (target === 'make-sense' && !flags.makeSenseComplete) {
      window.dispatchEvent(new Event(APP_EVENTS.MAKE_SENSE))
      return
    }
    if (!STAGES[target].canEnter(view)) {
      announce('warn', 'That stage is not open yet.')
      return
    }
    const from = state.stage
    STAGES[from].leave(view)
    state.stage = target
    if (target === 'worldbuild') applyWorldbuildAct(flags.worldbuildAct || 'land')
    if (target === 'sketch' && !isSketchMaskTool(state.tool) && state.tool !== 'inspect') {
      state.tool = 'draw-land'
    }
    if (target === 'sketch') enterSketchSurface(from)
    render({ remount: true })
    STAGES[target].enter(view)
    announceCoach({ kind: 'app.stage', from, to: target, trigger: 'user' })
  })

  window.addEventListener(APP_EVENTS.ACCOUNT_SUBMIT, (ev) => {
    const detail = (ev as CustomEvent).detail as AccountSubmitDetail | undefined
    if (!detail) return
    accountBusy = true
    accountMessage = ''
    paintAccount()
    const run = detail.mode === 'up' ? signUpAccount : signInAccount
    void run(detail.email, detail.password).then((result) => {
      accountBusy = false
      if (result.ok === false) {
        accountMessage = result.error
        paintAccount()
        return
      }
      account = result.account
      if (result.needsConfirm) {
        accountMessage = 'Check your email to confirm, then sign in.'
      } else {
        accountMessage = ''
        chrome.accountSheet.hidden = true
        if (account) announce('success', `Signed in as ${account.email}`)
      }
      paintAccount()
    })
  })

  window.addEventListener(APP_EVENTS.ACCOUNT_SIGN_OUT, () => {
    void signOutAccount().then(() => {
      account = null
      accountMessage = ''
      chrome.accountSheet.hidden = true
      paintAccount()
    })
  })

  window.addEventListener(APP_EVENTS.SAVE, () => {
    if (state.world) {
      const json = serializeWorld(state.world)
      const bytes = json.length
      const ok = saveWorld(state.world)
      if (!ok) downloadWorld(state.world)
      announceCoach(
        ok
          ? { kind: 'persist.saved', key: 'world', bytes, ok: true }
          : { kind: 'persist.failed', key: 'world', reason: 'quota', bytes },
      )
      if (ok) {
        chrome.saveMeta.textContent = 'Saved world in this browser'
        chrome.saveMeta.hidden = false
      }
    } else if (flags.mask) {
      const json = serializeMask(state.meta, flags.mask, flags.marks)
      const bytes = json.length
      const ok = saveMask(state.meta, flags.mask, flags.marks)
      announceCoach(
        ok
          ? { kind: 'persist.saved', key: 'mask', bytes, ok: true }
          : { kind: 'persist.failed', key: 'mask', reason: 'quota', bytes },
      )
      if (ok) {
        chrome.saveMeta.textContent = 'Saved sketch in this browser'
        chrome.saveMeta.hidden = false
      }
    } else {
      announceCoach({ kind: 'persist.failed', key: 'mask', reason: 'shape', bytes: 0 })
    }
  })

  window.addEventListener(APP_EVENTS.DOWNLOAD, () => {
    if (state.world) {
      downloadWorld(state.world)
      announce('success', 'Downloaded the world as JSON.')
    } else if (flags.mask) {
      downloadMask(state.meta, flags.mask, flags.marks)
      announce('success', 'Downloaded the sketch mask as JSON.')
    } else {
      announce('warn', 'Nothing to download yet.')
    }
  })

  const STAMP_CLICK_PX = 12
  const STAMP_SHRINK = 0.78
  const STAMP_MIN_SCALE = 0.32
  const STAMP_START_SCALE = 0.82

  function pointerOverSidePanels(clientX: number, clientY: number): boolean {
    for (const sel of ['.tools-panel', '.inspector']) {
      const node = root.querySelector(sel)
      if (!node) continue
      const r = node.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return true
      }
    }
    return false
  }

  function paintStampPreview(cell: { x: number; y: number } | null): void {
    if (!stampDrag || !flags.mask) return
    if (
      cell &&
      stampPreviewCell &&
      stampPreviewCell.x === cell.x &&
      stampPreviewCell.y === cell.y
    ) {
      return
    }
    stampPreviewCell = cell ? { x: cell.x, y: cell.y } : null
    flags.mask.set(stampDrag.snapshot)
    if (cell) {
      stampLandformAt(
        flags.mask,
        state.meta,
        stampDrag.kind,
        state.meta.seed,
        cell.x,
        cell.y,
        stampDrag.scale,
        stampDrag.stampSeed,
      )
    }
    bumpSketchEpoch()
    requestPaint()
  }

  function queueStampPreview(): void {
    const run = () => {
      stampPreviewRaf = 0
      if (!stampDrag) return
      paintStampPreview(stampDrag.lastCell)
    }
    if (stampPreviewRaf) return
    if (typeof requestAnimationFrame === 'function') {
      stampPreviewRaf = requestAnimationFrame(run)
    } else {
      run()
    }
  }

  function applyStampPointer(clientX: number, clientY: number, ended: boolean): void {
    if (!stampDrag || state.stage !== 'sketch' || state.isProcessing) return
    if (!stampDrag.armed && !pointerOverSidePanels(clientX, clientY)) {
      stampDrag.armed = true
    }
    const cell = stampDrag.armed
      ? cellFromPointer(
          map.canvas,
          clientX,
          clientY,
          state.meta.width,
          state.meta.height,
          true,
        )
      : null
    if (cell) stampDrag.lastCell = cell
    setStampCursor(clientX, clientY, Boolean(stampDrag.lastCell))
    if (!ended) {
      queueStampPreview()
      return
    }
    if (stampEndLock) return
    stampEndLock = true
    queueMicrotask(() => {
      stampEndLock = false
    })
    const dx = clientX - stampDrag.originX
    const dy = clientY - stampDrag.originY
    const moved = dx * dx + dy * dy >= STAMP_CLICK_PX * STAMP_CLICK_PX
    if (!moved) {
      stampDrag.scale = Math.max(STAMP_MIN_SCALE, stampDrag.scale * STAMP_SHRINK)
      stampPreviewCell = null
      paintLandformThumb(map.stampCursor, stampDrag.kind, stampDrag.scale)
      paintStampPreview(stampDrag.lastCell)
      setStampCursor(clientX, clientY, Boolean(stampDrag.lastCell))
      announce('info', 'Smaller. Same continent type. Drop it anywhere, or click again.')
      return
    }
    const drop = stampDrag.lastCell
    if (!drop) {
      flags.mask!.set(stampDrag.snapshot)
      bumpSketchEpoch()
      clearStampDrag()
      requestPaint()
      return
    }
    if (state.world) invalidateDerivedWorld()
    const mask = ensureMask()
    mask.set(stampDrag.snapshot)
    stampLandformAt(
      mask,
      state.meta,
      stampDrag.kind,
      state.meta.seed,
      drop.x,
      drop.y,
      stampDrag.scale,
      stampDrag.stampSeed,
    )
    clearMarksWhereMaskChanged(ensureMarks(), stampDrag.snapshot, mask)
    lastStamp = {
      kind: stampDrag.kind,
      seed: stampDrag.stampSeed,
      scale: stampDrag.scale,
      x: drop.x,
      y: drop.y,
      before: new Float32Array(stampDrag.snapshot),
    }
    const placed = stampDrag.kind
    bindMask(mask)
    bumpSketchEpoch()
    clearStampDrag()
    recordMask()
    maybeAnnounceSketchLand()
    announce('success', landformStampCopy(placed))
    inspectAt(drop.x, drop.y)
    render()
  }

  window.addEventListener(APP_EVENTS.LANDFORM_DRAG, (ev) => {
    if (state.stage !== 'sketch' || state.isProcessing) return
    const detail = (ev as CustomEvent<LandformDragDetail>).detail
    if (!detail || !isLandformKind(detail.kind)) return
    const { kind, phase, clientX, clientY } = detail
    if (phase === 'start') {
      hdBake.cancel()
      const mask = ensureMask()
      stampDrag = {
        kind,
        snapshot: new Float32Array(mask),
        stampSeed: landformStampSeed(mask, state.meta.threshold, state.meta.seed),
        scale: STAMP_START_SCALE,
        originX: clientX,
        originY: clientY,
        lastCell: null,
        armed: false,
      }
      paintLandformThumb(map.stampCursor, kind, STAMP_START_SCALE)
      setStampCursor(clientX, clientY, false)
      return
    }
    applyStampPointer(clientX, clientY, phase === 'end')
  })

  window.addEventListener('pointermove', (e) => {
    if (stampDrag) applyStampPointer(e.clientX, e.clientY, false)
  })
  window.addEventListener('pointerup', (e) => {
    if (stampDrag) applyStampPointer(e.clientX, e.clientY, true)
  })
  window.addEventListener('pointercancel', () => {
    if (!stampDrag) return
    flags.mask?.set(stampDrag.snapshot)
    bumpSketchEpoch()
    clearStampDrag()
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.CLEAR_SEA, () => {
    if (hasAnyLand(flags.mask, state.meta.threshold) || state.world) {
      if (!window.confirm('Wipe the canvas back to empty ocean?')) return
    }
    const w = state.meta.width
    const h = state.meta.height
    flags.mask = new Float32Array(w * h)
    flags.marks = emptyMarks(w * h)
    bindMask(flags.mask)
    bumpSketchEpoch()
    hdBake.cancel()
    maskHistory.clear()
    recordMask()
    invalidateDerivedWorld()
    state.stage = 'sketch'
    state.tool = 'draw-land'
    state.isProcessing = false
    flags.inspectHtml = emptyInspectHint()
    sketchAnnouncedLand = false
    announceCoach({
      kind: 'sketch.ready',
      width: w,
      height: h,
      landCells: 0,
    })
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.RESET, () => {
    window.dispatchEvent(new Event(APP_EVENTS.CLEAR_SEA))
  })

  window.addEventListener(APP_EVENTS.COMMIT_SKETCH, () => {
    window.dispatchEvent(new Event(APP_EVENTS.MAKE_SENSE))
  })

  window.addEventListener(APP_EVENTS.MAKE_SENSE, () => {
    if (state.stage !== 'sketch' && state.stage !== 'critique' && state.stage !== 'make-sense') return
    if (state.isProcessing) return
    if (!hasAnyLand(ensureMask(), state.meta.threshold)) {
      announce('warn', 'Paint some land first.')
      return
    }
    if (state.stage === 'sketch' || state.stage === 'critique') {
      const mask = ensureMask()
      flags.maskCommitted = true
      const result = critiqueMask(mask, state.meta, state.meta.threshold)
      state.issues = result.issues
      flags.score = result.score
      fireCommitHook(brushes, state.meta, mask)
    }
    const view = buildView(bundle)
    if (!STAGES['make-sense'].canEnter(view) && state.stage !== 'make-sense') return
    void runMakeSense()
  })

  async function runMakeSense(): Promise<void> {
    STAGES[state.stage].leave(buildView(bundle))
    state.stage = 'make-sense'
    state.isProcessing = true
    flags.pipelineStep = 0
    render({ remount: true })
    const mask = ensureMask()
    announceCoach({
      kind: 'makeSense.start',
      cellCount: mask.length,
      plateTarget: 8,
    })
    try {
      const groundStart = performance.now()
      const stepLines: string[] = []
      const showCause = (index: number): void => {
        const note = map.loading.querySelector('.loading-note')
        if (!note) return
        const line = stepLines[index]
        note.textContent =
          line && line.length > 0 ? line : 'Same continents. The geography is being invented.'
      }
      showCause(0)
      const result = await makeSenseInline({ meta: state.meta, mask }, (step) => {
        flags.pipelineStep = MAKE_SENSE_STEP_INDEX[step.stepName] ?? flags.pipelineStep
        const summary = step.measurements.summary
        if (typeof summary === 'string') stepLines[flags.pipelineStep] = summary
        showCause(flags.pipelineStep)
        inspector.workHost.replaceChildren(mountStageWork(buildView(bundle)))
        // Narrate the step on the loading overlay too, not just the pipeline list.
        updateMapShell(map, buildView(bundle))
      })
      // Presentation pacing only — the pipeline is untouched. Grounding should
      // read as considered work: when the compute finishes faster than a human
      // can read, replay the seven acts as beats before the world appears.
      const narrationBudget = Math.max(0, GROUND_REVEAL_MIN_MS - (performance.now() - groundStart))
      if (narrationBudget > 0) {
        const beat = narrationBudget / (MAKE_SENSE_STEPS.length + 1)
        for (let done = 0; done <= MAKE_SENSE_STEPS.length; done++) {
          if (!state.isProcessing) break
          flags.pipelineStep = done
          showCause(done)
          inspector.workHost.replaceChildren(mountStageWork(buildView(bundle)))
          updateMapShell(map, buildView(bundle))
          await new Promise((resolve) => setTimeout(resolve, beat))
        }
      }
      const world = worldFromMakeSense(result, state.meta, mask)
      const aged = ageContinent({
        width: world.meta.width,
        height: world.meta.height,
        threshold: world.meta.threshold,
        mask: world.mask,
        elev: world.elev,
        tempMean: world.tempMean,
        summerMoist: world.summerMoist,
        winterMoist: world.winterMoist,
        moistMean: world.moistMean,
        flux: world.flux,
        rivers: world.rivers,
        salt: world.salt ?? new Uint8Array(world.meta.width * world.meta.height),
        lakes: world.lakes,
        ice: world.ice,
        plateId: world.plateId,
        plateVx: world.plateVx,
        plateVy: world.plateVy,
      })
      world.salt = aged.salt
      world.sites = aged.sites
      world.elev = aged.elev
      for (let i = 0; i < aged.salt.length; i++) {
        if (!aged.salt[i] || world.mask[i] < world.meta.threshold) continue
        world.rivers[i] = 0
        const t = world.tempMean[i]
        world.biome[i] = t >= 18 ? 'hot-desert' : t >= 5 ? 'steppe' : 'polar-desert'
      }
      flags.polityCount = defaultPolityCount(world)
      const added = seedSettlements(world, 0.35, flags.polityCount)
      ensureWorldbuild(world, flags.polityCount)
      const provenance = provenanceFromResult(result)
      state.world = world
      const c = critiqueWorld(world)
      provenance.scoreAfter = c.score
      provenance.scoreBefore = flags.score
      state.provenance = provenance
      state.issues = c.issues
      flags.score = c.score
      flags.makeSenseComplete = true
      flags.layoutMode = 'chrome'
      flags.pipelineStep = 7
      flags.layer = 'relief'
      flags.inspectHtml = emptyInspectHint(true)
      state.isProcessing = false
      const riverCells = world.rivers.reduce((n, v) => n + v, 0)
      let rangeSum = 0
      let rangeN = 0
      for (let i = 0; i < world.tempRange.length; i++) {
        if (world.mask[i] >= world.meta.threshold && Number.isFinite(world.tempRange[i])) {
          rangeSum += world.tempRange[i]
          rangeN++
        }
      }
      announceCoach({
        kind: 'makeSense.complete',
        provenanceSteps: provenance.steps.length,
        maskDeltaPct: provenance.maskDeltaPct,
        scoreBefore: provenance.scoreBefore,
        scoreAfter: provenance.scoreAfter,
        riversCount: riverCells,
        rangeAvgC: rangeN ? rangeSum / rangeN : 0,
      })
      if (added.length) {
        announce(
          'success',
          `${added.length} towns founded where the land can feed them. Open Worldbuild to rename, place, or raze.`,
        )
      }
      let mirrors = 0
      let springs = 0
      let slots = 0
      const sites = world.sites
      if (sites) {
        for (let i = 0; i < sites.length; i++) {
          if (sites[i] === SITE_MIRROR) mirrors++
          else if (sites[i] === SITE_SPRING) springs++
          else if (sites[i] === SITE_SLOT) slots++
        }
      }
      if (mirrors || springs || slots) {
        announce(
          'info',
          `The land aged after the continent was grounded. ${mirrors} mirror cells, ${springs} springs, ${slots} slots. The coast did not move.`,
        )
      }
    } catch (err) {
      state.isProcessing = false
      announce('error', `Make-sense failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      render({ remount: true })
    }
  }

  window.addEventListener(APP_EVENTS.CANCEL_MAKE_SENSE, () => {
    if (state.stage !== 'make-sense') return
    state.isProcessing = false
    flags.makeSenseComplete = false
    announceCoach({ kind: 'makeSense.cancelled', atStep: String(flags.pipelineStep) })
    render()
  })

  window.addEventListener(APP_EVENTS.WORLDBUILD, () => {
    if (state.stage !== 'make-sense') return
    const view = buildView(bundle)
    if (!STAGES[state.stage].canLeave(view)) return
    STAGES[state.stage].leave(view)
    state.stage = 'worldbuild'
    applyWorldbuildAct('land')
    if (state.world) ensureWorldbuild(state.world, flags.polityCount)
    render({ remount: true })
    STAGES[state.stage].enter(view)
    announceCoach({ kind: 'app.stage', from: 'make-sense', to: 'worldbuild', trigger: 'user' })
  })

  window.addEventListener(APP_EVENTS.BACK_TO_SKETCH, () => {
    if (state.world && !window.confirm('Back to Sketch replaces this planet. Continue?')) return
    const view = buildView(bundle)
    const from = state.stage
    STAGES[state.stage].leave(view)
    state.stage = 'sketch'
    state.tool = 'draw-land'
    enterSketchSurface(from)
    invalidateDerivedWorld()
    render({ remount: true })
    announceCoach({ kind: 'app.stage', from: 'worldbuild', to: 'sketch', trigger: 'user' })
  })

  window.addEventListener(APP_EVENTS.TOOL_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as ToolChangeDetail | undefined
    if (!detail) return
    state.tool = detail.tool
    const preset = presetBrushForTool(detail.tool)
    if (preset != null) state.brushSize = preset
    if (detail.tool !== 'trace-route') routeAnchor = null
    if (state.stage === 'sketch' && detail.tool !== 'inspect') {
      flags.sketchPlane = sketchPlaneForTool(detail.tool)
    }
    if (isSketchNoteTool(detail.tool)) {
      announceCoach({ kind: 'sketch.decorate', tool: detail.tool })
    } else {
      announceCoach({ kind: 'tool.changed', tool: detail.tool })
    }
    render()
  })

  window.addEventListener(APP_EVENTS.SKETCH_PLANE_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as SketchPlaneDetail | undefined
    if (!detail || state.stage !== 'sketch') return
    flags.sketchPlane = detail.plane
    if (detail.plane === 'notes' && !isSketchNoteTool(state.tool)) state.tool = 'draw-ridge'
    if (detail.plane === 'land' && isSketchNoteTool(state.tool)) state.tool = 'draw-land'
    const preset = presetBrushForTool(state.tool)
    if (preset != null) state.brushSize = preset
    if (isSketchNoteTool(state.tool)) {
      announceCoach({ kind: 'sketch.decorate', tool: state.tool })
    }
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.META_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as MetaChangeDetail | undefined
    if (!detail) return
    if (state.stage !== 'sketch' || state.isProcessing) return
    state.meta = { ...state.meta, ...detail.meta }
    bumpSketchEpoch()
    hdBake.cancel()
    if (state.world) invalidateDerivedWorld()
    render()
  })

  window.addEventListener(APP_EVENTS.BRUSH_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as BrushChangeDetail | undefined
    if (!detail) return
    state.brushSize = detail.size
    if (toolsRefs) updateStageTools(toolsRefs, buildView(bundle))
    updateMapShell(map, buildView(bundle))
  })

  window.addEventListener(APP_EVENTS.STRENGTH_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as StrengthChangeDetail | undefined
    if (!detail) return
    state.strength = Math.min(1, Math.max(0.2, detail.strength))
    if (toolsRefs) updateStageTools(toolsRefs, buildView(bundle))
  })

  window.addEventListener(APP_EVENTS.UNDO, () => {
    if (state.stage !== 'sketch' || state.isProcessing) return
    const snap = maskHistory.undo()
    if (!snap) return
    flags.mask = snap.mask
    flags.marks = snap.marks ? new Uint8Array(snap.marks) : emptyMarks(snap.mask.length)
    state.meta = { ...snap.meta }
    bindMask(flags.mask)
    bumpSketchEpoch()
    invalidateDerivedWorld()
    syncHistoryFlags()
    maybeAnnounceSketchLand()
    render()
  })

  window.addEventListener(APP_EVENTS.REDO, () => {
    if (state.stage !== 'sketch' || state.isProcessing) return
    const snap = maskHistory.redo()
    if (!snap) return
    flags.mask = snap.mask
    flags.marks = snap.marks ? new Uint8Array(snap.marks) : emptyMarks(snap.mask.length)
    state.meta = { ...snap.meta }
    bindMask(flags.mask)
    bumpSketchEpoch()
    invalidateDerivedWorld()
    syncHistoryFlags()
    maybeAnnounceSketchLand()
    render()
  })

  window.addEventListener(APP_EVENTS.RENAME_PLACE, (ev) => {
    const detail = (ev as CustomEvent).detail as RenamePlaceDetail | undefined
    if (!detail || !state.world || state.stage !== 'worldbuild') return
    const raw = detail.name.trim()
    const name = raw.slice(0, detail.kind === 'people' ? 60 : 40)
    if (!name) return
    if (detail.kind === 'polity' && detail.id !== undefined) {
      const p = state.world.polities.find((row) => row.id === detail.id)
      if (p) p.name = name
    } else if (detail.kind === 'people' && detail.id !== undefined) {
      const p = state.world.polities.find((row) => row.id === detail.id)
      if (p) p.tradition = name.slice(0, 60)
    } else if (detail.kind === 'city' && detail.x !== undefined && detail.y !== undefined) {
      const city = state.world.cities.find((c) => c.x === detail.x && c.y === detail.y)
      if (city) city.name = name
    }
    requestPaint()
    updateMapLabels()
  })

  window.addEventListener(APP_EVENTS.LAYER_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as LayerChangeDetail | undefined
    if (!detail || !showingDerivedWorld(state)) return
    flags.layer = detail.layer
    updateMapShell(map, buildView(bundle))
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.CONTINENT_COUNT_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as ContinentCountDetail | undefined
    if (!detail) return
    flags.continentCount = clampContinentCount(detail.count)
    if (toolsRefs) updateStageTools(toolsRefs, buildView(bundle))
  })

  window.addEventListener(APP_EVENTS.WORLDBUILD_ACT_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as WorldbuildActDetail | undefined
    if (!detail || state.stage !== 'worldbuild') return
    applyWorldbuildAct(detail.act)
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.POLITY_COUNT_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as PolityCountDetail | undefined
    if (!detail) return
    flags.polityCount = clampPolityCount(detail.count)
    if (state.world) {
      ensureWorldbuild(state.world, flags.polityCount)
      announce('info', `${flags.polityCount} ${flags.polityCount === 1 ? 'country' : 'countries'} on the grounded land.`)
    }
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.WORLD_OVERLAY_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as OverlayChangeDetail | undefined
    if (!detail) return
    flags.worldOverlay = detail.overlay
    routeAnchor = null
    if (state.world) {
      const kind = tradeKindForOverlay(detail.overlay)
      if (kind) {
        const n = state.world.routes.filter((r) => r.kind === kind && r.path.length >= 2).length
        if (n === 0) {
          announce(
            'info',
            kind === 'sea'
              ? 'No sea lanes yet — Trace route between two ports, or found a coastal town.'
              : 'No caravans yet — Trace route between two towns.',
          )
        } else {
          const top = [...state.world.routes]
            .filter((r) => r.kind === kind && r.path.length >= 2)
            .sort((a, b) => b.volume - a.volume)[0]
          announce(
            'info',
            `${n} ${kind === 'sea' ? 'sea lanes' : 'caravans'}. Width is cargo volume. Busiest: ${routeDossier(state.world, top)}`,
          )
        }
      }
    }
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.LAYOUT_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as LayoutChangeDetail | undefined
    if (!detail) return
    flags.layoutMode = detail.layout
    syncLayoutClasses()
    updateMapShell(map, buildView(bundle))
    applyAtlasView()
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      spaceHeld = true
    }
    if (e.key !== 'Escape') return
    if (routeAnchor) {
      e.preventDefault()
      routeAnchor = null
      announce('info', 'Route cancelled.')
      return
    }
    if (stampDrag) {
      e.preventDefault()
      flags.mask?.set(stampDrag.snapshot)
      bumpSketchEpoch()
      clearStampDrag()
      requestPaint()
      return
    }
    if (!chrome.accountSheet.hidden) {
      chrome.accountSheet.hidden = true
      return
    }
    if (flags.layoutMode === 'view-map') {
      e.preventDefault()
      exitViewMap()
      return
    }
    if (!atlasViewIdentity()) {
      e.preventDefault()
      resetAtlasView()
    }
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') spaceHeld = false
  })

  window.addEventListener(APP_EVENTS.RESET_ATLAS_VIEW, () => {
    resetAtlasView()
  })

  function frameContinent(x: number, y: number, span: number): void {
    if (flags.viewMode !== 'atlas') {
      flags.viewMode = 'atlas'
      updateMapShell(map, buildView(bundle))
    }
    const box = letterboxCss()
    if (!box) return
    const shellW = map.canvas.offsetWidth
    const shellH = map.canvas.offsetHeight
    const cellPx = box.w / Math.max(1, state.meta.width)
    const want = Math.max(12, span) * cellPx
    atlasScale = Math.min(ATLAS_ZOOM_MAX, Math.max(1.8, (Math.min(shellW, shellH) * 0.72) / Math.max(1, want)))
    const cx = box.x + ((x + 0.5) / state.meta.width) * box.w
    const cy = box.y + ((y + 0.5) / state.meta.height) * box.h
    atlasPanX = shellW / 2 - cx * atlasScale
    atlasPanY = shellH / 2 - cy * atlasScale
    applyAtlasView()
    inspectAt(Math.round(x) % state.meta.width, Math.max(0, Math.min(state.meta.height - 1, Math.round(y))))
    requestPaint()
  }

  window.addEventListener(APP_EVENTS.FOCUS_CONTINENT, (ev) => {
    const detail = (ev as CustomEvent).detail as ContinentFocusDetail | undefined
    if (!detail || !state.world) return
    if (detail.id < 0) {
      flags.focusContinentId = null
      refreshGazetteer()
      render({ remount: false })
      return
    }
    flags.focusContinentId = detail.id
    frameContinent(detail.x, detail.y, detail.span)
    refreshGazetteer()
  })

  window.addEventListener(APP_EVENTS.BUILD_CONTINENT, (ev) => {
    const detail = (ev as CustomEvent).detail as ContinentFocusDetail | undefined
    if (!detail || !state.world) return
    const added = fillContinent(state.world, detail.id)
    ensureWorldbuild(state.world, flags.polityCount)
    flags.focusContinentId = detail.id
    applyWorldbuildAct('kingdoms')
    const land = listContinents(state.world).find((c) => c.id === detail.id)
    frameContinent(detail.x, detail.y, detail.span)
    announce(
      'success',
      added
        ? `${added} towns on ${land?.name ?? 'that land'}. Write the kingdoms that sit there.`
        : `Write the kingdoms on ${land?.name ?? 'that land'}.`,
    )
    refreshGazetteer()
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.LORE_EDIT, (ev) => {
    const detail = (ev as CustomEvent).detail as LoreEditDetail | undefined
    if (!detail || !state.world) return
    const polity = state.world.polities.find((p) => p.id === detail.id)
    if (!polity) return
    const text = detail.text.trim().slice(0, detail.field === 'sigil' ? 24 : 280)
    if (detail.field === 'sigil') polity.sigil = text || undefined
    else if (detail.field === 'history') polity.history = text || undefined
    else polity.notes = text || undefined
    refreshGazetteer()
  })

  window.addEventListener(APP_EVENTS.GOTO_CELL, (ev) => {
    const detail = (ev as CustomEvent).detail as GotoCellDetail | undefined
    if (!detail) return
    if (flags.viewMode !== 'atlas') {
      flags.viewMode = 'atlas'
      updateMapShell(map, buildView(bundle))
    }
    const box = letterboxCss()
    if (!box) return
    atlasScale = Math.max(atlasScale, 3.2)
    const cx = box.x + ((detail.x + 0.5) / state.meta.width) * box.w
    const cy = box.y + ((detail.y + 0.5) / state.meta.height) * box.h
    atlasPanX = map.canvas.offsetWidth / 2 - cx * atlasScale
    atlasPanY = map.canvas.offsetHeight / 2 - cy * atlasScale
    applyAtlasView()
    inspectAt(detail.x, detail.y)
    refreshGazetteer()
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.TOGGLE_INSPECTOR, (ev) => {
    const detail = (ev as CustomEvent).detail as InspectorSheetDetail | undefined
    const next = detail?.sheet ?? (root.classList.contains('is-sheet-inspect') ? 'tools' : 'inspect')
    root.classList.toggle('is-sheet-tools', next === 'tools')
    root.classList.toggle('is-sheet-inspect', next === 'inspect')
    for (const btn of Array.from(map.root.querySelectorAll<HTMLButtonElement>('.sheet-dock-btn'))) {
      btn.classList.toggle('active', btn.dataset.sheet === next)
    }
  })

  window.addEventListener(APP_EVENTS.VIEW_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as ViewChangeDetail | undefined
    if (!detail) return
    if (detail.view === 'planet' && !showingDerivedWorld(state)) {
      announce('warn', 'Planet view needs a grounded world — run Make sense first.')
      return
    }
    flags.viewMode = detail.view
    if (detail.view === 'planet') planetLayout = { w: 0, h: 0 }
    updateMapShell(map, buildView(bundle))
    applyAtlasView()
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.SEASON_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as SeasonChangeDetail | undefined
    if (!detail || !showingDerivedWorld(state)) return
    flags.season = detail.season
    updateMapShell(map, buildView(bundle))
    applyAtlasView()
    requestPaint()
  })

  window.addEventListener('resize', () => requestPaint())

  window.addEventListener('keydown', (e) => {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
    if (!chrome.accountSheet.hidden) return
    const meta = e.metaKey || e.ctrlKey
    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      window.dispatchEvent(new Event(e.shiftKey ? APP_EVENTS.REDO : APP_EVENTS.UNDO))
      return
    }
    if (state.stage !== 'sketch') return
    if (e.key === '[' || e.key === ']') {
      const delta = e.key === ']' ? 2 : -2
      state.brushSize = Math.min(48, Math.max(2, state.brushSize + delta))
      if (toolsRefs) updateStageTools(toolsRefs, buildView(bundle))
      return
    }
    if (e.key === '1') {
      state.tool = 'draw-land'
      flags.sketchPlane = 'land'
    } else if (e.key === '2') {
      state.tool = 'erase-land'
      flags.sketchPlane = 'land'
    } else if (e.key === '3') {
      state.tool = 'draw-ridge'
      flags.sketchPlane = 'notes'
    } else if (e.key === '4') {
      state.tool = 'fill-mask'
      flags.sketchPlane = 'land'
    } else if (e.key === '5') {
      state.tool = 'erase-channel'
      flags.sketchPlane = 'notes'
    } else if (e.key === '6') {
      state.tool = 'mark-hills'
      flags.sketchPlane = 'notes'
    } else if (e.key === '7') {
      state.tool = 'mark-forest'
      flags.sketchPlane = 'notes'
    } else if (e.key === '8') {
      state.tool = 'mark-swamp'
      flags.sketchPlane = 'notes'
    } else if (e.key === '9') {
      state.tool = 'mark-town'
      flags.sketchPlane = 'notes'
    } else if (e.key === '0') {
      state.tool = 'wipe-note'
      flags.sketchPlane = 'notes'
    } else if (e.key === 'i' || e.key === 'I') state.tool = 'inspect'
    else return
    const preset = presetBrushForTool(state.tool)
    if (preset != null) state.brushSize = preset
    if (isSketchNoteTool(state.tool)) {
      announceCoach({ kind: 'sketch.decorate', tool: state.tool })
    }
    render({ remount: true })
  })

  attachCanvas()
  attachGlobe()
  render({ remount: true })
  announceCoach({
    kind: 'sketch.ready',
    width: state.meta.width,
    height: state.meta.height,
    landCells: 0,
  })
}
