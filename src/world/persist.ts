// Note: depends on the new src/world/types.ts (Wave 2A in flight). Will
// compile cleanly once 2A lands. If 2B finishes first, this file is fine to
// commit; tsconfig will only fail if both end up in main together.

/**
 * Mask-first autosave module.
 *
 * Two layers of persistence:
 *   1. `MASK_SAVE_KEY`  — the user's painted mask + meta. Autosaved continuously
 *      during Sketch. The mask is the *only* thing that survives a tab reload
 *      before Make-sense has been committed.
 *   2. `WORLD_SAVE_KEY` — the full derived World (after Make-sense). Autosaved
 *      when Make-sense commits. Loaded separately on boot, only if the user
 *      clicks "Resume".
 *
 * On boot the mask loads first; the derived world is opt-in. The two stores
 * are independent — you can have a mask without a world (Sketch without
 * Make-sense) or a world without the original mask (re-imported).
 *
 * Backward compatibility: the old `geoform.autosave.v1` key is intentionally
 * ignored. v1 saves are stale and would confuse the new mask-first model.
 */
import type { World, WorldMeta, CellBiome, Polity, TradeRoute } from './types'
import { emptyPolityState } from './types'

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** localStorage key for the mask + meta autosave (Sketch layer). */
export const MASK_SAVE_KEY = 'geoform.mask.v2'

/** Schema version for the mask save. Bump on incompatible changes. */
export const MASK_VERSION = 2

/** localStorage key for the full derived World autosave (Make-sense layer). */
export const WORLD_SAVE_KEY = 'geoform.world.v2'

/** Schema version for the world save. Bump on incompatible changes. */
export const WORLD_VERSION = 2

// ---------------------------------------------------------------------------
// Saved shapes (what sits in localStorage)
// ---------------------------------------------------------------------------

/** What `MASK_SAVE_KEY` holds: a mask + the meta that produced it. */
export interface SavedMask {
  version: 2
  meta: WorldMeta
  /** Float32Array serialized as `number[]` because TypedArrays don't survive JSON.stringify. */
  mask: number[]
}

/**
 * What `WORLD_SAVE_KEY` holds: a full World with typed-array fields
 * flattened to `number[]`. `deserializeWorld` rehydrates the typed arrays.
 */
export interface SavedWorld {
  version: 2
  world: {
    meta: WorldMeta
    mask: number[]
    plateId: number[]
    plateVx: number[]
    plateVy: number[]
    elev: number[]
    seasons: 2 | 4
    summer: number[]
    winter: number[]
    summerMoist: number[]
    winterMoist: number[]
    tempMean: number[]
    tempRange: number[]
    moistMean: number[]
    flux: number[]
    rivers: number[]
    biome: string[]
    suitability: number[]
    cities: World['cities']
    polityId?: number[]
    polities?: Polity[]
    routes?: TradeRoute[]
  }
}

// ---------------------------------------------------------------------------
// Quota error reporting
// ---------------------------------------------------------------------------

/** Structured quota result. The coach can inspect `reason` and surface a UI hint. */
export interface QuotaResult {
  ok: false
  reason: 'quota'
}

const QUOTA: QuotaResult = { ok: false, reason: 'quota' }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Most browsers throw DOMException with name 'QuotaExceededError'; some
  // (Safari) use a different name on the same exception type.
  const name = (err as DOMException).name
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    // Safari fallback: string match on the message.
    /quota/i.test(err.message)
  )
}

/** Best-effort typed-array validator: must be a plain array of finite numbers. */
function isNumberArray(x: unknown): x is number[] {
  if (!Array.isArray(x)) return false
  for (const v of x) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
  }
  return true
}

function validMeta(m: unknown): m is WorldMeta {
  if (!m || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  return (
    typeof o.seed === 'number' &&
    typeof o.width === 'number' &&
    typeof o.height === 'number' &&
    typeof o.planetRadiusKm === 'number' &&
    typeof o.obliquityDeg === 'number' &&
    typeof o.seaLevel === 'number' &&
    typeof o.threshold === 'number'
  )
}

// ---------------------------------------------------------------------------
// Mask layer — Sketch autosave
// ---------------------------------------------------------------------------

/** Build a JSON string `{version:2, meta, mask:number[]}` from in-memory state. */
export function serializeMask(meta: WorldMeta, mask: Float32Array): string {
  const payload: SavedMask = {
    version: 2,
    meta,
    mask: Array.from(mask),
  }
  return JSON.stringify(payload)
}

/** Parse a mask JSON string. Returns null on any failure (malformed, wrong version, shape mismatch). */
export function deserializeMask(json: string): { meta: WorldMeta; mask: Float32Array } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Partial<SavedMask>
  if (o.version !== 2) return null
  if (!validMeta(o.meta)) return null
  if (!isNumberArray(o.mask)) return null
  const expected = o.meta.width * o.meta.height
  if (o.mask.length !== expected) return null
  return { meta: o.meta, mask: Float32Array.from(o.mask) }
}

/** Store as JSON string under `localStorage[MASK_SAVE_KEY]`. Returns false on quota exceeded. */
export function saveMask(meta: WorldMeta, mask: Float32Array): boolean {
  try {
    localStorage.setItem(MASK_SAVE_KEY, serializeMask(meta, mask))
    return true
  } catch (err) {
    if (isQuotaError(err)) return false
    // Unknown write failure — surface as a quota-ish failure for the coach to display.
    console.warn('Geoform mask save failed', err)
    return false
  }
}

/** Load and rehydrate the mask from `localStorage[MASK_SAVE_KEY]`. Null on missing/malformed. */
export function loadMask(): { meta: WorldMeta; mask: Float32Array } | null {
  try {
    const raw = localStorage.getItem(MASK_SAVE_KEY)
    if (!raw) return null
    return deserializeMask(raw)
  } catch (err) {
    console.warn('Geoform mask load failed', err)
    return null
  }
}

/** Remove the mask autosave from `localStorage`. */
export function clearMask(): void {
  localStorage.removeItem(MASK_SAVE_KEY)
}

/** True iff a mask autosave is present in `localStorage`. */
export function hasMask(): boolean {
  return localStorage.getItem(MASK_SAVE_KEY) !== null
}

// ---------------------------------------------------------------------------
// World layer — Make-sense commit autosave
// ---------------------------------------------------------------------------

/** Build a JSON string `{version:2, world:{...typed arrays as number[]}}`. */
export function serializeWorld(world: World): string {
  const payload: SavedWorld = {
    version: 2,
    world: {
      meta: world.meta,
      mask: Array.from(world.mask),
      plateId: Array.from(world.plateId),
      plateVx: Array.from(world.plateVx),
      plateVy: Array.from(world.plateVy),
      elev: Array.from(world.elev),
      seasons: world.seasons,
      summer: Array.from(world.summer),
      winter: Array.from(world.winter),
      summerMoist: Array.from(world.summerMoist),
      winterMoist: Array.from(world.winterMoist),
      tempMean: Array.from(world.tempMean),
      tempRange: Array.from(world.tempRange),
      moistMean: Array.from(world.moistMean),
      flux: Array.from(world.flux),
      rivers: Array.from(world.rivers),
      biome: world.biome.slice(),
      suitability: Array.from(world.suitability),
      cities: world.cities.map((c) => ({ ...c })),
      polityId: Array.from(world.polityId),
      polities: world.polities.map((p) => ({ ...p, analog: { ...p.analog }, exports: [...p.exports], imports: [...p.imports] })),
      routes: world.routes.map((r) => ({ ...r, path: r.path.map((pt) => ({ ...pt })) })),
    },
  }
  return JSON.stringify(payload)
}

/** Parse a world JSON string. Returns null on any failure. */
export function deserializeWorld(json: string): World | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Partial<SavedWorld>
  if (o.version !== 2) return null
  if (!o.world || typeof o.world !== 'object') return null
  const w = o.world as Record<string, unknown>
  if (!validMeta(w.meta)) return null
  if (!isNumberArray(w.mask)) return null
  if (!isNumberArray(w.plateId)) return null
  if (!isNumberArray(w.plateVx)) return null
  if (!isNumberArray(w.plateVy)) return null
  if (!isNumberArray(w.elev)) return null
  if (w.seasons !== 2 && w.seasons !== 4) return null
  if (!isNumberArray(w.summer)) return null
  if (!isNumberArray(w.winter)) return null
  if (!isNumberArray(w.summerMoist)) return null
  if (!isNumberArray(w.winterMoist)) return null
  if (!isNumberArray(w.tempMean)) return null
  if (!isNumberArray(w.tempRange)) return null
  if (!isNumberArray(w.moistMean)) return null
  if (!isNumberArray(w.flux)) return null
  if (!isNumberArray(w.rivers)) return null
  if (!Array.isArray(w.biome) || !w.biome.every((s) => typeof s === 'string')) return null
  if (!isNumberArray(w.suitability)) return null
  if (!Array.isArray(w.cities)) return null

  const n = w.meta.width * w.meta.height
  const expected = (arr: number[]) => arr.length === n

  if (
    !expected(w.mask) ||
    !expected(w.plateId) ||
    !expected(w.plateVx) ||
    !expected(w.plateVy) ||
    !expected(w.elev) ||
    !expected(w.summer) ||
    !expected(w.winter) ||
    !expected(w.summerMoist) ||
    !expected(w.winterMoist) ||
    !expected(w.tempMean) ||
    !expected(w.tempRange) ||
    !expected(w.moistMean) ||
    !expected(w.flux) ||
    !expected(w.rivers) ||
    !expected(w.suitability)
  ) {
    return null
  }

  return {
    meta: w.meta,
    mask: Float32Array.from(w.mask),
    plateId: Int16Array.from(w.plateId),
    plateVx: Float32Array.from(w.plateVx),
    plateVy: Float32Array.from(w.plateVy),
    elev: Float32Array.from(w.elev),
    seasons: w.seasons,
    summer: Float32Array.from(w.summer),
    winter: Float32Array.from(w.winter),
    summerMoist: Float32Array.from(w.summerMoist),
    winterMoist: Float32Array.from(w.winterMoist),
    tempMean: Float32Array.from(w.tempMean),
    tempRange: Float32Array.from(w.tempRange),
    moistMean: Float32Array.from(w.moistMean),
    flux: Float32Array.from(w.flux),
    rivers: Uint8Array.from(w.rivers),
    biome: w.biome.slice() as CellBiome[],
    suitability: Float32Array.from(w.suitability),
    cities: w.cities.map((c) => ({ ...c })),
    ...emptyPolityState(n),
    ...(isNumberArray(w.polityId) && w.polityId.length === n
      ? { polityId: Int16Array.from(w.polityId) }
      : {}),
    ...(Array.isArray(w.polities) ? { polities: w.polities as Polity[] } : {}),
    ...(Array.isArray(w.routes) ? { routes: w.routes as TradeRoute[] } : {}),
  }
}

/** Store as JSON string under `localStorage[WORLD_SAVE_KEY]`. Returns false on quota. */
export function saveWorld(world: World): boolean {
  try {
    localStorage.setItem(WORLD_SAVE_KEY, serializeWorld(world))
    return true
  } catch (err) {
    if (isQuotaError(err)) return false
    console.warn('Geoform world save failed', err)
    return false
  }
}

/** Load and rehydrate the world from `localStorage[WORLD_SAVE_KEY]`. Null on missing/malformed. */
export function loadWorld(): World | null {
  try {
    const raw = localStorage.getItem(WORLD_SAVE_KEY)
    if (!raw) return null
    return deserializeWorld(raw)
  } catch (err) {
    console.warn('Geoform world load failed', err)
    return null
  }
}

/** Remove the world autosave from `localStorage`. */
export function clearWorld(): void {
  localStorage.removeItem(WORLD_SAVE_KEY)
}

/** True iff a world autosave is present in `localStorage`. */
export function hasWorld(): boolean {
  return localStorage.getItem(WORLD_SAVE_KEY) !== null
}

/** Convenience export so callers can dispatch the quota result without re-defining the shape. */
export function quotaError(): QuotaResult {
  return QUOTA
}

// ---------------------------------------------------------------------------
// Binary blob — Storage object, not jsonb
// ---------------------------------------------------------------------------

const BLOB_MAGIC = new Uint8Array([0x47, 0x46, 0x57, 0x32]) // GFW2

function copyView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/**
 * Pack World grids as a binary blob. Catalog metadata stays beside this
 * object; SQL never stores the arrays.
 */
export function serializeWorldBlob(world: World): Uint8Array {
  const header = JSON.stringify({
    version: 2,
    meta: world.meta,
    seasons: world.seasons,
    biome: world.biome,
    cities: world.cities.map((c) => ({ ...c })),
    polities: world.polities,
    routes: world.routes,
    polityId: Array.from(world.polityId),
  })
  const headerBytes = new TextEncoder().encode(header)
  const f32: Float32Array[] = [
    world.mask,
    world.plateVx,
    world.plateVy,
    world.elev,
    world.summer,
    world.winter,
    world.summerMoist,
    world.winterMoist,
    world.tempMean,
    world.tempRange,
    world.moistMean,
    world.flux,
    world.suitability,
  ]
  let body = world.plateId.byteLength + world.rivers.byteLength
  for (const a of f32) body += a.byteLength
  const out = new Uint8Array(8 + headerBytes.length + body)
  out.set(BLOB_MAGIC, 0)
  new DataView(out.buffer).setUint32(4, headerBytes.length, true)
  out.set(headerBytes, 8)
  let o = 8 + headerBytes.length
  const put = (view: ArrayBufferView): void => {
    const bytes = copyView(view)
    out.set(bytes, o)
    o += bytes.byteLength
  }
  for (const a of f32) put(a)
  put(world.plateId)
  put(world.rivers)
  return out
}

/** Rehydrate a blob from `serializeWorldBlob`. Null on any failure. */
export function deserializeWorldBlob(bytes: Uint8Array): World | null {
  if (bytes.length < 8) return null
  for (let i = 0; i < 4; i++) if (bytes[i] !== BLOB_MAGIC[i]) return null
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  const headerStart = 8
  const headerEnd = headerStart + headerLen
  if (headerEnd > bytes.length) return null
  let header: {
    version?: number
    meta?: WorldMeta
    seasons?: 2 | 4
    biome?: string[]
    cities?: World['cities']
    polities?: Polity[]
    routes?: TradeRoute[]
    polityId?: number[]
  }
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerEnd))) as typeof header
  } catch {
    return null
  }
  if (header.version !== 2 || !validMeta(header.meta)) return null
  if (header.seasons !== 2 && header.seasons !== 4) return null
  if (!Array.isArray(header.biome) || !header.biome.every((s) => typeof s === 'string')) return null
  if (!Array.isArray(header.cities)) return null
  const meta = header.meta
  const n = meta.width * meta.height
  const readF32 = (offset: number): Float32Array | null => {
    const end = offset + n * 4
    if (end > bytes.length) return null
    const arr = new Float32Array(n)
    new Uint8Array(arr.buffer).set(bytes.subarray(offset, end))
    return arr
  }
  let o = headerEnd
  const f32Fields: Float32Array[] = []
  for (let k = 0; k < 13; k++) {
    const arr = readF32(o)
    if (!arr) return null
    f32Fields.push(arr)
    o += n * 4
  }
  const plateEnd = o + n * 2
  if (plateEnd > bytes.length) return null
  const plateId = new Int16Array(n)
  new Uint8Array(plateId.buffer).set(bytes.subarray(o, plateEnd))
  o = plateEnd
  const riverEnd = o + n
  if (riverEnd > bytes.length) return null
  const rivers = Uint8Array.from(bytes.subarray(o, riverEnd))
  return {
    meta,
    mask: f32Fields[0],
    plateVx: f32Fields[1],
    plateVy: f32Fields[2],
    elev: f32Fields[3],
    summer: f32Fields[4],
    winter: f32Fields[5],
    summerMoist: f32Fields[6],
    winterMoist: f32Fields[7],
    tempMean: f32Fields[8],
    tempRange: f32Fields[9],
    moistMean: f32Fields[10],
    flux: f32Fields[11],
    suitability: f32Fields[12],
    plateId,
    rivers,
    seasons: header.seasons,
    biome: header.biome.slice() as CellBiome[],
    cities: header.cities.map((c) => ({ ...c })),
    ...emptyPolityState(n),
    ...(Array.isArray(header.polityId) && header.polityId.length === n
      ? { polityId: Int16Array.from(header.polityId) }
      : {}),
    ...(Array.isArray(header.polities) ? { polities: header.polities } : {}),
    ...(Array.isArray(header.routes) ? { routes: header.routes } : {}),
  }
}

// ---------------------------------------------------------------------------
// File I/O — download / upload JSON files
// ---------------------------------------------------------------------------

/** Trigger a browser download of the full world as `geoform-{seed}.json`. */
export function downloadWorld(world: World): void {
  const blob = new Blob([serializeWorld(world)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `geoform-${world.meta.seed}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** Trigger a browser download of the mask + meta as `geoform-mask-{seed}.json`. */
export function downloadMask(meta: WorldMeta, mask: Float32Array): void {
  const blob = new Blob([serializeMask(meta, mask)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `geoform-mask-${meta.seed}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** Read a `File` (drag-drop / `<input type=file>`) and rehydrate a mask. Null on failure. */
export async function readMaskFile(
  file: File,
): Promise<{ meta: WorldMeta; mask: Float32Array } | null> {
  try {
    const text = await file.text()
    return deserializeMask(text)
  } catch {
    return null
  }
}

/** Read a `File` and rehydrate a world. Null on failure. */
export async function readWorldFile(file: File): Promise<World | null> {
  try {
    const text = await file.text()
    return deserializeWorld(text)
  } catch {
    return null
  }
}