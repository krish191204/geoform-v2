/**
 * Atlas paint for the editor: sketch mask or derived World.
 *
 * Letterboxes the 2:1 grid into the canvas so pointer mapping and
 * critique overlays stay on the map, not the teal bars.
 */

import type { Issue, Layer, World, WorldMeta } from '../world/types'
import {
  clientToContainedBitmap,
  draw,
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
  const image = opts.world
    ? draw(opts.world, opts.season, opts.layer, { showRivers: opts.layer === 'relief' })
    : maskImageData(opts.mask, meta)

  const smooth =
    Boolean(opts.world) && opts.layer !== 'plates' && opts.layer !== 'biome'
  const box = blitContained(ctx, image, cw, ch, smooth)

  if (opts.issues && opts.issues.length > 0 && box) {
    ctx.save()
    ctx.translate(box.x, box.y)
    drawIssueOverlays(ctx, box.w, box.h, meta.width, meta.height, [...opts.issues], null)
    ctx.restore()
  }

  if (opts.showCities && opts.world && box) {
    paintCities(ctx, opts.world, box)
  }
}

interface BlitBox {
  x: number
  y: number
  w: number
  h: number
}

function blitContained(
  ctx: CanvasRenderingContext2D,
  image: ImageData,
  cw: number,
  ch: number,
  smooth: boolean,
): BlitBox | null {
  const bw = image.width
  const bh = image.height
  if (bw <= 0 || bh <= 0) return null
  const scale = Math.min(cw / bw, ch / bh)
  const dw = Math.max(1, Math.floor(bw * scale))
  const dh = Math.max(1, Math.floor(bh * scale))
  const ox = Math.floor((cw - dw) / 2)
  const oy = Math.floor((ch - dh) / 2)

  const tmp = document.createElement('canvas')
  tmp.width = bw
  tmp.height = bh
  const tctx = tmp.getContext('2d')
  if (!tctx) return null
  tctx.putImageData(image, 0, 0)
  ctx.imageSmoothingEnabled = smooth
  if (smooth) ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(tmp, ox, oy, dw, dh)
  return { x: ox, y: oy, w: dw, h: dh }
}

function maskImageData(mask: Float32Array | null, meta: WorldMeta): ImageData {
  const w = meta.width
  const h = meta.height
  const image = new ImageData(w, h)
  const data = image.data
  const threshold = meta.threshold
  for (let i = 0; i < w * h; i++) {
    const land = mask ? mask[i] >= threshold : false
    const rgb = land ? LAND_RGB : SEA_RGB
    const o = i * 4
    data[o] = rgb[0]
    data[o + 1] = rgb[1]
    data[o + 2] = rgb[2]
    data[o + 3] = 255
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
