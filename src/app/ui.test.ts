// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { DEFAULT_META } from '../world/types'
import type { World } from '../world/types'
import type { ShellStateView } from './stages'
import {
  emptyInspectHint,
  mountChrome,
  mountInspector,
  mountMapShell,
  mountStageTools,
  mountStageWork,
  niceScaleKm,
  showingDerivedWorld,
  updateChrome,
  updateInspector,
  updateMapShell,
} from './ui'
import { paintModeForTool } from './stages'
import { mountApp } from './shell'

function view(over: Partial<ShellStateView> = {}): ShellStateView {
  return {
    stage: 'sketch',
    world: null,
    meta: { ...DEFAULT_META },
    tool: 'draw-land',
    brushSize: 22,
    strength: 1,
    issues: [],
    provenance: null,
    isProcessing: false,
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
    worldOverlay: 'countries',
    canUndo: false,
    canRedo: false,
    sketchPlane: 'land',
    hasSketchNotes: false,
    ...over,
  }
}

describe('updateChrome aria-current', () => {
  it('marks only the active writer stage as current and skips Critique', () => {
    const chrome = mountChrome()
    expect(chrome.root.querySelector('[data-stage="critique"]')).toBeNull()
    expect(Object.keys(chrome.stageButtons).sort()).toEqual(['make-sense', 'sketch', 'worldbuild'])
    updateChrome(chrome, view({ stage: 'sketch' }))
    expect(chrome.stageButtons.sketch.getAttribute('aria-current')).toBe('step')
    expect(chrome.stageButtons['make-sense'].hasAttribute('aria-current')).toBe(false)
    expect(chrome.stageButtons.worldbuild.hasAttribute('aria-current')).toBe(false)
  })

  it('shows the four worldbuild chapters only after Make sense', () => {
    const chrome = mountChrome()
    updateChrome(chrome, view({ stage: 'sketch' }))
    expect(chrome.actRail.hidden).toBe(true)
    updateChrome(chrome, view({ stage: 'worldbuild', makeSenseComplete: true, worldbuildAct: 'kingdoms' }))
    expect(chrome.actRail.hidden).toBe(false)
    expect(chrome.actButtons.kingdoms.getAttribute('aria-current')).toBe('step')
    expect(chrome.actButtons.land.hasAttribute('aria-current')).toBe(false)
  })

  it('offers Download JSON after land exists, not on empty ocean', () => {
    const chrome = mountChrome()
    expect(chrome.downloadBtn.textContent).toMatch(/Download JSON/)
    updateChrome(chrome, view())
    expect(chrome.downloadBtn.hidden).toBe(true)
    expect(chrome.saveMeta.hidden).toBe(true)
    const mask = new Float32Array(DEFAULT_META.width * DEFAULT_META.height)
    mask[0] = 1
    updateChrome(chrome, view({ mask }))
    expect(chrome.downloadBtn.hidden).toBe(false)
    expect(chrome.downloadBtn.disabled).toBe(false)
  })

  it('opens a Sign in sheet that does not invent a password store', () => {
    const chrome = mountChrome()
    expect(chrome.accountBtn.textContent).toBe('Sign in')
    expect(chrome.accountSheet.hidden).toBe(true)
    chrome.accountBtn.click()
    expect(chrome.accountSheet.hidden).toBe(false)
    expect(chrome.accountSheet.textContent).toMatch(/map stays in this browser/i)
    expect(chrome.accountSheet.querySelector('.account-unwired')).toBeTruthy()
    expect(chrome.accountSheet.querySelector('input[type="password"]')).toBeTruthy()
  })
})

describe('inspector first-run', () => {
  it('hides Inspector geography on empty ocean, then shows a sketch readout', () => {
    const inspector = mountInspector()
    updateInspector(inspector, view())
    expect((inspector.root.querySelector('.inspect-block') as HTMLElement).hidden).toBe(true)
    const mask = new Float32Array(DEFAULT_META.width * DEFAULT_META.height)
    mask[0] = 1
    updateInspector(inspector, view({ mask }))
    expect((inspector.root.querySelector('.inspect-block') as HTMLElement).hidden).toBe(false)
    expect(inspector.status.textContent).toContain('not geography yet')
    updateInspector(inspector, view({ tool: 'draw-ridge' }))
    expect((inspector.root.querySelector('.inspect-block') as HTMLElement).hidden).toBe(false)
    expect(inspector.inspect.textContent).toMatch(/mountain range/i)
    updateInspector(
      inspector,
      view({
        world: { biome: ['ocean'] } as unknown as World,
        stage: 'worldbuild',
        makeSenseComplete: true,
      }),
    )
    expect((inspector.root.querySelector('.inspect-block') as HTMLElement).hidden).toBe(false)
  })

  it('retitles Coach to Gazetteer in worldbuild and keeps a collapse control', () => {
    const inspector = mountInspector()
    updateInspector(inspector, view({ stage: 'sketch' }))
    expect(inspector.root.querySelector('.panel-title')?.textContent).toBe('Coach')
    updateInspector(
      inspector,
      view({
        stage: 'worldbuild',
        makeSenseComplete: true,
        world: { biome: ['ocean'] } as unknown as World,
      }),
    )
    expect(inspector.root.querySelector('.panel-title')?.textContent).toBe('Gazetteer')
    expect(inspector.root.querySelector('.panel-collapse')).toBeTruthy()
    expect(inspector.root.querySelector('.gazetteer-status')).toBeTruthy()
  })

  it('collapses the coach to a title bar so the map is clear', () => {
    const inspector = mountInspector()
    inspector.root.style.width = '360px'
    inspector.root.style.height = '480px'
    const collapse = inspector.root.querySelector('.panel-collapse') as HTMLButtonElement
    expect(collapse.textContent).toBe('Hide')
    collapse.click()
    expect(inspector.root.classList.contains('is-collapsed')).toBe(true)
    expect(collapse.textContent).toBe('Show')
    expect(collapse.getAttribute('aria-label')).toBe('Show gazetteer')
    collapse.click()
    expect(inspector.root.classList.contains('is-collapsed')).toBe(false)
    expect(collapse.textContent).toBe('Hide')
    expect(collapse.getAttribute('aria-label')).toBe('Hide gazetteer')
  })

  it('lets the coach panel float from its title and dock on double-click', () => {
    const app = document.createElement('div')
    app.className = 'app'
    document.body.append(app)
    const inspector = mountInspector()
    app.append(inspector.root)
    const title = inspector.root.querySelector('h2') as HTMLElement
    expect(title).toBeTruthy()

    title.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 100,
        clientY: 100,
        pointerId: 7,
        button: 0,
        bubbles: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 160,
        clientY: 140,
        pointerId: 7,
        bubbles: true,
      }),
    )
    expect(inspector.root.classList.contains('is-floating')).toBe(true)
    expect(inspector.root.style.left).toMatch(/px/)

    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true }))
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(inspector.root.classList.contains('is-floating')).toBe(false)
    app.remove()
  })

  it('lets the coach panel float from a mouse drag on the title bar', () => {
    const app = document.createElement('div')
    app.className = 'app'
    document.body.append(app)
    const inspector = mountInspector()
    app.append(inspector.root)
    const head = inspector.root.querySelector('.panel-head') as HTMLElement
    inspector.root.getBoundingClientRect = () =>
      ({
        x: 700,
        y: 80,
        left: 700,
        top: 80,
        width: 276,
        height: 400,
        right: 976,
        bottom: 480,
        toJSON: () => ({}),
      }) as DOMRect
    head.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 180, clientY: 160, bubbles: true }))
    expect(inspector.root.classList.contains('is-floating')).toBe(true)
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 180, clientY: 160, bubbles: true }))
    app.remove()
  })

  it('lets the coach panel be resized from the left edge', () => {
    localStorage.removeItem('geoform:coachSize:v1')
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    const app = document.createElement('div')
    app.className = 'app'
    document.body.append(app)
    const inspector = mountInspector()
    app.append(inspector.root)
    inspector.root.getBoundingClientRect = () =>
      ({
        x: 700,
        y: 80,
        left: 700,
        top: 80,
        width: 276,
        height: 400,
        right: 976,
        bottom: 480,
        toJSON: () => ({}),
      }) as DOMRect
    const grip = inspector.root.querySelector('.inspector-resize-x') as HTMLElement
    expect(grip).toBeTruthy()
    grip.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 700,
        clientY: 200,
        pointerId: 9,
        button: 0,
        bubbles: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 620,
        clientY: 200,
        pointerId: 9,
        bubbles: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 620,
        clientY: 200,
        pointerId: 9,
        bubbles: true,
      }),
    )
    expect(inspector.root.style.width).toBe('356px')
    expect(JSON.parse(localStorage.getItem('geoform:coachSize:v1') ?? '{}').width).toBe(356)
    grip.dispatchEvent(new Event('dblclick', { bubbles: true }))
    expect(inspector.root.style.width).toBe('')
    expect(localStorage.getItem('geoform:coachSize:v1')).toBeNull()
    app.remove()
  })
})

describe('updateMapShell hint and HUD', () => {
  it('picks a round km length whose bar sits near the target width', () => {
    const a = niceScaleKm(0.2) // 5 px/km → ~500 km at 100 px
    expect(a.km).toBeGreaterThanOrEqual(100)
    expect(a.px).toBeGreaterThanOrEqual(36)
    expect(a.px).toBeLessThanOrEqual(200)
    const map = mountMapShell()
    expect(map.scaleBar.classList.contains('map-scale')).toBe(true)
    expect(map.scaleBar.hidden).toBe(true)
  })

  it('hides the empty-ocean hint once land exists', () => {
    const map = mountMapShell()
    updateMapShell(map, view())
    expect(map.hint.hidden).toBe(false)
    expect(map.hint.textContent).toMatch(/Drag a picture onto the map/i)

    const mask = new Float32Array(DEFAULT_META.width * DEFAULT_META.height)
    mask[1000] = 1
    updateMapShell(map, view({ mask }))
    expect(map.hint.hidden).toBe(true)
  })

  it('hides the empty-ocean hint for decorate tools and existing notes', () => {
    const map = mountMapShell()
    updateMapShell(map, view({ tool: 'draw-ridge' }))
    expect(map.hint.hidden).toBe(true)
    updateMapShell(map, view({ hasSketchNotes: true }))
    expect(map.hint.hidden).toBe(true)
  })

  it('hides layer chips and Planet HUD on empty Sketch', () => {
    const map = mountMapShell()
    updateMapShell(map, view())
    expect(map.overlay.querySelector('[data-look]')).toBeNull()
    expect(map.seasonBar.children.length).toBe(0)
    expect(map.viewAtlas.parentElement?.hidden).toBe(true)
  })

  it('HUD is Atlas | Planet only', () => {
    const map = mountMapShell()
    const hud = map.root.querySelector('.map-hud')
    expect(hud).toBeTruthy()
    expect(hud?.querySelectorAll('span').length).toBe(0)
    expect(map.viewAtlas.textContent).toBe('Atlas')
    expect(map.viewPlanet.textContent).toBe('Planet')
  })
})

describe('sketch tools', () => {
  it('planet radius step is 1 km so Earth default 6371 is selectable', () => {
    const tools = mountStageTools(view())
    const radius = tools.root.querySelector('#planetRadius') as HTMLInputElement
    expect(radius.step).toBe('1')
    expect(radius.value).toBe('6371')
  })

  it('shows continent stamps and decorate symbols on one Draw panel', () => {
    const tools = mountStageTools(view())
    const chips = Array.from(tools.root.querySelectorAll('[data-landform]'))
    expect(chips.map((el) => el.getAttribute('data-landform'))).toEqual([
      'continents',
      'elongated',
      'peninsula',
      'gulf',
      'mixed',
      'islands',
    ])
    expect(chips.every((el) => el.querySelector('.style-chip-copy'))).toBe(false)
    const thumbs = chips.map((el) => el.querySelector('img.landform-thumb') as HTMLImageElement)
    expect(thumbs.every((img) => img && img.src.startsWith('data:image/png'))).toBe(true)
    expect(tools.root.textContent).toMatch(/Compact/)
    expect(tools.root.textContent).toMatch(/Islands/)
    expect(tools.root.querySelector('[data-tool="draw-land"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="fill-mask"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="draw-ridge"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="mark-forest"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="mark-town"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="inspect"]')).toBeNull()
    expect(tools.root.querySelector('[data-sketch-plane]')).toBeNull()
    expect(tools.root.textContent).toMatch(/Mountain/)
    expect(tools.root.textContent).toMatch(/Forest/)
    expect(tools.root.textContent).toMatch(/Decorate/)
    const html = tools.root.innerHTML
    expect(html.indexOf('data-landform=')).toBeLessThan(html.indexOf('data-tool="draw-land"'))
    expect(tools.root.querySelector('#undoBtn')).toBeTruthy()
    expect(tools.root.querySelector('#brushStrength')).toBeTruthy()
    expect(tools.root.querySelector('#planetTilt')).toBeTruthy()
    expect(tools.root.querySelector('#shuffleSeed')).toBeTruthy()
    expect(tools.root.querySelector('#continentCountVal')).toBeNull()
    expect(tools.root.querySelector('small')).toBeNull()
    expect(paintModeForTool('draw-ridge')).toBeNull()
    expect(paintModeForTool('mark-forest')).toBeNull()
    expect(paintModeForTool('draw-land')).toBe('draw-land')
  })

  it('puts Make sense in the inspector, gated on land', () => {
    const empty = mountStageWork(view())
    const emptyBtn = empty.querySelector('#makeSenseBtn') as HTMLButtonElement
    expect(emptyBtn).toBeTruthy()
    expect(emptyBtn.disabled).toBe(true)
    expect(emptyBtn.title).toMatch(/Paint some land first/)
    const mask = new Float32Array(DEFAULT_META.width * DEFAULT_META.height)
    mask[0] = 1
    const ready = mountStageWork(view({ mask }))
    const readyBtn = ready.querySelector('#makeSenseBtn') as HTMLButtonElement
    expect(readyBtn.disabled).toBe(false)
  })

  it('never shows the Make-sense pipeline list', () => {
    const work = mountStageWork(view({ stage: 'make-sense', makeSenseComplete: true, pipelineStep: 7 }))
    expect(work.textContent).not.toMatch(/pipeline/i)
    expect(work.textContent).not.toMatch(/freeze intent/i)
    expect(work.querySelector('.progress-list')).toBeNull()
    expect(work.querySelector('button.primary')?.textContent).toBe('Worldbuild')
    const map = mountMapShell()
    expect(map.loading.textContent).not.toMatch(/pipeline/i)
    expect(map.loading.querySelector('.loading-ticks')).toBeNull()
    expect(map.loading.querySelector('.loading-step')).toBeNull()
  })
})

describe('stamp preview copy', () => {
  it('tells the writer the continent follows and can drop anywhere', () => {
    const map = mountMapShell()
    expect(map.stampHint.textContent).toMatch(/drop anywhere/i)
    expect(map.stampHint.textContent).toMatch(/shrink/i)
  })
})

describe('worldbuild tools', () => {
  it('keeps land chapter free of country tools', () => {
    const tools = mountStageTools(view({ stage: 'worldbuild', worldbuildAct: 'land', tool: 'inspect' }))
    expect(tools.root.querySelector('#polityCount')).toBeNull()
    expect(tools.root.querySelector('[data-tool="claim-land"]')).toBeNull()
    expect(tools.root.querySelector('[data-tool="trace-route"]')).toBeNull()
    expect(tools.root.textContent).toMatch(/People this land/)
    expect(tools.root.textContent).not.toMatch(/\bethnicity\b|\brace\b|\btribe of\b/i)
  })

  it('offers a country slider and paint border on the kingdoms chapter', () => {
    const tools = mountStageTools(
      view({ stage: 'worldbuild', worldbuildAct: 'kingdoms', tool: 'claim-land', polityCount: 5 }),
    )
    expect(tools.root.querySelector('#polityCount')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="claim-land"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-overlay="caravans"]')).toBeNull()
    expect(tools.root.textContent).not.toMatch(/\bethnicity\b|\brace\b|\btribe of\b/i)
  })
})

describe('sketch vs leftover grounded world', () => {
  it('Sketch never presents a leftover world as the atlas', () => {
    const world = { cities: [] } as unknown as World
    expect(showingDerivedWorld({ world, stage: 'sketch' })).toBe(false)
    expect(showingDerivedWorld({ world, stage: 'worldbuild' })).toBe(true)

    const mask = new Float32Array(DEFAULT_META.width * DEFAULT_META.height).fill(1)
    const map = mountMapShell()
    updateMapShell(map, view({ world, stage: 'sketch', layer: 'biome', mask }))
    expect(map.overlay.querySelector('[data-look]')).toBeNull()
    expect(map.overlay.querySelector('.biome-legend')).toBeNull()
    expect(map.viewAtlas.parentElement?.hidden).toBe(true)

    const inspector = mountInspector()
    updateInspector(
      inspector,
      view({
        world,
        stage: 'sketch',
        mask,
        score: 73,
        inspectHtml: emptyInspectHint(false),
      }),
    )
    expect(inspector.status.textContent).toContain('not geography yet')
    expect(inspector.status.textContent).not.toContain('Grounded world')
  })

  it('shows a grouped biome legend after Make sense', () => {
    const world = { biome: ['tundra', 'rainforest', 'wetland', 'ocean'] } as unknown as World
    const map = mountMapShell()
    updateMapShell(map, view({ world, stage: 'worldbuild', layer: 'biome' }))
    const legend = map.overlay.querySelector('.biome-legend')
    expect(legend).toBeTruthy()
    expect(legend?.textContent).toMatch(/Cold/)
    expect(legend?.textContent).toMatch(/Forest/)
    expect(legend?.textContent).toMatch(/Wet/)
    expect(legend?.querySelectorAll('.biome-swatch').length).toBe(3)
  })

  it('enables View map after Make sense', () => {
    const map = mountMapShell()
    updateMapShell(map, view())
    expect(map.layoutBtn.disabled).toBe(true)
    updateMapShell(
      map,
      view({
        makeSenseComplete: true,
        world: { biome: ['ocean'] } as unknown as World,
        stage: 'worldbuild',
      }),
    )
    expect(map.layoutBtn.disabled).toBe(false)
    expect(map.layoutBtn.textContent).toBe('View map')
    updateMapShell(
      map,
      view({
        makeSenseComplete: true,
        layoutMode: 'view-map',
        world: { biome: ['ocean'] } as unknown as World,
        stage: 'worldbuild',
      }),
    )
    expect(map.layoutBtn.hidden).toBe(true)
    expect(map.viewEsc.hidden).toBe(false)
  })
})

describe('full-page atlas', () => {
  it('puts the map behind overlay chrome instead of a three-column postcard', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)
    const layout = root.querySelector('.layout')
    expect(layout?.firstElementChild?.classList.contains('map-shell')).toBe(true)
    expect(root.querySelector('.chrome')).toBeTruthy()
    expect(root.querySelector('.tools-panel')).toBeTruthy()
    expect(root.querySelector('.inspector')).toBeTruthy()
    root.remove()
  })

  it('keeps the panels up until a click-and-drag stroke', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)
    const canvas = root.querySelector('#map') as HTMLCanvasElement
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 640,
        bottom: 320,
        width: 640,
        height: 320,
        toJSON: () => ({}),
      }) as DOMRect
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 320, clientY: 160, pointerId: 1, bubbles: true, buttons: 1 }))
    expect(root.classList.contains('is-doodling')).toBe(false)
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 220, pointerId: 1, bubbles: true, buttons: 1 }))
    expect(root.classList.contains('is-doodling')).toBe(true)
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 400, clientY: 220, pointerId: 1, bubbles: true }))
    expect(root.classList.contains('is-doodling')).toBe(false)
    root.remove()
  })

  it('starts with every panel on and View map disabled', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)
    expect(root.classList.contains('is-layout-chrome')).toBe(true)
    expect(root.classList.contains('is-view-map')).toBe(false)
    const btn = root.querySelector('.layout-toggle') as HTMLButtonElement
    expect(btn.textContent).toBe('View map')
    expect(btn.disabled).toBe(true)
    expect(root.querySelector('.chrome')).toBeTruthy()
    expect(root.querySelector('.tools-panel')).toBeTruthy()
    expect(root.querySelector('.inspector')).toBeTruthy()
    root.remove()
  })

  it('View map goes full screen and Escape restores the panels', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)
    window.dispatchEvent(new CustomEvent('app:layout-change', { detail: { layout: 'view-map' } }))
    expect(root.classList.contains('is-view-map')).toBe(true)
    expect(root.classList.contains('is-layout-chrome')).toBe(false)
    expect((root.querySelector('.map-view-esc') as HTMLElement).hidden).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.classList.contains('is-view-map')).toBe(false)
    expect(root.classList.contains('is-layout-chrome')).toBe(true)
    root.remove()
  })
})

describe('worldbuild names', () => {
  it('exposes country and people fields on the kingdoms page', () => {
    const world = {
      cities: [
        { x: 2, y: 2, name: 'Harbour', role: 'fishing', polityId: 0 },
        { x: 1, y: 1, name: 'Seat', role: 'seat_of_power', polityId: 0 },
      ],
      polities: [
        {
          id: 0,
          name: 'Northland',
          capitalX: 1,
          capitalY: 1,
          analog: { id: 'tundra-edge', label: 'Tundra edge', because: 'Cold', tradition: 'Herders' },
          tradition: 'Herders',
          exports: ['grain'],
          imports: ['timber'],
          meltingPot: 0.2,
          mass: 1,
        },
      ],
    } as unknown as World
    const kingdoms = mountStageWork(
      view({ stage: 'worldbuild', worldbuildAct: 'kingdoms', world, tool: 'claim-land' }),
    )
    const names = Array.from(kingdoms.querySelectorAll('.place-name')) as HTMLInputElement[]
    expect(names.map((el) => el.value)).toEqual(['Northland', 'Herders'])
    expect(kingdoms.textContent).toMatch(/Tundra edge/)
    expect(kingdoms.querySelector('[aria-label="People name"]')).toBeTruthy()
    const towns = mountStageWork(
      view({ stage: 'worldbuild', worldbuildAct: 'towns', world, tool: 'place-city' }),
    )
    const townNames = Array.from(towns.querySelectorAll('.place-name')) as HTMLInputElement[]
    expect(townNames.map((el) => el.value)).toEqual(['Harbour', 'Seat'])
  })
})

describe('worldbuild tools', () => {
  it('offers a country slider and paint-border on kingdoms, trade overlays on trade', () => {
    const tools = mountStageTools(
      view({
        stage: 'worldbuild',
        worldbuildAct: 'kingdoms',
        tool: 'claim-land',
        polityCount: 5,
        worldOverlay: 'caravans',
      }),
    )
    const slider = tools.root.querySelector('#polityCount') as HTMLInputElement
    expect(slider).toBeTruthy()
    expect(slider.min).toBe('1')
    expect(slider.max).toBe('24')
    expect(slider.value).toBe('5')
    expect(tools.root.querySelector('[data-tool="claim-land"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="trace-route"]')).toBeNull()
    const trade = mountStageTools(
      view({ stage: 'worldbuild', worldbuildAct: 'trade', tool: 'trace-route', worldOverlay: 'caravans' }),
    )
    const overlays = Array.from(trade.root.querySelectorAll('[data-overlay]')).map((el) =>
      el.getAttribute('data-overlay'),
    )
    expect(overlays).toEqual(['caravans', 'sea-lanes'])
    expect(trade.root.querySelector('[data-overlay="caravans"]')?.classList.contains('active')).toBe(true)
    expect(trade.root.textContent).toMatch(/one overlay/i)
  })
})

describe('emptyInspectHint', () => {
  it('does not say Sketch only after Make sense', () => {
    expect(emptyInspectHint()).toContain('After Make sense')
    expect(emptyInspectHint(true)).toContain('derived geography')
    expect(emptyInspectHint(true)).not.toContain('Sketch only')
  })
})
