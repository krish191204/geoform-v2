/**
 * Atlas paint for the editor: sketch mask or derived World.
 *
 * Letterboxes the 2:1 grid into the canvas so pointer mapping and
 * critique overlays stay on the map, not the teal bars.
 */

import type { Issue, Layer, World, WorldMeta } from '../world/types'
import {
  applyVignette,
  bakeWorldImageDataSmooth,
  clientToContainedBitmap,
  type Season,
} from '../render/draw'
import { drawIssueOverlays } from '../critique/preview'

export type { Season }

export const LAYER_CHIPS: readonly { id: Layer; label: string; title: string }[] = [
  { id: 'relief', label: 'Relief', title: 'Landform, hillshade, and rivers' },
  { id: 'biome', label: 'Biome', title: 'Climate class, grouped' },
  { id: 'moisture', label: 'Moisture', title: 'Precipitation, 0–1' },
  { id: 'temperature', label: 'Temperature', title: 'Mean temperature, °C' },
  { id: 'suitability', label: 'Settle', title: 'Where people can live' },
  { id: 'plates', label: 'Plates', title: 'Tectonic plates' },
  { id: 'elevation', label: 'Height', title: 'Elevation in metres' },
]

const LAND_RGB: readonly [number, number, number] = [0x8a, 0x7a, 0x5a]
const SEA_FILL = '#163a44'

/** Geoform 1 HD raster: at least 4 pixels per cell locally, then CSS-downsample. */
export const ATLAS_CELL_SCALE = 4
export const ATLAS_BAKE_CAP = 4096
/** Geoform 1 published-build cap so Vercel stays interactive. */
export const ATLAS_PROD_MAX_PIXELS = 1_500_000

export interface AtlasBakeOpts {
  preview?: boolean
  gridH?: number
  prod?: boolean
}

/** Raster scale: 4× locally; production matches Geoform 1's 1.5M-pixel budget. */
export function atlasCellScale(gridW: number, gridH: number, opts: AtlasBakeOpts = {}): number {
  if (opts.preview) return 1
  const cells = Math.max(1, gridW * gridH)
  const prod = opts.prod ?? import.meta.env.PROD
  if (!prod) return ATLAS_CELL_SCALE
  const maxScale = Math.max(2, Math.floor(Math.sqrt(ATLAS_PROD_MAX_PIXELS / cells)))
  return Math.min(ATLAS_CELL_SCALE, maxScale)
}

/** Bake width for the atlas: oversample the grid, never exceed the WebGL-ish cap. */
export function atlasBakeWidth(
  letterboxW: number,
  gridW: number,
  previewOrOpts: boolean | AtlasBakeOpts = false,
): number {
  const opts: AtlasBakeOpts = typeof previewOrOpts === 'boolean' ? { preview: previewOrOpts } : previewOrOpts
  const gridH = Math.max(1, opts.gridH ?? Math.round(gridW / 2))
  const scale = atlasCellScale(gridW, gridH, opts)
  const prod = opts.prod ?? import.meta.env.PROD
  const floor = opts.preview || prod ? gridW * scale : Math.max(letterboxW, gridW * scale)
  let width = Math.min(ATLAS_BAKE_CAP, floor)
  if (prod && !opts.preview) {
    const maxW = Math.max(
      gridW * 2,
      Math.floor(Math.sqrt(ATLAS_PROD_MAX_PIXELS * (gridW / gridH))),
    )
    width = Math.min(width, maxW)
  }
  return width
}

export interface AtlasPaintOpts {
  world: World | null
  mask: Float32Array | null
  meta: WorldMeta
  layer: Layer
  season: Season
  issues?: readonly Issue[]
  showCities?: boolean
  /** Stroke preview: native grid scale, no 4× oversample. */
  preview?: boolean
}

/**
 * Size the canvas backing store to the CSS box (device pixels).
 * Returns the bitmap width/height written.
 */
export function sizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect()
  const dpr = import.meta.env.PROD
    ? 1
    : Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
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

const worldBakeCache = new WeakMap<World, { key: string; image: ImageData }>()
let blitCanvas: HTMLCanvasElement | null = null

function blitScratch(width: number, height: number): CanvasRenderingContext2D | null {
  if (!blitCanvas) blitCanvas = document.createElement('canvas')
  if (blitCanvas.width !== width || blitCanvas.height !== height) {
    blitCanvas.width = width
    blitCanvas.height = height
  }
  return blitCanvas.getContext('2d')
}

function cachedWorldBake(
  world: World,
  season: Season,
  layer: Layer,
  bakeW: number,
): ImageData {
  const showRivers = layer === 'relief' || layer === 'biome'
  const key = `${season}|${layer}|${bakeW}|${showRivers ? 1 : 0}`
  const hit = worldBakeCache.get(world)
  if (hit && hit.key === key) return hit.image
  const image = bakeWorldImageDataSmooth(world, season, layer, bakeW, {
    showRivers,
    bakeCities: false,
  })
  worldBakeCache.set(world, { key, image })
  return image
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
  const bakeW = atlasBakeWidth(box.w, meta.width, {
    preview: opts.preview === true,
    gridH: meta.height,
  })
  const bakeH = Math.max(1, Math.round((bakeW * meta.height) / Math.max(1, meta.width)))

  const image = opts.world
    ? cachedWorldBake(opts.world, opts.season, opts.layer, bakeW)
    : upsampleMask(opts.mask, meta, bakeW, bakeH, opts.preview === true)

  const tctx = blitScratch(image.width, image.height)
  if (!tctx) return
  tctx.putImageData(image, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = opts.preview ? 'low' : 'high'
  ctx.drawImage(tctx.canvas, box.x, box.y, box.w, box.h)

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

function upsampleMaskPreview(
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
  for (let py = 0; py < ch; py++) {
    const y = Math.max(0, Math.min(h - 1, Math.floor(((py + 0.5) * h) / ch)))
    for (let px = 0; px < cw; px++) {
      const x = wrap(Math.floor(((px + 0.5) * w) / cw))
      const land = Boolean(mask && mask[y * w + x] >= threshold)
      const o = (py * cw + px) * 4
      data[o] = land ? LAND_RGB[0] : 12
      data[o + 1] = land ? LAND_RGB[1] : 41
      data[o + 2] = land ? LAND_RGB[2] : 63
      data[o + 3] = 255
    }
  }
  return image
}

function upsampleMask(
  mask: Float32Array | null,
  meta: WorldMeta,
  outW: number,
  outH: number,
  preview = false,
): ImageData {
  if (preview) return upsampleMaskPreview(mask, meta, outW, outH)
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
      const grain = ((Math.sin(xf * 12.9898 + yf * 78.233) * 43758.5453) % 1) * 0.1 - 0.05
      // Geoform 1 empty ocean: deep navy + still-water caustic, not a flat teal fill.
      const wave =
        0.5 + 0.5 * Math.sin(xf * 0.35 + Math.cos(yf * 0.22) * 2) * Math.sin(yf * 0.4)
      const shimmer = wave * 0.55 * 0.14
      let r = 8 + (18 - 8) * 0.38 + shimmer * 40
      let g = 28 + (62 - 28) * 0.38 + shimmer * 70
      let b = 48 + (92 - 48) * 0.38 + shimmer * 90
      r = r + (LAND_RGB[0] - r) * k
      g = g + (LAND_RGB[1] - g) * k
      b = b + (LAND_RGB[2] - b) * k
      if (k > 0.22 && k < 0.78) {
        const foam = 1 - Math.abs(k - 0.5) * 4
        const edge = k < 0.5 ? [210, 230, 230] : [30, 42, 36]
        const et = Math.max(0, foam) * (k < 0.5 ? 0.28 : 0.22)
        r = r + (edge[0] - r) * et
        g = g + (edge[1] - g) * et
        b = b + (edge[2] - b) * et
      }
      r = Math.max(0, Math.min(255, r * (1 + grain)))
      g = Math.max(0, Math.min(255, g * (1 + grain)))
      b = Math.max(0, Math.min(255, b * (1 + grain)))
      const o = (py * cw + px) * 4
      data[o] = Math.round(r)
      data[o + 1] = Math.round(g)
      data[o + 2] = Math.round(b)
      data[o + 3] = 255
    }
  }
  applyVignette(image)
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
