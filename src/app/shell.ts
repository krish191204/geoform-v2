/**
 * Shell: 4-stage editor. Geoform-1 chrome, v2 World.
 *
 * Writers paint land on empty ocean. Critique names what is wrong.
 * Make sense derives the closest geographically honest planet.
 * Worldbuild places cities on that planet.
 */

import type { EditorState, Layer } from '../world/types'
import { DEFAULT_META } from '../world/types'
import {
  APP_EVENTS,
  MAKE_SENSE_STEP_INDEX,
  STAGES,
  type BrushChangeDetail,
  type LandformStampDetail,
  type LayerChangeDetail,
  type MetaChangeDetail,
  type SeasonChangeDetail,
  type ShellStateView,
  type StageTransitionDetail,
  type ToolChangeDetail,
  type ViewChangeDetail,
} from './stages'
import {
  emptyInspectHint,
  mountChrome,
  mountInspector,
  mountMapShell,
  mountStageTools,
  mountStageWork,
  showingDerivedWorld,
  sketchInspectHtml,
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
import { landformStampCopy, stampLandform } from '../sketch/landforms'
import { placeCity, removeNearestCity } from '../sketch/worldbuild'
import { inferSettlementRole, seedSettlements } from '../sketch/settlements'
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
} from '../world/persist'
import { announce as announceCoach } from './coach'

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

  root.classList.add('app')

  const chrome = mountChrome()
  const map = mountMapShell()
  const inspector = mountInspector()
  const toolsHost = document.createElement('aside')
  toolsHost.className = 'panel tools-panel'
  const layout = document.createElement('div')
  layout.className = 'layout'
  layout.append(toolsHost, map.root, inspector.root)
  root.append(chrome.root, layout)

  let toolsRefs: ToolsRefs | null = null
  let painting = false
  let paintRaf = 0
  let planet: import('../render/globe').PlanetView | null = null
  let planetLoad: Promise<import('../render/globe').PlanetView | null> | null = null
  let planetLayout = { w: 0, h: 0 }
  let planetPaintGen = 0

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
      mask: flags.mask,
      meta: state.meta,
      layer: flags.layer,
      season: flags.season,
      issues: state.stage === 'critique' ? state.issues : [],
      showCities: Boolean(showWorld && state.world && state.world.cities.length > 0),
      preview: painting && !showWorld,
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
      flags.inspectHtml = worldInspectHtml(cell.display, x, y, land)
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

    const onPoint = (clientX: number, clientY: number, isDown: boolean) => {
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
            result.city.role = inferSettlementRole(state.world, x, y)
            announce('success', `${result.city.name} founded.`)
          }
        } else {
          const result = removeNearestCity(state.world, x, y)
          if (!result.matched) announce('warn', 'No city within range.')
        }
        render()
        return
      }

      if (state.stage !== 'sketch') return
      if (state.tool !== 'draw-land' && state.tool !== 'erase-land') return

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
      painting = true
      canvas.setPointerCapture?.(e.pointerId)
      onPoint(e.clientX, e.clientY, true)
    })
    canvas.addEventListener('pointermove', (e) => {
      onPoint(e.clientX, e.clientY, false)
    })
    canvas.addEventListener('pointerup', () => {
      painting = false
      if (lastPaintCell) inspectAt(lastPaintCell.x, lastPaintCell.y)
      render()
    })
    canvas.addEventListener('pointercancel', () => {
      painting = false
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
      planet.onPointerDown(e.clientX, e.clientY)
    })
    globe.addEventListener('pointermove', (e) => {
      if (!planet) return
      if (planet.onPointerMove(e.clientX, e.clientY)) {
        moved = true
        planet.render()
      } else if (state.world) {
        const cell = planet.pick(e.clientX, e.clientY, state.world)
        if (cell) inspectAt(cell.x, cell.y)
      }
    })
    globe.addEventListener('pointerup', (e) => {
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
                result.city.role = inferSettlementRole(state.world, x, y)
                announce('success', `${result.city.name} founded.`)
              }
            } else {
              const result = removeNearestCity(state.world, x, y)
              if (!result.matched) announce('warn', 'No city within range.')
            }
            render()
          }
        }
      }
      planet.onPointerUp()
    })
    globe.addEventListener('pointercancel', () => planet?.onPointerUp())
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

  function showSaveResult(ok: boolean, subject: 'world' | 'sketch'): void {
    chrome.saveMeta.classList.toggle('is-saved', ok)
    chrome.saveMeta.classList.toggle('is-error', !ok)
    chrome.saveMeta.textContent = ok
      ? `${subject === 'world' ? 'World' : 'Sketch'} saved`
      : 'Save failed'
  }

  window.addEventListener(APP_EVENTS.SAVE, () => {
    if (state.world) {
      const json = serializeWorld(state.world)
      const bytes = json.length
      const ok = saveWorld(state.world)
      showSaveResult(ok, 'world')
      announceCoach(
        ok
          ? { kind: 'persist.saved', key: 'world', bytes, ok: true }
          : { kind: 'persist.failed', key: 'world', reason: 'quota', bytes },
      )
    } else if (flags.mask) {
      const json = serializeMask(state.meta, flags.mask)
      const bytes = json.length
      const ok = saveMask(state.meta, flags.mask)
      showSaveResult(ok, 'sketch')
      announceCoach(
        ok
          ? { kind: 'persist.saved', key: 'mask', bytes, ok: true }
          : { kind: 'persist.failed', key: 'mask', reason: 'quota', bytes },
      )
    } else {
      showSaveResult(false, 'sketch')
      announceCoach({ kind: 'persist.failed', key: 'mask', reason: 'shape', bytes: 0 })
    }
  })

  window.addEventListener(APP_EVENTS.STAMP_LANDFORM, (ev) => {
    if (state.stage !== 'sketch' || state.isProcessing) return
    const kind = (ev as CustomEvent<LandformStampDetail>).detail?.kind
    if (kind !== 'continents' && kind !== 'mixed' && kind !== 'islands') return
    if (state.world) invalidateDerivedWorld()
    const mask = ensureMask()
    stampLandform(mask, state.meta, kind, state.meta.seed)
    bindMask(mask)
    announce('success', landformStampCopy(kind))
    render()
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
      letter: result.grade.letter,
      scope: result.grade.scope,
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
      const added = seedSettlements(world)
      const provenance = provenanceFromResult(result)
      state.world = world
      const c = critiqueWorld(world)
      provenance.scoreAfter = c.score
      provenance.scoreBefore = flags.score
      state.provenance = provenance
      state.issues = c.issues
      flags.score = c.score
      flags.makeSenseComplete = true
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
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
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
