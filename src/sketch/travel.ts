/**
 * How long a journey takes. Pure: reads a World, never runs Make sense,
 * never writes the world.
 *
 * Open-country paces are kilometres per day on the mode's own surface
 * (land for foot, army, and caravan; a river for a boat; the sea for a ship).
 * The same kilometres then cost land : river : sea ≈ 8 : 4 : 1, so a step
 * off that home surface is slower on land and cheapest at sea.
 *
 * Kilometres use the equirectangular step from `routeLengthKm` in polities.ts.
 * The formula is copied here. This module does not import `src/app`.
 */

import type { CellBiome, World } from '../world/types'

/** Who is travelling. */
export type JourneyMode = 'foot' | 'army' | 'caravan' | 'river' | 'ship'

/** Season the caller asked about. Absent climate becomes `unknown` on the result. */
export type JourneySeason = 'summer' | 'winter'

/** One reading: distance, days, and whether the season could be applied. */
export interface JourneyEstimate {
  /** Equirectangular path length, kilometres. */
  km: number
  /**
   * Travel time. With no climate arrays this is open-country distance ÷ pace
   * only — no slope, biome, surface, or storm adjustment.
   */
  days: number
  /** Requested season, or `unknown` when the world has no climate arrays. */
  season: JourneySeason | 'unknown'
  /** Short reason. Says the season is unknown when climate arrays are absent. */
  note: string
}

/** Open country, kilometres per day. */
export const PACE_KM_PER_DAY: Readonly<Record<JourneyMode, number>> = {
  /** Solo walker. */
  foot: 30,
  /** Army column. Engels on Macedonian logistics: about 15–20 km/day. */
  army: 18,
  caravan: 30,
  /** River boat. */
  river: 60,
  /** Ship in a fair season. */
  ship: 120,
}

/** Relative effort. Same kilometres cost more on land than on a river, and least at sea. */
const SURFACE_EFFORT = { land: 8, river: 4, sea: 1 } as const

type Surface = keyof typeof SURFACE_EFFORT

/** Ice under foot. */
const ICE_SLOW = 1.75
/** Hot desert under foot: water and heat. */
const HOT_DESERT_SLOW = 1.5
/**
 * Naismith: one extra hour per 600 m of ascent, against a walking pace of
 * 3.75 km/h (30 km in an eight-hour day). River boats and ships ignore slope.
 */
const NAISMITH_ASCENT_M = 600
const WALK_KM_PER_HOUR = 3.75
/**
 * Mid-latitude storm track, same gaussian width as the climate model's
 * wet band at 50°. Peaks at 1 when |lat| is 50°.
 */
const STORM_TRACK_WIDTH = 144
/** At the peak, a winter passage takes twice the fair-season time. Delayed, not moved. */
const WINTER_STORM_DELAY = 1

function kmPerCell(world: World): number {
  const r = world.meta.planetRadiusKm > 0 ? world.meta.planetRadiusKm : 6371
  return (2 * Math.PI * r) / world.meta.width
}

/** Shortest east-west gap on a wrapping grid. Copied from `routeLengthKm`. */
function wrapDx(ax: number, bx: number, w: number): number {
  return Math.min(Math.abs(ax - bx), w - Math.abs(ax - bx))
}

/**
 * One equirectangular kilometre step. Same formula as each segment of
 * `routeLengthKm`: east-west width shrinks with cos(latitude); north-south
 * stays constant.
 */
function stepKm(world: World, ax: number, ay: number, bx: number, by: number): number {
  const { width: w, height: h } = world.meta
  const k = kmPerCell(world)
  const midY = (ay + by) / 2
  const lat = ((midY + 0.5) / h - 0.5) * Math.PI
  const dx = wrapDx(ax, bx, w) * Math.cos(lat)
  return Math.hypot(dx, ay - by) * k
}

function stepLatRad(height: number, ay: number, by: number): number {
  const midY = (ay + by) / 2
  return ((midY + 0.5) / height - 0.5) * Math.PI
}

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

/** Signed shortest east-west delta, so the walk takes the short way around. */
function signedDx(ax: number, bx: number, w: number): number {
  let dx = bx - ax
  if (dx > w / 2) dx -= w
  else if (dx < -w / 2) dx += w
  return dx
}

/** Cells crossed from A to B, inclusive. X wraps; Y does not. */
function walkCells(
  w: number,
  h: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = []
  const x1 = ax + signedDx(ax, bx, w)
  const y1 = by
  let x = ax
  let y = ay
  const adx = Math.abs(x1 - x)
  const ady = Math.abs(y1 - y)
  const sx = x < x1 ? 1 : -1
  const sy = y < y1 ? 1 : -1
  let err = adx - ady
  const guard = adx + ady + 2
  for (let s = 0; s < guard; s++) {
    if (y >= 0 && y < h) cells.push({ x: wrapX(x, w), y })
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -ady) {
      err -= ady
      x += sx
    }
    if (e2 < adx) {
      err += adx
      y += sy
    }
  }
  return cells
}

function hasClimateArrays(world: World): boolean {
  const n = world.meta.width * world.meta.height
  const summer = world.summer
  const winter = world.winter
  return Boolean(summer && winter && summer.length === n && winter.length === n)
}

function homeSurface(mode: JourneyMode): Surface {
  if (mode === 'ship') return 'sea'
  if (mode === 'river') return 'river'
  return 'land'
}

function surfaceAt(world: World, x: number, y: number): Surface {
  const { width: w, threshold } = world.meta
  const i = y * w + x
  const mask = world.mask
  if (mask && i >= 0 && i < mask.length && mask[i] < threshold) return 'sea'
  const rivers = world.rivers
  if (rivers && i >= 0 && i < rivers.length && rivers[i] === 1) return 'river'
  return 'land'
}

function biomeAt(world: World, x: number, y: number): CellBiome | undefined {
  const biome = world.biome
  if (!biome) return undefined
  const { width: w, height: h } = world.meta
  if (y < 0 || y >= h) return undefined
  const i = y * w + wrapX(x, w)
  return biome[i]
}

function elevAt(world: World, x: number, y: number): number {
  const elev = world.elev
  if (!elev) return 0
  const { width: w, height: h } = world.meta
  if (y < 0 || y >= h) return 0
  const i = y * w + wrapX(x, w)
  if (i < 0 || i >= elev.length) return 0
  const z = elev[i]
  return Number.isFinite(z) ? z : 0
}

/** Slope, ice, and hot desert slow foot, army, and caravan. Boats do not feel them. */
function landSlow(mode: JourneyMode, biome: CellBiome | undefined, riseM: number, stepKmLen: number): number {
  if (mode === 'ship' || mode === 'river') return 1
  let slow = 1
  if (stepKmLen > 0 && riseM > 0) {
    slow *= 1 + (riseM / NAISMITH_ASCENT_M) * (WALK_KM_PER_HOUR / stepKmLen)
  }
  if (biome === 'ice') slow *= ICE_SLOW
  if (biome === 'hot-desert') slow *= HOT_DESERT_SLOW
  return slow
}

/**
 * Winter near 50° delays a ship. The factor is 1 in summer and about 1 far
 * from the storm track, so the hull is never skipped ahead.
 */
function shipStorm(mode: JourneyMode, season: JourneySeason, latRad: number): number {
  if (mode !== 'ship' || season !== 'winter') return 1
  const deg = Math.abs((latRad * 180) / Math.PI)
  const track = Math.exp(-((deg - 50) * (deg - 50)) / STORM_TRACK_WIDTH)
  return 1 + track * WINTER_STORM_DELAY
}

function openNote(mode: JourneyMode): string {
  const pace = PACE_KM_PER_DAY[mode]
  return `Open-country pace ${pace} km/day. Land : river : sea effort 8 : 4 : 1.`
}

/**
 * Days to go from (ax, ay) to (bx, by).
 *
 * Does not run Make sense and does not write `world`.
 */
export function journeyDays(
  world: World,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  mode: JourneyMode,
  season: JourneySeason,
): JourneyEstimate {
  const { width: w, height: h } = world.meta
  const pace = PACE_KM_PER_DAY[mode]
  const cells = walkCells(w, h, ax, ay, bx, by)
  let km = 0
  if (cells.length === 0) {
    km = stepKm(world, ax, ay, bx, by)
  } else {
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1]
      const b = cells[i]
      km += stepKm(world, a.x, a.y, b.x, b.y)
    }
  }

  if (!hasClimateArrays(world)) {
    return {
      km,
      days: pace > 0 ? km / pace : 0,
      season: 'unknown',
      note: 'Season unknown. Distance only.',
    }
  }

  const home = SURFACE_EFFORT[homeSurface(mode)]
  let days = 0
  if (cells.length < 2) {
    days = pace > 0 ? km / pace : 0
  } else {
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1]
      const b = cells[i]
      const leg = stepKm(world, a.x, a.y, b.x, b.y)
      if (leg <= 0) continue
      const effort = SURFACE_EFFORT[surfaceAt(world, b.x, b.y)]
      const rise = Math.abs(elevAt(world, b.x, b.y) - elevAt(world, a.x, a.y))
      const slow = landSlow(mode, biomeAt(world, b.x, b.y), rise, leg)
      const storm = shipStorm(mode, season, stepLatRad(h, a.y, b.y))
      days += (leg / pace) * (effort / home) * slow * storm
    }
  }

  return {
    km,
    days,
    season,
    note: openNote(mode),
  }
}
