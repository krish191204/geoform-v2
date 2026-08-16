/**
 * Render the critique preview.
 *
 * `drawCritiquePreview` fills a canvas: optional background image,
 * generated relief if no image, and a vignette. `drawIssueOverlays`
 * paints one coloured cell per evidence coordinate of every Issue,
 * sized to the world cell the issue came from.
 *
 * Severity colour coding (matches style.css tokens):
 *   critical: --critical  #c43c1a
 *   major:    --major     #b85a2a
 *   minor:    --minor     #8a6a28
 */
import type { Issue, World } from '../world/types'

/** Static palette so the canvas matches the rest of the editor. */
const SEVERITY_COLORS = {
  critical: '#c43c1a',
  major: '#b85a2a',
  minor: '#8a6a28',
} as const

/** Background we paint when no bitmap is supplied. */
const SEA_FILL = '#1a4f5c'

/**
 * Background image source. Pass an ImageBitmap for the fastest path,
 * or any drawable element (HTMLCanvasElement, HTMLImageElement).
 */
export type PreviewImage =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | null
  | undefined

/**
 * Draw the full preview: background image (or relief from `world`) plus
 * per-issue evidence overlays. The active issue gets a brighter ring.
 */
export function drawCritiquePreview(
  canvas: HTMLCanvasElement,
  world: Pick<World, 'meta' | 'elev'> | null,
  issues: Issue[],
  activeId: string | null,
  image: PreviewImage = null,
): void {
  const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
  const rect = canvas.getBoundingClientRect()
  const tw = Math.max(1, Math.floor(rect.width * dpr))
  const th = Math.max(1, Math.floor(rect.height * dpr))
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw
    canvas.height = th
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, tw, th)

  if (image) {
    const scale = Math.max(tw / image.width, th / image.height)
    const dw = image.width * scale
    const dh = image.height * scale
    ctx.drawImage(image, (tw - dw) / 2, (th - dh) / 2, dw, dh)
    ctx.fillStyle = 'rgba(10,24,28,0.18)'
    ctx.fillRect(0, 0, tw, th)
  } else if (world && world.elev) {
    paintRelief(ctx, tw, th, world)
  } else {
    ctx.fillStyle = SEA_FILL
    ctx.fillRect(0, 0, tw, th)
  }

  // Soft inner vignette so the issues read against any background.
  const g = ctx.createRadialGradient(tw / 2, th / 2, th * 0.2, tw / 2, th / 2, th * 0.75)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(8,18,22,0.35)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, tw, th)

  drawIssueOverlays(
    ctx,
    tw,
    th,
    world?.meta.width ?? 0,
    world?.meta.height ?? 0,
    issues,
    activeId,
  )
}

/**
 * Paint one colored box per evidence cell. Criticals are filled with
 * full opacity. Majors are half. Minors are quarter. The active issue
 * gets a thicker white ring around every one of its cells.
 */
export function drawIssueOverlays(
  ctx: CanvasRenderingContext2D,
  tw: number,
  th: number,
  worldWidth: number,
  worldHeight: number,
  issues: Issue[],
  activeId: string | null,
): void {
  if (worldWidth <= 0 || worldHeight <= 0) return
  const cellW = tw / worldWidth
  const cellH = th / worldHeight
  const padX = Math.max(1, cellW * 0.08)
  const padY = Math.max(1, cellH * 0.08)

  for (const issue of issues) {
    const color = SEVERITY_COLORS[issue.severity]
    const alpha = issue.severity === 'critical' ? 0.85 : issue.severity === 'major' ? 0.55 : 0.3
    const isActive = issue.id === activeId
    for (const ev of issue.evidence) {
      const x = ev.x * cellW + padX
      const y = ev.y * cellH + padY
      const w = cellW - 2 * padX
      const h = cellH - 2 * padY
      if (w <= 0 || h <= 0) continue
      ctx.fillStyle = withAlpha(color, alpha)
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = isActive ? 'rgba(255,240,210,0.95)' : 'rgba(255,255,255,0.55)'
      ctx.lineWidth = isActive ? 1.75 : 1
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1))
    }
  }
}

/** Convert `#rrggbb` + alpha to a `rgba(...)` string. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** Paint a quick land/water relief using just elevation. Used when no image. */
function paintRelief(
  ctx: CanvasRenderingContext2D,
  tw: number,
  th: number,
  world: Pick<World, 'meta' | 'elev'>,
): void {
  const { elev } = world
  const w = world.meta.width
  const h = world.meta.height
  const img = ctx.createImageData(tw, th)
  const data = img.data
  // Find elev range for normalization.
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < elev.length; i++) {
    if (elev[i] < lo) lo = elev[i]
    if (elev[i] > hi) hi = elev[i]
  }
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-6) {
    lo = 0
    hi = 1
  }
  for (let py = 0; py < th; py++) {
    for (let px = 0; px < tw; px++) {
      const x = Math.min(w - 1, (px / tw) * w) | 0
      const y = Math.min(h - 1, (py / th) * h) | 0
      const e = elev[y * w + x]
      const ocean = e < 0
      let t: number
      if (ocean) {
        const o = (py * tw + px) * 4
        data[o] = 26
        data[o + 1] = 79
        data[o + 2] = 92
        data[o + 3] = 255
        continue
      }
      t = (e - lo) / (hi - lo)
      if (t < 0) t = 0
      if (t > 1) t = 1
      const o = (py * tw + px) * 4
      data[o] = (70 + t * 120) | 0
      data[o + 1] = (100 + t * 80) | 0
      data[o + 2] = (65 + t * 40) | 0
      data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}
