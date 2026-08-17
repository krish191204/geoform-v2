/**
 * Atlas paint for the editor: sketch mask or derived World.
 *
 * Letterboxes the 2:1 grid into the canvas so pointer mapping and
 * critique overlays stay on the map, not the teal bars.
 */

import type { Issue, Layer, World, WorldMeta } from '../world/types'
import {
  bakeWorldImageDataSmooth,
  clientToContainedBitmap,
  type Season,
} from '../render/draw'
import { drawIssueOverlays } from '../critique/preview'

export type { Season }

export const LAYER_CHIPS: readonly { id: Layer; label: string }[] = [
  { id: 'relief', label: 'Relief' },
  { id: 'biome', label: 'Biome' },
  { id: 'moisture', label: 'Moisture' },
  { id: 'temperature', label: 'Temperature' },
  { id: 'suitability', label: 'Settle' },
  { id: 'plates', label: 'Plates' },
  { id: 'elevation', label: 'Height' },
]

const LAND_RGB: readonly [number, number, number] = [0x8a, 0x7a, 0x5a]
const SEA_RGB: readonly [number, number, number] = [0x1a, 0x4f, 0x5c]
const SEA_FILL = '#163a44'

export interface AtlasPaintOpts {
  world: World | null
  mask: Float32Array | null
  meta: WorldMeta
  layer: Layer
  season: Season
  issues?: readonly Issue[]
  showCities?: boolean
}

/**
 * Size the canvas backing store to the CSS box (device pixels).
 * Returns the bitmap width/height written.
 */
export function sizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  const width = Math.max(320, Math.floor((rect.width || 640) * dpr))
  const height = Math.max(180, Math.floor((rect.height || 320) * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  return { width, height }
}

/** Map a pointer onto a grid cell, rejecting letterbox clicks. */
export function cellFromPointer(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  gridW: number,
  gridH: number,
): { x: number; y: number } | null {
  const hit = clientToContainedBitmap(
    clientX,
    clientY,
    canvas.getBoundingClientRect(),
    gridW,
    gridH,
  )
  if (!hit) return null
  const x = Math.min(gridW - 1, Math.max(0, Math.floor(hit.nx * gridW)))
  const y = Math.min(gridH - 1, Math.max(0, Math.floor(hit.ny * gridH)))
  return { x, y }
}

/** Paint the atlas into `canvas`. World wins over mask. */
export function paintAtlas(canvas: HTMLCanvasElement, opts: AtlasPaintOpts): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: cw, height: ch } = sizeCanvas(canvas)
  ctx.fillStyle = SEA_FILL
  ctx.fillRect(0, 0, cw, ch)

  const { meta } = opts
  const aspect = meta.width / Math.max(1, meta.height)
  const box = letterbox(cw, ch, aspect)

  const image = opts.world
    ? bakeWorldImageDataSmooth(opts.world, opts.season, opts.layer, box.w, {
        showRivers: opts.layer === 'relief' || opts.layer === 'biome',
        bakeCities: false,
      })
    : upsampleMask(opts.mask, meta, box.w, box.h)

  const tmp = document.createElement('canvas')
  tmp.width = image.width
  tmp.height = image.height
  const tctx = tmp.getContext('2d')
  if (!tctx) return
  tctx.putImageData(image, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(tmp, box.x, box.y, box.w, box.h)

  if (opts.issues && opts.issues.length > 0) {
    ctx.save()
    ctx.translate(box.x, box.y)
    drawIssueOverlays(ctx, box.w, box.h, meta.width, meta.height, [...opts.issues], null)
    ctx.restore()
  }

  if (opts.showCities && opts.world) {
    paintCities(ctx, opts.world, box)
  }
}

interface BlitBox {
  x: number
  y: number
  w: number
  h: number
}

function letterbox(cw: number, ch: number, aspect: number): BlitBox {
  let dw: number
  let dh: number
  if (cw / Math.max(1, ch) > aspect) {
    dh = ch
    dw = Math.max(1, Math.round(ch * aspect))
  } else {
    dw = cw
    dh = Math.max(1, Math.round(cw / Math.max(1e-6, aspect)))
  }
  return {
    x: Math.floor((cw - dw) / 2),
    y: Math.floor((ch - dh) / 2),
    w: dw,
    h: dh,
  }
}

function upsampleMask(
  mask: Float32Array | null,
  meta: WorldMeta,
  outW: number,
  outH: number,
): ImageData {
  const w = meta.width
  const h = meta.height
  const cw = Math.max(1, outW)
  const ch = Math.max(1, outH)
  const image = new ImageData(cw, ch)
  const data = image.data
  const threshold = meta.threshold
  const wrap = (x: number) => ((x % w) + w) % w
  const sample = (xf: number, yf: number): number => {
    if (!mask) return 0
    const x0 = wrap(Math.floor(xf))
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(yf)))
    const x1 = wrap(x0 + 1)
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
    const fx = xf - Math.floor(xf)
    const fy = yf - Math.floor(yf)
    const v00 = mask[y0 * w + x0]
    const v10 = mask[y0 * w + x1]
    const v01 = mask[y1 * w + x0]
    const v11 = mask[y1 * w + x1]
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
  }
  for (let py = 0; py < ch; py++) {
    const yf = ((py + 0.5) * h) / ch
    for (let px = 0; px < cw; px++) {
      const xf = ((px + 0.5) * w) / cw
      const t = sample(xf, yf)
      const k = Math.max(0, Math.min(1, (t - threshold + 0.15) / 0.3))
      const o = (py * cw + px) * 4
      data[o] = Math.round(SEA_RGB[0] + (LAND_RGB[0] - SEA_RGB[0]) * k)
      data[o + 1] = Math.round(SEA_RGB[1] + (LAND_RGB[1] - SEA_RGB[1]) * k)
      data[o + 2] = Math.round(SEA_RGB[2] + (LAND_RGB[2] - SEA_RGB[2]) * k)
      data[o + 3] = 255
    }
  }
  return image
}

function paintCities(
  ctx: CanvasRenderingContext2D,
  world: World,
  box: BlitBox,
): void {
  const { width: w, height: h } = world.meta
  if (w <= 0 || h <= 0) return
  const cellW = box.w / w
  const cellH = box.h / h
  for (const city of world.cities) {
    const cx = box.x + (city.x + 0.5) * cellW
    const cy = box.y + (city.y + 0.5) * cellH
    const r = Math.max(3, Math.min(cellW, cellH) * 0.7)
    ctx.beginPath()
    ctx.fillStyle = '#f3eee3'
    ctx.strokeStyle = '#1c221c'
    ctx.lineWidth = 1.5
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}
