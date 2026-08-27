/**
 * Flip one connected land or lake on the sketch mask.
 *
 * Open ocean is too big to fill by accident: the writer paints land instead.
 * A whole continent is too big to erase by accident: they use Ocean or Undo.
 */

export type FillMaskResult =
  | { ok: true; mutatedCells: number; flippedTo: 'land' | 'ocean' }
  | { ok: false; reason: 'ocean' | 'land' | 'empty' }

const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

function isLand(mask: Float32Array, w: number, threshold: number, x: number, y: number): boolean {
  return mask[y * w + x] >= threshold
}

/** Ocean fills larger than this share of the grid are the world sea, not a lake. */
export const OCEAN_FILL_FRACTION = 0.02
/** Land fills larger than this share are a continent, not an island. */
export const LAND_FILL_FRACTION = 0.05

/**
 * Flood-fill the 4-connected blob under (x, y) and flip land ↔ ocean.
 * Longitude wraps; poles do not.
 */
export function fillMaskComponent(
  mask: Float32Array,
  width: number,
  height: number,
  threshold: number,
  x: number,
  y: number,
  marks?: Uint8Array | null,
): FillMaskResult {
  if (x < 0 || y < 0 || x >= width || y >= height) return { ok: false, reason: 'empty' }
  const land = isLand(mask, width, threshold, x, y)
  const maxOcean = Math.max(48, Math.floor(width * height * OCEAN_FILL_FRACTION))
  const maxLand = Math.max(48, Math.floor(width * height * LAND_FILL_FRACTION))

  const seen = new Uint8Array(width * height)
  const qx: number[] = [x]
  const qy: number[] = [y]
  seen[y * width + x] = 1
  let n = 0
  while (n < qx.length) {
    const cx = qx[n]
    const cy = qy[n]
    n++
    for (const [dx, dy] of N4) {
      const nx = wrapX(cx + dx, width)
      const ny = cy + dy
      if (ny < 0 || ny >= height) continue
      const i = ny * width + nx
      if (seen[i]) continue
      if (isLand(mask, width, threshold, nx, ny) !== land) continue
      seen[i] = 1
      qx.push(nx)
      qy.push(ny)
    }
  }

  if (qx.length === 0) return { ok: false, reason: 'empty' }
  if (!land && qx.length > maxOcean) return { ok: false, reason: 'ocean' }
  if (land && qx.length > maxLand) return { ok: false, reason: 'land' }

  const value = land ? 0 : 1
  const clearNotes = marks && marks.length === width * height
  for (let k = 0; k < qx.length; k++) {
    const i = qy[k] * width + qx[k]
    mask[i] = value
    if (clearNotes) marks[i] = 0
  }
  return { ok: true, mutatedCells: qx.length, flippedTo: land ? 'ocean' : 'land' }
}
