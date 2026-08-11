import { describe, it, expect } from 'vitest'
import { MapRenderer, screenToCell } from './draw'
import { generateWorld } from '../world/generate'

// Minimal canvas + context double — happy-dom does not provide a working 2D context.
class FakeCanvas {
  width = 0
  height = 0
}
class FakeCtx {
  canvas: FakeCanvas
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 1
  globalCompositeOperation = ''
  font = ''
  shadowColor = ''
  shadowBlur = 0
  constructor(canvas: FakeCanvas) {
    this.canvas = canvas
  }
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  arc(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  fill(): void {}
  stroke(): void {}
  setLineDash(): void {}
  putImageData(): void {}
  getImageData(): ImageData {
    return new ImageData(1, 1)
  }
}

describe('MapRenderer', () => {
  it('produces a rasterisation within bounds', () => {
    const w = generateWorld(8, 6, 1)
    const canvas = new FakeCanvas()
    const ctx = new FakeCtx(canvas) as unknown as CanvasRenderingContext2D
    const renderer = new MapRenderer()
    renderer.draw(ctx, w, {
      layer: 'relief',
      showRivers: true,
      showCities: true,
      scale: 2,
    })
    // Renderer sets canvas dimensions to w*scale × h*scale.
    expect(canvas.width).toBe(8 * 2)
    expect(canvas.height).toBe(6 * 2)
  })

  it('invalidate clears cache', () => {
    const w = generateWorld(8, 6, 1)
    const canvas = new FakeCanvas()
    const ctx = new FakeCtx(canvas) as unknown as CanvasRenderingContext2D
    const renderer = new MapRenderer()
    renderer.draw(ctx, w, { layer: 'relief', showRivers: true, showCities: true, scale: 2 })
    renderer.invalidate()
    renderer.draw(ctx, w, { layer: 'biome', showRivers: true, showCities: true, scale: 2 })
    expect(canvas.width).toBe(16)
  })
})

describe('screenToCell', () => {
  it('maps cursor coordinates into grid space', () => {
    const w = generateWorld(20, 10, 1)
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => '' } as DOMRect)
    // 50% width → x = 10, 30% height → y = 3
    const c = screenToCell(canvas, 100, 30, w)
    expect(c).toEqual({ x: 10, y: 3 })
  })

  it('returns null for cursors outside the canvas', () => {
    const w = generateWorld(20, 10, 1)
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => '' } as DOMRect)
    const c = screenToCell(canvas, -10, 5, w)
    expect(c).toBeNull()
  })
})
