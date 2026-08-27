/**
 * Notes on the sketch. They look like land on the doodle.
 * Make sense ignores them and invents the geographically plausible neighbour.
 */

import type { Tool } from '../world/types'

export const MARK_NONE = 0
export const MARK_RANGE = 1
export const MARK_RIVER = 2
export const MARK_HILLS = 3
export const MARK_FOREST = 4
export const MARK_SWAMP = 5
export const MARK_TOWN = 6

export type MarkValue = 0 | 1 | 2 | 3 | 4 | 5 | 6

const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

export function emptyMarks(n: number): Uint8Array {
  return new Uint8Array(Math.max(0, n))
}

export function isMarkValue(k: number): k is Exclude<MarkValue, 0> {
  return k === 1 || k === 2 || k === 3 || k === 4 || k === 5 || k === 6
}

/** Ink tools stamp or clear notes. Fill and inspect do not. */
export function markValueForTool(tool: Tool): MarkValue | null {
  if (tool === 'draw-ridge') return MARK_RANGE
  if (tool === 'erase-channel') return MARK_RIVER
  if (tool === 'mark-hills') return MARK_HILLS
  if (tool === 'mark-forest') return MARK_FOREST
  if (tool === 'mark-swamp') return MARK_SWAMP
  if (tool === 'mark-town') return MARK_TOWN
  if (tool === 'wipe-note' || tool === 'draw-land' || tool === 'erase-land') return MARK_NONE
  return null
}

export function markKindLabel(value: number): string | null {
  if (value === MARK_RANGE) return 'mountain'
  if (value === MARK_RIVER) return 'river'
  if (value === MARK_HILLS) return 'hills'
  if (value === MARK_FOREST) return 'forest'
  if (value === MARK_SWAMP) return 'swamp'
  if (value === MARK_TOWN) return 'town'
  return null
}

/** Stamp a circular note, matching the land/ocean dab radius. */
export function stampSketchMarks(
  marks: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: MarkValue,
): void {
  const r = Math.max(0, radius)
  if (r === 0 || marks.length !== width * height) return
  const xMin = Math.max(0, Math.floor(cx - r))
  const xMax = Math.min(width - 1, Math.ceil(cx + r))
  const yMin = Math.max(0, Math.floor(cy - r))
  const yMax = Math.min(height - 1, Math.ceil(cy + r))
  for (let y = yMin; y <= yMax; y++) {
    const dy = y - cy
    for (let x = xMin; x <= xMax; x++) {
      const dx = x - cx
      if (Math.sqrt(dx * dx + dy * dy) > r) continue
      marks[y * width + x] = value
    }
  }
}

export function clearMarksWhereMaskChanged(
  marks: Uint8Array,
  before: Float32Array,
  after: Float32Array,
): void {
  const n = Math.min(marks.length, before.length, after.length)
  for (let i = 0; i < n; i++) {
    if (before[i] !== after[i]) marks[i] = MARK_NONE
  }
}

export interface RiverThread {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Unique N4 edges between river-note cells. Longitude wraps. */
export function riverThreads(marks: Uint8Array, width: number, height: number): RiverThread[] {
  const out: RiverThread[] = []
  if (marks.length !== width * height) return out
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (marks[i] !== MARK_RIVER) continue
      for (const [dx, dy] of N4) {
        const nx = wrapX(x + dx, width)
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        const ni = ny * width + nx
        if (marks[ni] !== MARK_RIVER) continue
        if (ni <= i) continue
        if (Math.abs(nx - x) > width / 2) continue
        out.push({ x0: x, y0: y, x1: nx, y1: ny })
      }
    }
  }
  return out
}

function neighbourCount(marks: Uint8Array, width: number, height: number, x: number, y: number, value: number): number {
  let n = 0
  for (const [dx, dy] of N4) {
    const nx = wrapX(x + dx, width)
    const ny = y + dy
    if (ny < 0 || ny >= height) continue
    if (marks[ny * width + nx] === value) n++
  }
  return n
}

export interface RangeTick {
  x: number
  y: number
}

function sampledCells(
  marks: Uint8Array,
  width: number,
  height: number,
  value: number,
  stride: number,
): RangeTick[] {
  const out: RangeTick[] = []
  if (marks.length !== width * height) return out
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (marks[y * width + x] !== value) continue
      const n = neighbourCount(marks, width, height, x, y, value)
      if (n >= 2 && (x + y * 2) % stride !== 0) continue
      out.push({ x, y })
    }
  }
  return out
}

/** Isolated cells always tick; dense notes thin so symbols stay readable. */
export function rangeTickCells(
  marks: Uint8Array,
  width: number,
  height: number,
  stride = 3,
): RangeTick[] {
  return sampledCells(marks, width, height, MARK_RANGE, stride)
}

/** Decorate stamps a mass, not a land-sized blob. */
export function noteStampRadius(tool: Tool, brushSize: number): number {
  if (tool === 'mark-town') return 0.45
  if (tool === 'wipe-note') return Math.max(0.8, brushSize)
  if (tool === 'erase-channel') return Math.max(0.7, brushSize * 0.16)
  if (tool === 'draw-ridge') return Math.max(1.4, brushSize * 0.38)
  if (tool === 'mark-hills') return Math.max(1.8, brushSize * 0.42)
  return Math.max(1.5, brushSize * 0.38)
}

/** Continuous 0–1 fields so the doodle bakes as land, not legend glyphs. */
export interface SketchNoteFields {
  readonly range: Float32Array
  readonly hills: Float32Array
  readonly forest: Float32Array
  readonly swamp: Float32Array
  readonly river: Float32Array
  readonly town: Float32Array
}

const SPLAT: Readonly<Record<number, { radius: number; gain: number; blur: number }>> = {
  [MARK_RANGE]: { radius: 5.8, gain: 0.88, blur: 2 },
  [MARK_HILLS]: { radius: 6.2, gain: 0.52, blur: 2 },
  [MARK_FOREST]: { radius: 3.4, gain: 0.95, blur: 2 },
  [MARK_SWAMP]: { radius: 3.6, gain: 0.95, blur: 2 },
  [MARK_RIVER]: { radius: 1.15, gain: 1, blur: 1 },
  [MARK_TOWN]: { radius: 1.6, gain: 1, blur: 1 },
}

/** Merge overlapping stamp discs into one massif so a stroke reads as land. */
function blurField(field: Float32Array, width: number, height: number, passes: number): void {
  if (passes <= 0) return
  const tmp = new Float32Array(field.length)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let s = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = -1; dx <= 1; dx++) {
            s += field[yy * width + wrapX(x + dx, width)]
            n++
          }
        }
        tmp[y * width + x] = s / n
      }
    }
    field.set(tmp)
  }
}

function splatMax(
  field: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  gain: number,
): void {
  const r = Math.ceil(radius)
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy
    if (y < 0 || y >= height) continue
    for (let dx = -r; dx <= r; dx++) {
      const x = wrapX(cx + dx, width)
      const d = Math.hypot(dx, dy) / radius
      if (d >= 1) continue
      const a = (1 - d) * (1 - d) * gain
      const i = y * width + x
      if (a > field[i]) field[i] = a
    }
  }
}

export function buildSketchNoteFields(
  marks: Uint8Array | null | undefined,
  width: number,
  height: number,
): SketchNoteFields | null {
  const n = width * height
  if (!marks || marks.length !== n || width <= 0 || height <= 0) return null
  let any = false
  for (let i = 0; i < n; i++) {
    if (marks[i] !== 0) {
      any = true
      break
    }
  }
  if (!any) return null
  const range = new Float32Array(n)
  const hills = new Float32Array(n)
  const forest = new Float32Array(n)
  const swamp = new Float32Array(n)
  const river = new Float32Array(n)
  const town = new Float32Array(n)
  const fieldFor = (k: number): Float32Array | null => {
    if (k === MARK_RANGE) return range
    if (k === MARK_HILLS) return hills
    if (k === MARK_FOREST) return forest
    if (k === MARK_SWAMP) return swamp
    if (k === MARK_RIVER) return river
    if (k === MARK_TOWN) return town
    return null
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = marks[y * width + x]
      const spec = SPLAT[k]
      const field = fieldFor(k)
      if (!spec || !field) continue
      splatMax(field, width, height, x, y, spec.radius, spec.gain)
    }
  }
  blurField(range, width, height, SPLAT[MARK_RANGE].blur)
  blurField(hills, width, height, SPLAT[MARK_HILLS].blur)
  blurField(forest, width, height, SPLAT[MARK_FOREST].blur)
  blurField(swamp, width, height, SPLAT[MARK_SWAMP].blur)
  blurField(river, width, height, SPLAT[MARK_RIVER].blur)
  blurField(town, width, height, SPLAT[MARK_TOWN].blur)
  return { range, hills, forest, swamp, river, town }
}
