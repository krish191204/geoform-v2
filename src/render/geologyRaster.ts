// Geologic map layer baked as a smooth paper sheet: bilinear lithology colour
// at >= pxPerCell output pixels per cell, transparent at sea so the relief
// underneath shows, and thin ink contacts where two rock units meet.

export interface RasterRGBA { width: number; height: number; data: Uint8ClampedArray }

const FILL_ALPHA = 235
const LAND_CUTOFF = 0.5
const LAND_RAMP = 0.15
const CONTACT_PX = 0.6

const INK_R = 40
const INK_G = 34
const INK_B = 28
const INK_A = 200 / 255
const FILL_A = FILL_ALPHA / 255
const INK_OVER_A = INK_A + FILL_A * (1 - INK_A)
const INK_K = INK_A / INK_OVER_A
const FILL_K = (FILL_A * (1 - INK_A)) / INK_OVER_A
const INK_OVER_ALPHA = Math.round(INK_OVER_A * 255)

const HEX6 = /^#?([0-9a-f]{6})$/i
const HEX3 = /^#?([0-9a-f]{3})$/i

function parseHex(hex: string): number {
  const m6 = HEX6.exec(hex)
  if (m6) return parseInt(m6[1], 16)
  const m3 = HEX3.exec(hex)
  if (m3) {
    const s = m3[1]
    return parseInt(s[0] + s[0] + s[1] + s[1] + s[2] + s[2], 16)
  }
  return -1
}

export function bakeLithologyRaster(
  lith: Uint8Array,
  mask: Float32Array,
  threshold: number,
  w: number,
  h: number,
  palette: Record<number, string>,
  pxPerCell = 4,
): RasterRGBA {
  const p = Math.max(1, Math.round(pxPerCell))
  const W = Math.max(0, w) * p
  const H = Math.max(0, h) * p
  const out = new Uint8ClampedArray(W * H * 4)
  if (W === 0 || H === 0) return { width: W, height: H, data: out }
  const n = w * h
  if (lith.length < n || mask.length < n) {
    throw new RangeError(`bakeLithologyRaster: expected ${n} cells, got lith ${lith.length}, mask ${mask.length}`)
  }

  const lut = new Float32Array(256 * 3)
  const hasColour = new Uint8Array(256)
  for (const key of Object.keys(palette)) {
    const code = Number(key)
    if (!Number.isInteger(code) || code < 1 || code > 255) continue
    const rgb = parseHex(palette[code])
    if (rgb < 0) continue
    lut[code * 3] = (rgb >> 16) & 255
    lut[code * 3 + 1] = (rgb >> 8) & 255
    lut[code * 3 + 2] = rgb & 255
    hasColour[code] = 1
  }

  const cellW = new Float32Array(n)
  const land = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const code = lith[i]
    if (code === 0) continue
    const m = mask[i]
    if (m >= threshold) land[i] = 1
    if (!hasColour[code]) continue
    const t = (m - threshold + LAND_RAMP) / (2 * LAND_RAMP)
    cellW[i] = t <= 0 ? 0 : t >= 1 ? 1 : t
  }

  const colX0 = new Int32Array(W)
  const colX1 = new Int32Array(W)
  const colFx = new Float32Array(W)
  const colNear = new Int32Array(W)
  const colLeft = new Int32Array(W)
  const colRight = new Int32Array(W)
  for (let px = 0; px < W; px++) {
    const c = (px + 0.5) / p
    const near = Math.min(w - 1, Math.floor(c))
    const u = c - 0.5
    const x0f = Math.floor(u)
    const x0 = ((x0f % w) + w) % w
    colX0[px] = x0
    colX1[px] = (x0 + 1) % w
    colFx[px] = u - x0f
    colNear[px] = near
    const sub = c - near
    colLeft[px] = sub * p <= CONTACT_PX ? (near - 1 + w) % w : -1
    colRight[px] = (1 - sub) * p <= CONTACT_PX ? (near + 1) % w : -1
  }

  const rowY0 = new Int32Array(H)
  const rowY1 = new Int32Array(H)
  const rowFy = new Float32Array(H)
  const rowNear = new Int32Array(H)
  const rowUp = new Int32Array(H)
  const rowDown = new Int32Array(H)
  for (let py = 0; py < H; py++) {
    const c = (py + 0.5) / p
    const near = Math.min(h - 1, Math.floor(c))
    const v = c - 0.5
    const y0f = Math.floor(v)
    const y0 = y0f < 0 ? 0 : y0f > h - 1 ? h - 1 : y0f
    const y1 = y0f + 1 < 0 ? 0 : y0f + 1 > h - 1 ? h - 1 : y0f + 1
    rowY0[py] = y0 * w
    rowY1[py] = y1 * w
    rowFy[py] = v - y0f
    rowNear[py] = near * w
    const sub = c - near
    rowUp[py] = sub * p <= CONTACT_PX && near > 0 ? (near - 1) * w : -1
    rowDown[py] = (1 - sub) * p <= CONTACT_PX && near < h - 1 ? (near + 1) * w : -1
  }

  for (let py = 0; py < H; py++) {
    const r0 = rowY0[py]
    const r1 = rowY1[py]
    const fy = rowFy[py]
    const gy = 1 - fy
    const rn = rowNear[py]
    const ru = rowUp[py]
    const rd = rowDown[py]
    let o = py * W * 4
    for (let px = 0; px < W; px++, o += 4) {
      const x0 = colX0[px]
      const x1 = colX1[px]
      const fx = colFx[px]
      const gx = 1 - fx
      const i00 = r0 + x0
      const i10 = r0 + x1
      const i01 = r1 + x0
      const i11 = r1 + x1
      const a00 = gx * gy * cellW[i00]
      const a10 = fx * gy * cellW[i10]
      const a01 = gx * fy * cellW[i01]
      const a11 = fx * fy * cellW[i11]
      const lw = a00 + a10 + a01 + a11
      if (lw < LAND_CUTOFF) continue

      const k00 = lith[i00] * 3
      const k10 = lith[i10] * 3
      const k01 = lith[i01] * 3
      const k11 = lith[i11] * 3
      const inv = 1 / lw
      let r = (a00 * lut[k00] + a10 * lut[k10] + a01 * lut[k01] + a11 * lut[k11]) * inv
      let g = (a00 * lut[k00 + 1] + a10 * lut[k10 + 1] + a01 * lut[k01 + 1] + a11 * lut[k11 + 1]) * inv
      let b = (a00 * lut[k00 + 2] + a10 * lut[k10 + 2] + a01 * lut[k01 + 2] + a11 * lut[k11 + 2]) * inv
      let a = FILL_ALPHA

      const cx = colNear[px]
      const ni = rn + cx
      if (land[ni] === 1) {
        const code = lith[ni]
        let contact = false
        const cl = colLeft[px]
        if (cl >= 0 && land[rn + cl] === 1 && lith[rn + cl] !== code) contact = true
        const cr = colRight[px]
        if (!contact && cr >= 0 && land[rn + cr] === 1 && lith[rn + cr] !== code) contact = true
        if (!contact && ru >= 0 && land[ru + cx] === 1 && lith[ru + cx] !== code) contact = true
        if (!contact && rd >= 0 && land[rd + cx] === 1 && lith[rd + cx] !== code) contact = true
        if (contact) {
          r = INK_R * INK_K + r * FILL_K
          g = INK_G * INK_K + g * FILL_K
          b = INK_B * INK_K + b * FILL_K
          a = INK_OVER_ALPHA
        }
      }

      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }

  return { width: W, height: H, data: out }
}

export function toImageData(r: RasterRGBA): ImageData | null {
  if (typeof ImageData === 'undefined') return null
  const image = new ImageData(r.width, r.height)
  image.data.set(r.data)
  return image
}
