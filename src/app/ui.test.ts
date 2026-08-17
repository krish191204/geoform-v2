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
})

describe('updateMapShell hint and HUD', () => {
  it('hides the empty-ocean hint once land exists', () => {
    const map = mountMapShell()
    updateMapShell(map, view())
    expect(map.hint.hidden).toBe(false)

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
    const sliders = tools.root.querySelectorAll('input[type="range"]')
    const radius = sliders[1] as HTMLInputElement
    expect(radius.step).toBe('1')
    expect(radius.value).toBe('6371')
  })

  it('offers continent and island doodle chips', () => {
    const tools = mountStageTools(view())
    const chips = Array.from(tools.root.querySelectorAll('[data-landform]'))
    expect(chips.map((el) => el.getAttribute('data-landform'))).toEqual([
      'continents',
      'mixed',
      'islands',
    ])
    expect(chips.map((el) => el.childNodes[0]?.textContent)).toEqual([
      'Full continents',
      'Continents & islands',
      'Island world',
    ])
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
    expect(biome.title).toMatch(/Holdridge/i)
    expect(biome.disabled).toBe(true)
    expect(biome.classList.contains('active')).toBe(false)
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
})

describe('emptyInspectHint', () => {
  it('does not say Sketch only after Make sense', () => {
    expect(emptyInspectHint()).toContain('After Make sense')
    expect(emptyInspectHint(true)).toContain('derived geography')
    expect(emptyInspectHint(true)).not.toContain('Sketch only')
  })
})
