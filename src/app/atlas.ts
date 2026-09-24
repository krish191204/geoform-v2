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
import { buildSketchNoteFields } from '../sketch/sketchMarks'
import { TRADE_GOOD_LABEL } from '../sketch/analogs'
import { featuresAtZoom, namePhysicalFeatures, type FeatureName } from '../sketch/featureNames'

export type { Season }

export const LAYER_CHIPS: readonly { id: Layer; label: string; title: string; caption: string }[] = [
  { id: 'relief', label: 'Relief', title: 'Landform, hillshade, and rivers', caption: 'Hillshade and rivers on the grounded land.' },
  { id: 'biome', label: 'Biome', title: 'Climate class, grouped', caption: 'Climate class, grouped. Ocean is not a land class.' },
  { id: 'moisture', label: 'Moisture', title: 'Precipitation, 0–1', caption: '0 dry, 1 wet — not millimetres of rain.' },
  { id: 'temperature', label: 'Temperature', title: 'Mean temperature, °C', caption: 'Air temperature in Celsius.' },
  { id: 'suitability', label: 'Settle', title: 'Where people can live', caption: 'How livable the cell is for towns, 0–1.' },
  { id: 'plates', label: 'Plates', title: 'Tectonic plates', caption: 'Crust pieces. Colour is an id, not height.' },
  { id: 'elevation', label: 'Height', title: 'Elevation in metres', caption: 'Elevation in metres above the reference surface.' },
]

export const SEASON_LAYERS: ReadonlySet<Layer> = new Set([
  'relief',
  'biome',
  'moisture',
  'temperature',
])

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
  /**
   * Cheap sketch invalidation. Shell bumps this on mask / meta writes.
   * Pan/zoom is CSS and must not change it.
   */
  sketchEpoch?: number
  /** Sketch decorate notes. Doodle only — never on a grounded atlas. */
  marks?: Uint8Array | null
  /**
   * Atlas zoom (1..ATLAS_ZOOM_MAX). Physical names appear as this rises.
   * The base bake stays bilinear; this only chooses which ink labels to draw.
   */
  zoom?: number
}

export interface SizeCanvasOpts {
  /**
   * Sketch keeps a 1× backing store even in dev. A 2× retina canvas on top
   * of the 4× paper bake is wasted work; pointer mapping uses the CSS rect.
   */
  sketch?: boolean
}

/** Doodle ticks stay on Sketch. After Make sense the relief is the map. */
export function paintSketchNotesOnAtlas(world: World | null | undefined): boolean {
  return world == null
}

/**
 * Size the canvas backing store to the CSS box.
 * Production is always 1×. Sketch is 1× in dev too so a ~1600px map is not
 * 2× retina × 4× bake. World in dev may still use min(2, dpr).
 * Returns the bitmap width/height written.
 */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  opts: SizeCanvasOpts = {},
): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect()
  const rawDpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
  const dpr = import.meta.env.PROD || opts.sketch ? 1 : Math.min(2, rawDpr)
  const width = Math.max(320, Math.floor((rect.width || 640) * dpr))
  const height = Math.max(180, Math.floor((rect.height || 320) * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  return { width, height }
}

/** Idle delay before swapping the 1× stroke preview for the 4× paper bake. */
export const SKETCH_HD_IDLE_MS = 100

export interface IdleBakeClock {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void
}

/**
 * After a stroke, keep showing the 1× preview until `delayMs` of idle.
 * Cancel / reschedule when another stroke starts. Not Make-sense debounce.
 */
export function createIdleBakeScheduler(
  delayMs: number = SKETCH_HD_IDLE_MS,
  clock: IdleBakeClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  },
): {
  readonly pending: boolean
  cancel: () => void
  afterStroke: (onIdle: () => void) => void
} {
  let handle: ReturnType<typeof setTimeout> | 0 = 0
  let pending = false
  return {
    get pending() {
      return pending
    },
    cancel() {
      if (handle) clock.clearTimeout(handle)
      handle = 0
      pending = false
    },
    afterStroke(onIdle: () => void) {
      if (handle) clock.clearTimeout(handle)
      pending = true
      handle = clock.setTimeout(() => {
        handle = 0
        pending = false
        onIdle()
      }, delayMs)
    },
  }
}

/** Map a pointer onto a grid cell, rejecting letterbox clicks unless `clamp`. */
export function cellFromPointer(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  gridW: number,
  gridH: number,
  clamp = false,
): { x: number; y: number } | null {
  const hit = clientToContainedBitmap(
    clientX,
    clientY,
    canvas.getBoundingClientRect(),
    gridW,
    gridH,
    clamp,
  )
  if (!hit) return null
  const x = Math.min(gridW - 1, Math.max(0, Math.floor(hit.nx * gridW)))
  const y = Math.min(gridH - 1, Math.max(0, Math.floor(hit.ny * gridH)))
  return { x, y }
}

const worldBakeCache = new WeakMap<World, { key: string; image: ImageData }>()
let sketchBakeCache: { key: string; image: ImageData } | null = null
let sketchBakeCount = 0
let blitCanvas: HTMLCanvasElement | null = null

/** Test hook: how many sketch rasters were actually baked. */
export function atlasSketchBakeCount(): number {
  return sketchBakeCount
}

/** Test hook: drop the sketch raster cache. */
export function resetAtlasSketchBakeCache(): void {
  sketchBakeCache = null
  sketchBakeCount = 0
}

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
  const showRivers = layer === 'relief'
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

function sketchBakeKey(
  opts: AtlasPaintOpts,
  bakeW: number,
  bakeH: number,
): string {
  const { meta } = opts
  const preview = opts.preview === true ? 1 : 0
  const epoch = opts.sketchEpoch ?? 0
  return `${epoch}|${meta.seed}|${meta.threshold}|${bakeW}x${bakeH}|${preview}`
}

function cachedSketchBake(
  opts: AtlasPaintOpts,
  bakeW: number,
  bakeH: number,
): ImageData {
  const key = sketchBakeKey(opts, bakeW, bakeH)
  if (sketchBakeCache && sketchBakeCache.key === key) return sketchBakeCache.image
  const { meta } = opts
  const notes =
    paintSketchNotesOnAtlas(opts.world) && opts.marks
      ? buildSketchNoteFields(opts.marks, meta.width, meta.height)
      : null
  const image = bakeSketchMaskImageData(
    opts.mask,
    meta.width,
    meta.height,
    meta.threshold,
    bakeW,
    bakeH,
    meta.seed,
    notes,
  )
  sketchBakeCount++
  sketchBakeCache = { key, image }
  return image
}

/** Paint the atlas into `canvas`. World wins over mask. */
export function paintAtlas(canvas: HTMLCanvasElement, opts: AtlasPaintOpts): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: cw, height: ch } = sizeCanvas(canvas, { sketch: !opts.world })
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
    : cachedSketchBake(opts, bakeW, bakeH)

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
  if (opts.world) {
    paintFeatureNames(ctx, opts.world, box, opts.zoom ?? 1)
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

/** Exported for the zoom overlay, which repaints markers over its HD window. */
export function paintCities(
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

/**
 * Physical names as ink on the paper. Zoom chooses the set; the raster
 * underneath stays the bilinear bake.
 */
export function paintFeatureNames(
  ctx: CanvasRenderingContext2D,
  world: World,
  box: BlitBox,
  zoom: number,
): void {
  if (typeof ctx.fillText !== 'function' || typeof ctx.strokeText !== 'function') return
  const { width: w, height: h } = world.meta
  if (w <= 0 || h <= 0) return
  const names = featuresAtZoom(namePhysicalFeatures(world), zoom)
  if (names.length === 0) return
  const cellW = box.w / w
  const cellH = box.h / h
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const feature of names) {
    drawFeatureInk(ctx, feature, box.x + feature.x * cellW, box.y + feature.y * cellH, cellW)
  }
  ctx.restore()
}

function drawFeatureInk(
  ctx: CanvasRenderingContext2D,
  feature: FeatureName,
  x: number,
  y: number,
  cellW: number,
): void {
  const land = feature.kind === 'landmass'
  const size = land
    ? Math.max(13, Math.min(22, cellW * 5))
    : Math.max(10, Math.min(15, cellW * 3.4))
  ctx.font = `${land ? 600 : 500} ${size}px Fraunces, Georgia, serif`
  ctx.lineWidth = land ? 3.5 : 2.5
  ctx.strokeStyle = 'rgba(244, 239, 228, 0.92)'
  ctx.fillStyle = '#1c221c'
  ctx.strokeText(feature.name, x, y)
  ctx.fillText(feature.name, x, y)
}

/** Exported for the zoom overlay, which repaints worldbuild ink over its HD window. */
export function paintWorldOverlay(
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
      const i = y * w + x
      const pid = world.polityId[i]
      if (pid < 0 || world.mask[i] < threshold) continue
      const march = world.marchBand
      if (march && march.length === w * h && march[i] === 1) continue
      const rgb = POLITY_WASH[pid % POLITY_WASH.length]
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
      ctx.fillRect(box.x + x * cellW, box.y + y * cellH, cellW * step + 0.4, cellH * step + 0.4)
    }
  }
  const march = world.marchBand
  if (march && march.length === w * h) {
    ctx.globalAlpha = 0.55
    ctx.strokeStyle = '#1c221c'
    ctx.lineWidth = Math.max(0.6, Math.min(cellW, cellH) * 0.12)
    ctx.beginPath()
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x
        if (march[i] !== 1 || world.mask[i] < threshold) continue
        const x0 = box.x + x * cellW
        const y0 = box.y + y * cellH
        const x1 = x0 + cellW * step
        const y1 = y0 + cellH * step
        ctx.moveTo(x0, y1)
        ctx.lineTo(x1, y0)
      }
    }
    ctx.stroke()
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
  ctx.globalAlpha = 0.95
  ctx.fillStyle = '#f4efe4'
  ctx.strokeStyle = 'rgba(12, 16, 14, 0.85)'
  ctx.lineWidth = 3
  ctx.font = `600 ${Math.max(10, Math.min(14, cellW * 3.2))}px Outfit, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const p of world.polities) {
    const lx = box.x + (p.capitalX + 0.5) * cellW
    const ly = box.y + (p.capitalY + 0.5) * cellH
    ctx.strokeText(p.name, lx, ly)
    ctx.fillText(p.name, lx, ly)
  }
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
  const routes = world.routes.filter((r) => r.kind === kind && r.path.length >= 2)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = kind === 'sea' ? 'rgba(36, 92, 128, 0.88)' : 'rgba(92, 58, 32, 0.82)'
  for (const route of routes) {
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

  const terminals = new Map<string, { x: number; y: number }>()
  for (const route of routes) {
    terminals.set(`${route.ax},${route.ay}`, { x: route.ax, y: route.ay })
    terminals.set(`${route.bx},${route.by}`, { x: route.bx, y: route.by })
  }
  const r = Math.max(2.4, Math.min(cellW, cellH) * 0.55)
  ctx.lineWidth = 1.4
  ctx.strokeStyle = '#1c221c'
  for (const t of terminals.values()) {
    const px = box.x + (t.x + 0.5) * cellW
    const py = box.y + (t.y + 0.5) * cellH
    ctx.beginPath()
    ctx.fillStyle = kind === 'sea' ? '#d7e7ef' : '#efe4d2'
    if (kind === 'sea') ctx.arc(px, py, r, 0, Math.PI * 2)
    else ctx.rect(px - r, py - r, r * 2, r * 2)
    ctx.fill()
    ctx.stroke()
  }

  const labelled: { x: number; y: number }[] = []
  const ranked = [...routes].sort((a, b) => b.volume - a.volume).slice(0, 4)
  ctx.font = `600 ${Math.max(9, Math.min(12, cellW * 2.6))}px Outfit, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(244, 239, 228, 0.92)'
  ctx.fillStyle = kind === 'sea' ? '#1d3f52' : '#4a321c'
  for (const route of ranked) {
    const mid = route.path[Math.floor(route.path.length / 2)]
    const lx = box.x + (mid.x + 0.5) * cellW
    const ly = box.y + (mid.y + 0.5) * cellH
    if (labelled.some((p) => Math.hypot(p.x - lx, p.y - ly) < 36)) continue
    labelled.push({ x: lx, y: ly })
    const label = TRADE_GOOD_LABEL[route.good]
    ctx.strokeText(label, lx, ly)
    ctx.fillText(label, lx, ly)
  }

  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  ctx.font = '500 11px Outfit, system-ui, sans-serif'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(244, 239, 228, 0.9)'
  ctx.fillStyle = '#2a2620'
  const legend = kind === 'sea' ? 'Sea lanes · width ∝ cargo volume' : 'Caravans · width ∝ cargo volume'
  ctx.strokeText(legend, box.x + 8, box.y + box.h - 8)
  ctx.fillText(legend, box.x + 8, box.y + box.h - 8)
  ctx.restore()
}
