// @vitest-environment happy-dom
/**
 * Sketch → Critique → Make sense → Worldbuild walkthrough.
 *
 * Equivalent of the Playwright product path: paint a blob, the empty-ocean
 * hint goes away, Critique refuses to flatter the doodle, Make sense
 * grounds climate / plates / mixed towns. Runs in Vitest so CI does not
 * need a browser install.
 */
import { describe, expect, it } from 'vitest'
import { mountApp } from './shell'
import { critiqueMask, critiqueWorld } from '../critique/main'
import { makeSenseInline, worldFromMakeSense } from '../pipeline/makeSense'
import { seedSettlements } from '../sketch/settlements'
import { makeContinentWorld } from '../pipeline/__tests__/fixtures'

function stubAtlasRect(canvas: HTMLCanvasElement): void {
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
}

function pointer(canvas: HTMLCanvasElement, type: string, clientX: number, clientY: number): void {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      clientX,
      clientY,
      pointerId: 1,
      bubbles: true,
      buttons: type === 'pointerup' ? 0 : 1,
    }),
  )
}

describe('Sketch → Worldbuild walkthrough', () => {
  it('hides the empty-ocean hint after paint and Critique scores the doodle ≤ 40', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)

    const hint = root.querySelector('#mapHint') as HTMLElement
    expect(hint.hidden).toBe(false)

    const canvas = root.querySelector('#map') as HTMLCanvasElement
    stubAtlasRect(canvas)
    pointer(canvas, 'pointerdown', 320, 160)
    pointer(canvas, 'pointermove', 340, 150)
    pointer(canvas, 'pointermove', 300, 170)
    pointer(canvas, 'pointerup', 300, 170)

    expect(hint.hidden).toBe(true)

    const critiqueBtn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Critique')
    expect(critiqueBtn).toBeTruthy()
    expect(critiqueBtn!.disabled).toBe(false)
    critiqueBtn!.click()

    const scoreText = root.querySelector('.score')?.textContent ?? ''
    const score = Number(scoreText.replace('%', ''))
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(40)
    expect(hint.hidden).toBe(true)

    root.remove()
  })

  it('Make sense grounds climate, mixed towns, and oceanic plates', async () => {
    const tw = makeContinentWorld()
    const meta = {
      seed: 42,
      width: tw.width,
      height: tw.height,
      planetRadiusKm: tw.planetRadiusKm,
      obliquityDeg: tw.obliquityDeg,
      seaLevel: 0.5,
      threshold: 0.5,
    }
    const mask = new Float32Array(tw.mask)

    const pre = critiqueMask(mask, meta, meta.threshold)
    expect(pre.pre).toBe(true)
    expect(pre.score).toBeLessThanOrEqual(40)

    const world = worldFromMakeSense(
      await makeSenseInline({ meta, mask }, () => {}),
      meta,
      mask,
    )
    let flipped = 0
    for (let i = 0; i < mask.length; i++) {
      if ((mask[i] >= meta.threshold) !== (world.mask[i] >= meta.threshold)) flipped++
    }
    expect(flipped).toBeGreaterThan(10)
    seedSettlements(world)
    const post = critiqueWorld(world)

    const { width: w, height: h } = world.meta
    let pole = 0
    let poleN = 0
    let equator = 0
    let equatorN = 0
    for (let x = 0; x < w; x++) {
      pole += world.summer[x] + world.summer[(h - 1) * w + x]
      poleN += 2
      equator += world.summer[Math.floor(h / 2) * w + x]
      equatorN++
    }
    expect(pole / poleN).toBeLessThan(equator / equatorN)

    const roles = new Set(world.cities.map((c) => c.role))
    expect(world.cities.length).toBeGreaterThanOrEqual(5)
    expect(roles.size).toBeGreaterThanOrEqual(3)
    expect(world.cities.filter((c) => c.role === 'seat_of_power')).toHaveLength(1)
    expect(post.issues.some((i) => i.id === 'all-capitals')).toBe(false)

    let oceanOther = 0
    const oceanIds = new Set<number>()
    for (let i = 0; i < world.mask.length; i++) {
      if (world.mask[i] >= world.meta.threshold) continue
      const id = world.plateId[i]
      oceanIds.add(id)
      if (id !== 0) oceanOther++
    }
    expect(oceanOther).toBeGreaterThan(0)
    expect(oceanIds.size).toBeGreaterThan(1)
  })
})
