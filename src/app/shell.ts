/**
 * Shell: 4-stage editor. Geoform-1 chrome, v2 World.
 *
 * Writers paint land on empty ocean. Critique names what is wrong.
 * Make sense derives the closest geographically honest planet.
 * Worldbuild places cities on that planet.
 */

import type { EditorState, Layer, WorldOverlay } from '../world/types'
import { DEFAULT_META } from '../world/types'
import {
  APP_EVENTS,
  MAKE_SENSE_STEP_INDEX,
  STAGES,
  type BrushChangeDetail,
  type LandformDragDetail,
  type LayerChangeDetail,
  type MetaChangeDetail,
  type SeasonChangeDetail,
  type ShellStateView,
  type StageTransitionDetail,
  type ToolChangeDetail,
  type ContinentCountDetail,
  type OverlayChangeDetail,
  type PolityCountDetail,
  type LayoutChangeDetail,
  type ViewChangeDetail,
  type AccountSubmitDetail,
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
  updateAccountChrome,
  updateChrome,
  updateInspector,
  updateMapShell,
  updateStageTools,
  worldInspectHtml,
  type ToolsRefs,
} from './ui'
import { cellFromPointer, paintAtlas } from './atlas'
import { inspectCell } from '../render/draw'
import { createMaskBrushes, fireCommitHook } from '../sketch/maskBrushes'
import { landformStampCopy, stampLandformAt, clampContinentCount, isLandformKind, shrinkLandBlob, landformStampSeed, landBlobContains } from '../sketch/landforms'
import { placeCity, removeNearestCity } from '../sketch/worldbuild'
import { inferSettlementRole, seedSettlements, annotateSettlement } from '../sketch/settlements'
import {
  analogAt,
  economyLine,
  ensureWorldbuild,
  meltingPotLabel,
  nearestPolityId,
  paintClaim,
  polityAt,
  refreshWorldbuildAfterPaint,
  defaultPolityCount,
  clampPolityCount,
} from '../sketch/polities'
import {
  makeSenseInline,
  provenanceFromResult,
  worldFromMakeSense,
} from '../pipeline/makeSense'
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
  worldOverlay: WorldOverlay
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
    worldOverlay: 'countries',
  }
  return { state, flags }
}

function buildView(bundle: ShellBundle): ShellStateView {
  return { ...bundle.state, ...bundle.flags }
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

  root.classList.add('app', 'is-layout-chrome')

  const chrome = mountChrome()
  const map = mountMapShell()
  const inspector = mountInspector()
  const toolsHost = document.createElement('aside')
  toolsHost.className = 'panel tools-panel'
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
  } | null = null
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
  const DRAG_HIDE_PX = 10

  function beginPointerStroke(clientX: number, clientY: number): void {
    painting = true
    dragOrigin = { x: clientX, y: clientY }
  }

  function hideChromeIfDragging(clientX: number, clientY: number): void {
    if (stampDrag || flags.layoutMode === 'view-map' || flags.makeSenseComplete) return
    if (state.stage !== 'sketch') return
    if (state.tool !== 'draw-land' && state.tool !== 'erase-land') return
    if (!painting || !dragOrigin) return
    const dx = clientX - dragOrigin.x
    const dy = clientY - dragOrigin.y
    if (dx * dx + dy * dy < DRAG_HIDE_PX * DRAG_HIDE_PX) return
    root.classList.add('is-doodling')
  }

  function setStampCursor(clientX: number, clientY: number, onMap: boolean): void {
    map.stampCursor.hidden = !stampDrag
    map.stampHint.hidden = !stampDrag
    root.classList.toggle('is-stamping', Boolean(stampDrag && onMap))
    if (!stampDrag) return
    const w = map.stampCursor.offsetWidth || 96
    const h = map.stampCursor.offsetHeight || 48
    map.stampCursor.style.left = `${clientX - w / 2}px`
    map.stampCursor.style.top = `${clientY - h / 2}px`
  }

  function clearStampDrag(): void {
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
    const remount = opts.remount || !toolsRefs || toolsRefs.stage !== state.stage
    if (remount) {
      toolsRefs = mountStageTools(view)
      toolsHost.replaceChildren(toolsRefs.root)
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
      mask: stampDrag ? stampDrag.snapshot : flags.mask,
      meta: state.meta,
      layer: flags.layer,
      season: flags.season,
      issues: state.stage === 'critique' ? state.issues : [],
      showCities: Boolean(showWorld && state.world && state.world.cities.length > 0),
      preview: painting && !showWorld,
      worldOverlay: state.stage === 'worldbuild' ? flags.worldOverlay : null,
    })
  }

  function ensureMask(): Float32Array {
    if (!flags.mask) {
      flags.mask = new Float32Array(state.meta.width * state.meta.height)
      bindMask(flags.mask)
    }
    return flags.mask
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

  function inspectAt(x: number, y: number): void {
    const i = y * state.meta.width + x
    if (showingDerivedWorld(state) && state.world) {
      const cell = inspectCell(state.world, x, y)
      const land = state.world.mask[i] >= state.world.meta.threshold
      const p = polityAt(state.world, x, y)
      const analog = land ? analogAt(state.world, x, y) : null
      const capital = p
        ? state.world.cities.find((c) => c.x === p.capitalX && c.y === p.capitalY)
        : undefined
      flags.inspectHtml = worldInspectHtml(cell.display, x, y, land, {
        polity: p?.name,
        analog: analog?.label,
        because: analog?.because,
        tradition: p?.tradition ?? analog?.tradition,
        economy: p ? economyLine(p) : undefined,
        mix: capital && p ? meltingPotLabel(p.meltingPot) : undefined,
      })
    } else {
      const land = Boolean(flags.mask && flags.mask[i] >= state.meta.threshold)
      flags.inspectHtml = sketchInspectHtml(x, y, land)
    }
    updateInspector(inspector, buildView(bundle))
  }

  function enterSketchSurface(from: typeof state.stage | null): void {
    flags.viewMode = 'atlas'
    flags.inspectHtml = emptyInspectHint(false)
    flags.layer = 'relief'
    if (from && from !== 'sketch') {
      announce(
        'info',
        'This is the doodle, not the planet. Paint or stamp, then Critique — Make sense derives geography again.',
      )
    }
  }

  function attachCanvas(): void {
    const canvas = map.canvas

    let lastPaintCell: { x: number; y: number } | null = null
    let downCell: { x: number; y: number } | null = null
    let strokeMoved = false

    const onPoint = (clientX: number, clientY: number, isDown: boolean, paintStroke: boolean) => {
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
        if (state.tool === 'inspect') return
        if (hovering) return
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

      if (!paintStroke) return
      if (state.stage !== 'sketch') return
      if (state.tool !== 'draw-land' && state.tool !== 'erase-land') return

      lastStamp = null
      if (state.world) invalidateDerivedWorld()

      const mask = ensureMask()
      brushes.dab({
        mask,
        meta: state.meta,
        cx: x,
        cy: y,
        brushSize: state.brushSize,
        strength: state.strength,
        tool: state.tool,
      })
      lastPaintCell = { x, y }
      requestPaint()
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (stampDrag) {
        e.preventDefault()
        return
      }
      beginPointerStroke(e.clientX, e.clientY)
      strokeMoved = false
      downCell = cellFromPointer(canvas, e.clientX, e.clientY, state.meta.width, state.meta.height)
      lastPaintCell = downCell
      canvas.setPointerCapture?.(e.pointerId)
      onPoint(e.clientX, e.clientY, true, false)
    })
    canvas.addEventListener('pointermove', (e) => {
      hideChromeIfDragging(e.clientX, e.clientY)
      if (stampDrag) return
      if (painting && dragOrigin) {
        const dx = e.clientX - dragOrigin.x
        const dy = e.clientY - dragOrigin.y
        if (dx * dx + dy * dy >= DRAG_HIDE_PX * DRAG_HIDE_PX) {
          if (
            !strokeMoved &&
            downCell &&
            (state.tool === 'draw-land' || state.tool === 'erase-land' || state.tool === 'claim-land')
          ) {
            strokeMoved = true
            onPoint(dragOrigin.x, dragOrigin.y, true, true)
          }
          if (strokeMoved) onPoint(e.clientX, e.clientY, true, true)
          return
        }
      }
      onPoint(e.clientX, e.clientY, false, false)
    })
    canvas.addEventListener('pointerup', () => {
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
          announce('success', 'Smaller. Click again to shrink more.')
        }
      }
      if (state.tool === 'claim-land' && state.world && state.stage === 'worldbuild') {
        refreshWorldbuildAfterPaint(state.world)
      }
      endPointerStroke()
      downCell = null
      strokeMoved = false
      if (lastPaintCell) inspectAt(lastPaintCell.x, lastPaintCell.y)
      render()
    })
    canvas.addEventListener('pointercancel', () => {
      endPointerStroke()
      downCell = null
      strokeMoved = false
      render()
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
    if (!STAGES[target].canEnter(view)) {
      announce('warn', 'That stage is not open yet.')
      return
    }
    const from = state.stage
    STAGES[from].leave(view)
    state.stage = target
    if (target === 'worldbuild' && state.tool !== 'place-city' && state.tool !== 'remove-city') {
      state.tool = 'place-city'
    }
    if (target === 'sketch' && state.tool !== 'draw-land' && state.tool !== 'erase-land' && state.tool !== 'inspect') {
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
    } else if (flags.mask) {
      const json = serializeMask(state.meta, flags.mask)
      const bytes = json.length
      const ok = saveMask(state.meta, flags.mask)
      announceCoach(
        ok
          ? { kind: 'persist.saved', key: 'mask', bytes, ok: true }
          : { kind: 'persist.failed', key: 'mask', reason: 'quota', bytes },
      )
    } else {
      announceCoach({ kind: 'persist.failed', key: 'mask', reason: 'shape', bytes: 0 })
    }
  })

  window.addEventListener(APP_EVENTS.DOWNLOAD, () => {
    if (state.world) {
      downloadWorld(state.world)
      announce('success', 'Downloaded the world as JSON.')
    } else if (flags.mask) {
      downloadMask(state.meta, flags.mask)
      announce('success', 'Downloaded the sketch mask as JSON.')
    } else {
      announce('warn', 'Nothing to download yet.')
    }
  })

  const STAMP_CLICK_PX = 12
  const STAMP_SHRINK = 0.78
  const STAMP_MIN_SCALE = 0.32
  let stampEndLock = false

  function pointerOverChrome(clientX: number, clientY: number): boolean {
    for (const sel of ['.tools-panel', '.inspector', '.topnav', '.ux-stage-rail']) {
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

  function applyStampPointer(clientX: number, clientY: number, ended: boolean): void {
    if (!stampDrag || state.stage !== 'sketch' || state.isProcessing) return
    const { kind, scale, stampSeed } = stampDrag
    const cell = cellFromPointer(map.canvas, clientX, clientY, state.meta.width, state.meta.height)
    if (cell) stampDrag.lastCell = cell
    setStampCursor(clientX, clientY, Boolean(cell))
    if (!ended) return
    if (stampEndLock) return
    stampEndLock = true
    queueMicrotask(() => {
      stampEndLock = false
    })
    const overChrome = pointerOverChrome(clientX, clientY)
    if (overChrome || !cell) {
      const dx = clientX - stampDrag.originX
      const dy = clientY - stampDrag.originY
      if (dx * dx + dy * dy < STAMP_CLICK_PX * STAMP_CLICK_PX) {
        stampDrag.scale = Math.max(STAMP_MIN_SCALE, stampDrag.scale * STAMP_SHRINK)
        paintLandformThumb(map.stampCursor, kind, stampDrag.scale)
        setStampCursor(clientX, clientY, Boolean(cell))
        announce('info', 'Smaller. Same continent type. Drop it on empty sea, or click again.')
        return
      }
      flags.mask!.set(stampDrag.snapshot)
      clearStampDrag()
      requestPaint()
      return
    }
    if (state.world) invalidateDerivedWorld()
    const mask = ensureMask()
    mask.set(stampDrag.snapshot)
    stampLandformAt(mask, state.meta, kind, state.meta.seed, cell.x, cell.y, scale, stampSeed)
    lastStamp = {
      kind,
      seed: stampSeed,
      scale,
      x: cell.x,
      y: cell.y,
      before: new Float32Array(stampDrag.snapshot),
    }
    bindMask(mask)
    clearStampDrag()
    announce('success', landformStampCopy(kind))
    render()
  }

  window.addEventListener(APP_EVENTS.LANDFORM_DRAG, (ev) => {
    if (state.stage !== 'sketch' || state.isProcessing) return
    const detail = (ev as CustomEvent<LandformDragDetail>).detail
    if (!detail || !isLandformKind(detail.kind)) return
    const { kind, phase, clientX, clientY } = detail
    if (phase === 'start') {
      const mask = ensureMask()
      stampDrag = {
        kind,
        snapshot: new Float32Array(mask),
        stampSeed: landformStampSeed(mask, state.meta.threshold, state.meta.seed),
        scale: 1,
        originX: clientX,
        originY: clientY,
        lastCell: null,
      }
      paintLandformThumb(map.stampCursor, kind, 1)
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
    clearStampDrag()
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.CLEAR_SEA, () => {
    const w = state.meta.width
    const h = state.meta.height
    flags.mask = new Float32Array(w * h)
    bindMask(flags.mask)
    invalidateDerivedWorld()
    state.stage = 'sketch'
    state.tool = 'draw-land'
    state.isProcessing = false
    flags.inspectHtml = emptyInspectHint()
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
    if (state.stage !== 'sketch') return
    const mask = ensureMask()
    flags.maskCommitted = true
    const result = critiqueMask(mask, state.meta, state.meta.threshold)
    state.issues = result.issues
    flags.score = result.score
    fireCommitHook(brushes, state.meta, mask)
    const crit = { critical: 0, major: 0, minor: 0 }
    for (const issue of result.issues) crit[issue.severity]++
    announceCoach({
      kind: 'critique.grade',
      score: result.score,
      issueCount: result.issues.length,
      criticalCount: crit.critical,
      majorCount: crit.major,
      minorCount: crit.minor,
    })
    state.stage = 'critique'
    render({ remount: true })
  })

  window.addEventListener(APP_EVENTS.MAKE_SENSE, () => {
    if (state.stage !== 'critique' && state.stage !== 'make-sense') return
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
      const result = await makeSenseInline({ meta: state.meta, mask }, (step) => {
        flags.pipelineStep = MAKE_SENSE_STEP_INDEX[step.stepName] ?? flags.pipelineStep
        inspector.workHost.replaceChildren(mountStageWork(buildView(bundle)))
      })
      const world = worldFromMakeSense(result, state.meta, mask)
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
    state.tool = 'place-city'
    flags.worldOverlay = 'countries'
    if (state.world) ensureWorldbuild(state.world, flags.polityCount)
    render({ remount: true })
    STAGES[state.stage].enter(view)
    announceCoach({ kind: 'app.stage', from: 'make-sense', to: 'worldbuild', trigger: 'user' })
  })

  window.addEventListener(APP_EVENTS.BACK_TO_SKETCH, () => {
    const view = buildView(bundle)
    const from = state.stage
    STAGES[state.stage].leave(view)
    state.stage = 'sketch'
    state.tool = 'draw-land'
    enterSketchSurface(from)
    render({ remount: true })
    announceCoach({ kind: 'app.stage', from: 'worldbuild', to: 'sketch', trigger: 'user' })
  })

  window.addEventListener(APP_EVENTS.TOOL_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as ToolChangeDetail | undefined
    if (!detail) return
    state.tool = detail.tool
    announceCoach({ kind: 'tool.changed', tool: detail.tool })
    render()
  })

  window.addEventListener(APP_EVENTS.META_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as MetaChangeDetail | undefined
    if (!detail) return
    if (flags.makeSenseComplete) return
    state.meta = { ...state.meta, ...detail.meta }
    render()
  })

  window.addEventListener(APP_EVENTS.BRUSH_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as BrushChangeDetail | undefined
    if (!detail) return
    state.brushSize = detail.size
    if (toolsRefs) updateStageTools(toolsRefs, buildView(bundle))
    updateMapShell(map, buildView(bundle))
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
    if (toolsRefs) updateStageTools(toolsRefs, buildView(bundle))
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.LAYOUT_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as LayoutChangeDetail | undefined
    if (!detail) return
    flags.layoutMode = detail.layout
    syncLayoutClasses()
    updateMapShell(map, buildView(bundle))
  })

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (stampDrag) {
      e.preventDefault()
      flags.mask?.set(stampDrag.snapshot)
      clearStampDrag()
      requestPaint()
      return
    }
    if (flags.layoutMode !== 'view-map') return
    e.preventDefault()
    exitViewMap()
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
    requestPaint()
  })

  window.addEventListener(APP_EVENTS.SEASON_CHANGE, (ev) => {
    const detail = (ev as CustomEvent).detail as SeasonChangeDetail | undefined
    if (!detail || !showingDerivedWorld(state)) return
    flags.season = detail.season
    updateMapShell(map, buildView(bundle))
    requestPaint()
  })

  window.addEventListener('resize', () => requestPaint())

  window.addEventListener('keydown', (e) => {
    const t = e.target
    if (e.key === 'Escape' && !chrome.accountSheet.hidden) {
      chrome.accountSheet.hidden = true
      return
    }
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
    if (!chrome.accountSheet.hidden) return
    if (state.stage === 'sketch') {
      if (e.key === '1') state.tool = 'draw-land'
      else if (e.key === '2') state.tool = 'erase-land'
      else if (e.key === 'i' || e.key === 'I') state.tool = 'inspect'
      else return
      render()
    }
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
