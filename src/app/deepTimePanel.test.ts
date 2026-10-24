// @vitest-environment happy-dom
/**
 * Deep time panel: DOM contract, empty state, and era place clicks.
 * The fixture is a hand-built World, no pipeline run.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CellBiome, World } from '../world/types'
import { DEFAULT_META, emptyPolityState } from '../world/types'
import { buildDeepTimeModel, mountDeepTimePanel, type DeepTimeModel } from './deepTimePanel'

const W = 32
const H = 16

/** 32×16 World, all ocean unless `withLand`: then a continent (x 8..23, y 4..11) with a ridge and a river. */
function makeWorld(withLand: boolean): World {
  const n = W * H
  const mask = new Float32Array(n)
  const elev = new Float32Array(n).fill(-3000)
  const plateId = new Int16Array(n)
  const plateVx = new Float32Array(n)
  const flux = new Float32Array(n)
  const rivers = new Uint8Array(n)
  const biome: CellBiome[] = new Array<CellBiome>(n).fill('ocean')

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      plateId[i] = x < W / 2 ? 0 : 1
      plateVx[i] = x < W / 2 ? 1 : -1
    }
  }

  if (withLand) {
    for (let y = 4; y <= 11; y++) {
      for (let x = 8; x <= 23; x++) {
        const i = y * W + x
        mask[i] = 1
        elev[i] = x === 15 || x === 16 ? 2800 : 300 + ((x * 7 + y * 13) % 5) * 120
        biome[i] = 'temperate-forest'
        if (y === 8 && x > 16) {
          rivers[i] = 1
          flux[i] = 40
        }
      }
    }
  }

  return {
    meta: { ...DEFAULT_META, width: W, height: H },
    mask,
    plateId,
    plateVx,
    plateVy: new Float32Array(n),
    elev,
    seasons: 2,
    summer: new Float32Array(n).fill(20),
    winter: new Float32Array(n).fill(6),
    summerMoist: new Float32Array(n).fill(0.5),
    winterMoist: new Float32Array(n).fill(0.4),
    tempMean: new Float32Array(n).fill(13),
    tempRange: new Float32Array(n).fill(14),
    moistMean: new Float32Array(n).fill(0.45),
    flux,
    rivers,
    biome,
    suitability: new Float32Array(n).fill(0.5),
    cities: [],
    ...emptyPolityState(n),
  }
}

function handModel(): DeepTimeModel {
  return {
    facts: ['Gravity 9.8 m/s²'],
    rocks: [
      { label: 'Fold belt', share: 0.34, color: '#c98b8b' },
      { label: '<img src=x onerror=alert(1)>', share: 0.002, color: 'red; background: url(x)' },
    ],
    resources: [{ label: 'metal ore', cells: 1204 }],
    eras: [
      {
        id: 'first-granaries',
        title: 'First granaries',
        yearsAgo: [6000, 4500],
        places: [
          { x: 12, y: 40, label: 'Red Ford' },
          { x: 3, y: 7, label: 'Salt Hill' },
        ],
        why: 'Flood silt and a long dry season reward stored grain.',
        theme: 'cradle',
      },
    ],
  }
}

describe('mountDeepTimePanel on a grounded world', () => {
  const section = mountDeepTimePanel(buildDeepTimeModel(makeWorld(true)))

  it('renders the deep-time section', () => {
    expect(section.tagName).toBe('SECTION')
    expect(section.classList.contains('deep-time')).toBe(true)
    expect(section.getAttribute('aria-label')).toBe('Deep time')
    expect(section.querySelector('.deep-time-title')?.textContent).toBe('Deep time')
  })

  it('lists at least one planet fact', () => {
    expect(section.querySelectorAll('.deep-time-facts li').length).toBeGreaterThanOrEqual(1)
  })

  it('draws at least one rock bar when there is land', () => {
    expect(section.querySelectorAll('.rock-bar').length).toBeGreaterThanOrEqual(1)
    expect(section.querySelectorAll('.rock-bar').length).toBeLessThanOrEqual(6)
  })
})

describe('mountDeepTimePanel with a hand-built model', () => {
  it('calls onPlace with numeric cell coordinates', () => {
    const onPlace = vi.fn()
    const section = mountDeepTimePanel(handModel(), onPlace)
    const buttons = section.querySelectorAll<HTMLButtonElement>('.era-place')
    expect(buttons.length).toBe(2)
    expect(buttons[0].type).toBe('button')
    expect(buttons[0].dataset.x).toBe('12')
    expect(buttons[0].dataset.y).toBe('40')

    buttons[0].click()
    buttons[1].click()
    expect(onPlace).toHaveBeenNthCalledWith(1, 12, 40)
    expect(onPlace).toHaveBeenNthCalledWith(2, 3, 7)
    for (const [x, y] of onPlace.mock.calls) {
      expect(typeof x).toBe('number')
      expect(typeof y).toBe('number')
    }
  })

  it('matches the DOM contract and writes data as text only', () => {
    const section = mountDeepTimePanel(handModel())
    const bar = section.querySelector<HTMLElement>('.rock-bar')!
    expect(bar.style.getPropertyValue('--share')).toBe('0.34')
    expect(bar.style.getPropertyValue('--color')).toBe('#c98b8b')
    expect(bar.querySelector('.rock-label')?.textContent).toBe('Fold belt')
    expect(bar.querySelector('.rock-share')?.textContent).toBe('34%')
    expect(section.querySelectorAll('.rock-share')[1].textContent).toBe('<1%')
    expect(section.querySelector('img')).toBeNull()

    expect(section.querySelector('.res-cells')?.textContent).toBe('1,204 cells')
    const era = section.querySelector<HTMLElement>('.era')!
    expect(era.dataset.theme).toBe('cradle')
    expect(era.querySelector('.era-years')?.textContent).toBe('6,000–4,500 years before the map')
    expect(era.querySelector('.era-title')?.textContent).toBe('First granaries')
  })

  it('hides only the block whose reading is missing', () => {
    const section = mountDeepTimePanel({ ...handModel(), rocks: [] })
    expect(section.querySelector('.deep-time-rocks')).toBeNull()
    expect(section.querySelector('.deep-time-planet')).not.toBeNull()
    expect(section.querySelector('.deep-time-resources')).not.toBeNull()
    expect(section.querySelector('.deep-time-eras')).not.toBeNull()
  })
})

describe('mountDeepTimePanel on a world with no land', () => {
  it('renders the empty state and no blocks', () => {
    const section = mountDeepTimePanel(buildDeepTimeModel(makeWorld(false)))
    expect(section.classList.contains('deep-time')).toBe(true)
    expect(section.querySelectorAll('.deep-time-empty').length).toBe(1)
    expect(section.querySelector('.deep-time-empty')?.textContent).toBe(
      'Make sense first. Deep time reads the grounded world.',
    )
    expect(section.querySelector('.deep-time-block')).toBeNull()
  })
})
