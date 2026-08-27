// @vitest-environment happy-dom
/**
 * Sketch → Make sense → Worldbuild walkthrough.
 *
 * Equivalent of the Playwright product path: paint a blob, the empty-ocean
 * hint goes away, Make sense is the primary, then the factory grounds climate /
 * plates / mixed towns. Runs in Vitest so CI does not need a browser install.
 */
import { describe, expect, it } from 'vitest'
import { mountApp } from './shell'
import { critiqueMask, critiqueWorld, gradeFromScore } from '../critique/main'
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

function pointer(target: EventTarget, type: string, clientX: number, clientY: number): void {
  target.dispatchEvent(
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
  it('hides the empty-ocean hint after paint and enables Make sense', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)

    const hint = root.querySelector('#mapHint') as HTMLElement
    expect(hint.hidden).toBe(false)
    expect(root.querySelector('[data-stage="critique"]')).toBeNull()

    const canvas = root.querySelector('#map') as HTMLCanvasElement
    stubAtlasRect(canvas)
    pointer(canvas, 'pointerdown', 320, 160)
    pointer(canvas, 'pointermove', 340, 150)
    pointer(canvas, 'pointermove', 300, 170)
    pointer(canvas, 'pointerup', 300, 170)

    expect(hint.hidden).toBe(true)

    const makeSenseBtn = root.querySelector('#makeSenseBtn') as HTMLButtonElement
    expect(makeSenseBtn).toBeTruthy()
    expect(makeSenseBtn.disabled).toBe(false)
    expect(root.querySelector('#coach')?.textContent).toMatch(/doodle/i)
    expect(Array.from(root.querySelectorAll('button')).some((b) => b.textContent === 'Critique')).toBe(false)
    expect(root.querySelector('[data-tool="fill-mask"]')).toBeTruthy()
    const undoBtn = root.querySelector('#undoBtn') as HTMLButtonElement
    expect(undoBtn).toBeTruthy()
    expect(undoBtn.disabled).toBe(false)

    root.remove()
  })

  it('stamps a mountain note on click and coaches the decorate tool', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)

    const canvas = root.querySelector('#map') as HTMLCanvasElement
    stubAtlasRect(canvas)
    pointer(canvas, 'pointerdown', 320, 160)
    pointer(canvas, 'pointermove', 340, 150)
    pointer(canvas, 'pointermove', 300, 170)
    pointer(canvas, 'pointerup', 300, 170)

    const mountain = root.querySelector('[data-tool="draw-ridge"]') as HTMLButtonElement
    mountain.click()
    expect(root.querySelector('#coach')?.textContent).toMatch(/mountain range/i)
    expect((root.querySelector('#mapHint') as HTMLElement).hidden).toBe(true)
    expect((root.querySelector('.inspect-block') as HTMLElement).hidden).toBe(false)

    pointer(canvas, 'pointerdown', 320, 160)
    pointer(canvas, 'pointerup', 320, 160)
    expect(root.querySelector('#inspect')?.textContent).toMatch(/Mountain note/)

    root.remove()
  })

  it('dragging a continent onto the map hides the empty-ocean hint', () => {
    const root = document.createElement('div')
    document.body.append(root)
    mountApp(root)

    const hint = root.querySelector('#mapHint') as HTMLElement
    expect(hint.hidden).toBe(false)

    const canvas = root.querySelector('#map') as HTMLCanvasElement
    stubAtlasRect(canvas)
    const chip = root.querySelector('[data-landform="continents"]') as HTMLButtonElement
    expect(chip).toBeTruthy()
    pointer(chip, 'pointerdown', 40, 200)
    pointer(chip, 'pointermove', 320, 160)
    pointer(chip, 'pointerup', 320, 160)

    expect(hint.hidden).toBe(true)
    const makeSenseBtn = root.querySelector('#makeSenseBtn') as HTMLButtonElement
    expect(makeSenseBtn?.disabled).toBe(false)

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
    const { ensureWorldbuild } = await import('../sketch/polities')
    ensureWorldbuild(world, 1)
    expect(world.polities).toHaveLength(1)
    expect(world.polities[0].analog.label.length).toBeGreaterThan(4)
    const post = critiqueWorld(world)
    expect(gradeFromScore(post.score)).toBe('A')
    expect(post.issues.some((i) => i.severity === 'critical')).toBe(false)

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
