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
  showingDerivedWorld,
  updateChrome,
  updateInspector,
  updateMapShell,
} from './ui'
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
    worldOverlay: 'countries',
    ...over,
  }
}

describe('updateChrome aria-current', () => {
  it('marks only the active stage as current', () => {
    const chrome = mountChrome()
    updateChrome(chrome, view({ stage: 'critique', maskCommitted: true }))
    expect(chrome.stageButtons.critique.getAttribute('aria-current')).toBe('step')
    expect(chrome.stageButtons.sketch.hasAttribute('aria-current')).toBe(false)
    expect(chrome.stageButtons['make-sense'].hasAttribute('aria-current')).toBe(false)
    expect(chrome.stageButtons.worldbuild.hasAttribute('aria-current')).toBe(false)
  })

  it('offers Download JSON and disables it on empty ocean', () => {
    const chrome = mountChrome()
    expect(chrome.downloadBtn.textContent).toMatch(/Download JSON/)
    updateChrome(chrome, view())
    expect(chrome.downloadBtn.disabled).toBe(true)
    const mask = new Float32Array(DEFAULT_META.width * DEFAULT_META.height)
    mask[0] = 1
    updateChrome(chrome, view({ mask }))
    expect(chrome.downloadBtn.disabled).toBe(false)
  })
})

describe('updateMapShell hint and HUD', () => {
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

  it('offers continent and island doodle chips', () => {
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
    expect(tools.root.textContent).toMatch(/Drag a picture onto the map/i)
    expect(tools.root.querySelector('#continentCountVal')).toBeNull()
  })
})

describe('worldbuild tools', () => {
  it('offers country count, overlays, and paint border without naming ethnic groups', () => {
    const tools = mountStageTools(view({ stage: 'worldbuild', tool: 'place-city' }))
    expect(tools.root.querySelector('#polityCount')).toBeTruthy()
    expect(tools.root.querySelector('[data-overlay="countries"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-overlay="caravans"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-overlay="sea-lanes"]')).toBeTruthy()
    expect(tools.root.querySelector('[data-tool="claim-land"]')).toBeTruthy()
    expect(tools.root.textContent).not.toMatch(/ethnicity|race|tribe of/i)
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
    const biome = map.overlay.querySelector('[data-look="biome"]') as HTMLButtonElement
    expect(biome.title).toMatch(/climate/i)
    expect(biome.disabled).toBe(true)
    expect(biome.classList.contains('active')).toBe(false)
    expect(map.overlay.querySelector('.biome-legend')).toBeNull()
    expect(map.viewPlanet.disabled).toBe(true)

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

describe('worldbuild tools', () => {
  it('offers a country slider, one overlay at a time, and paint-border', () => {
    const tools = mountStageTools(
      view({ stage: 'worldbuild', tool: 'place-city', polityCount: 5, worldOverlay: 'caravans' }),
    )
    const slider = tools.root.querySelector('#polityCount') as HTMLInputElement
    expect(slider).toBeTruthy()
    expect(slider.min).toBe('1')
    expect(slider.max).toBe('12')
    expect(slider.value).toBe('5')
    expect(tools.root.querySelector('[data-tool="claim-land"]')).toBeTruthy()
    const overlays = Array.from(tools.root.querySelectorAll('[data-overlay]')).map((el) =>
      el.getAttribute('data-overlay'),
    )
    expect(overlays).toEqual(['countries', 'caravans', 'sea-lanes'])
    expect(tools.root.querySelector('[data-overlay="caravans"]')?.classList.contains('active')).toBe(true)
    expect(tools.root.querySelector('[data-overlay="countries"]')?.classList.contains('active')).toBe(false)
    expect(tools.root.textContent).toMatch(/one message/i)
    expect(tools.root.textContent).toMatch(/path cost/i)
  })
})

describe('emptyInspectHint', () => {
  it('does not say Sketch only after Make sense', () => {
    expect(emptyInspectHint()).toContain('After Make sense')
    expect(emptyInspectHint(true)).toContain('derived geography')
    expect(emptyInspectHint(true)).not.toContain('Sketch only')
  })
})
