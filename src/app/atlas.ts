/**
 * Atlas paint for the editor: sketch mask or derived World.
 *
 * Letterboxes the 2:1 grid into the canvas so pointer mapping and
 * critique overlays stay on the map, not the teal bars.
 */

import type { Issue, Layer, World, WorldMeta, WorldOverlay } from '../world/types'
import {
  bakeSketchMaskImageData,
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
  /** Worldbuild ink overlay. One message. */
  worldOverlay?: WorldOverlay | null
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
    : bakeSketchMaskImageData(
        opts.mask,
        meta.width,
        meta.height,
        meta.threshold,
        bakeW,
        bakeH,
        meta.seed,
      )

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
  if (opts.world && opts.worldOverlay) {
    paintWorldOverlay(ctx, opts.world, box, opts.worldOverlay)
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
    const r =
      city.role === 'seat_of_power'
        ? Math.max(4.5, Math.min(cellW, cellH) * 0.95)
        : Math.max(3, Math.min(cellW, cellH) * 0.7)
    ctx.beginPath()
    ctx.fillStyle = city.role === 'seat_of_power' ? '#f7e7c4' : '#f3eee3'
    ctx.strokeStyle = '#1c221c'
    ctx.lineWidth = city.role === 'seat_of_power' ? 2 : 1.5
    if (city.role === 'seat_of_power') {
      ctx.rect(cx - r, cy - r, r * 2, r * 2)
    } else {
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
    }
    ctx.fill()
    ctx.stroke()
  }
}

const POLITY_WASH: readonly [number, number, number][] = [
  [186, 92, 64],
  [64, 118, 138],
  [168, 148, 72],
  [92, 96, 158],
  [140, 108, 88],
  [72, 132, 112],
  [158, 86, 110],
  [96, 124, 84],
]

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function paintWorldOverlay(
  ctx: CanvasRenderingContext2D,
  world: World,
  box: BlitBox,
  overlay: WorldOverlay,
): void {
  if (overlay === 'countries') paintCountryInk(ctx, world, box)
  else paintTradeInk(ctx, world, box, overlay === 'sea-lanes' ? 'sea' : 'land')
}

function paintCountryInk(ctx: CanvasRenderingContext2D, world: World, box: BlitBox): void {
  const { width: w, height: h, threshold } = world.meta
  if (!world.polityId || world.polityId.length !== w * h) return
  const cellW = box.w / w
  const cellH = box.h / h
  ctx.save()
  ctx.globalAlpha = 0.16
  const step = Math.max(1, Math.round(Math.min(w, h) > 200 ? 2 : 1))
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const pid = world.polityId[y * w + x]
      if (pid < 0 || world.mask[y * w + x] < threshold) continue
      const rgb = POLITY_WASH[pid % POLITY_WASH.length]
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
      ctx.fillRect(box.x + x * cellW, box.y + y * cellH, cellW * step + 0.4, cellH * step + 0.4)
    }
  }
  ctx.globalAlpha = 0.92
  ctx.strokeStyle = '#1c221c'
  ctx.lineWidth = Math.max(1, Math.min(cellW, cellH) * 0.22)
  ctx.beginPath()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const pid = world.polityId[i]
      if (pid < 0 || world.mask[i] < threshold) continue
      const right = world.polityId[y * w + wrapX(x + 1, w)]
      const down = y + 1 < h ? world.polityId[(y + 1) * w + x] : pid
      const px = box.x + (x + 1) * cellW
      const py = box.y + (y + 1) * cellH
      if (right !== pid) {
        ctx.moveTo(px, box.y + y * cellH)
        ctx.lineTo(px, py)
      }
      if (down !== pid) {
        ctx.moveTo(box.x + x * cellW, py)
        ctx.lineTo(px, py)
      }
    }
  }
  ctx.stroke()
  ctx.restore()
}

function paintTradeInk(
  ctx: CanvasRenderingContext2D,
  world: World,
  box: BlitBox,
  kind: 'land' | 'sea',
): void {
  const { width: w, height: h } = world.meta
  const cellW = box.w / w
  const cellH = box.h / h
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = kind === 'sea' ? 'rgba(36, 92, 128, 0.88)' : 'rgba(92, 58, 32, 0.82)'
  for (const route of world.routes) {
    if (route.kind !== kind || route.path.length < 2) continue
    ctx.lineWidth = Math.max(1.2, Math.min(cellW, cellH) * (0.18 + route.volume * 0.7))
    ctx.beginPath()
    let pen = false
    for (let i = 0; i < route.path.length; i++) {
      const p = route.path[i]
      const px = box.x + (p.x + 0.5) * cellW
      const py = box.y + (p.y + 0.5) * cellH
      if (!pen) {
        ctx.moveTo(px, py)
        pen = true
        continue
      }
      const prev = route.path[i - 1]
      const jump = Math.abs(p.x - prev.x) > w / 2
      if (jump) {
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(px, py)
        continue
      }
      ctx.lineTo(px, py)
    }
    ctx.stroke()
  }
  ctx.restore()
}
