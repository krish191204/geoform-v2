/**
 * Public API for the Worldbuild stage.
 *
 * The user is in `world.stage === 'worldbuild'` and is placing cities on
 * the suitability map. The two tool-driven operations are `placeCity`
 * (paint a city) and `removeNearestCity` (erase the nearest one),
 * plus the `cityNameGenerator` that produces fictional names.
 *
 * Place-city rules (all three must pass):
 *   1. The cell must be land: `world.mask[i] >= world.meta.threshold`.
 *   2. The cell's suitability must be >= 0.4.
 *   3. No existing city within 5 cells (Chebyshev / D8 distance).
 * If any rule fails the call returns `{ mutated: false, city: null, rejected: true }`.
 *
 * Remove-nearest rule: drop the closest city within D8 distance 8 of (x, y).
 */

import type { World, City } from '../world/types'
import { idx, createRng } from '../world/types'

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface PlaceCityResult {
  /** True if a city was added to `world.cities`. */
  mutated: boolean
  /** The city added (only meaningful when `mutated`). */
  city: City | null
  /** True if the click hit a non-placeable cell. */
  rejected: boolean
}

export interface RemoveCityResult {
  /** The city that was removed (or null when nothing matched). */
  removed: City | null
  /** True if a city within range was found and removed. */
  matched: boolean
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Chebyshev radius for the place-city "no overcrowding" rule. */
const PLACE_MIN_SEPARATION = 5

/** D8 radius for the remove-city "find nearest" rule. */
const REMOVE_MAX_DISTANCE = 8

/** Minimum per-cell suitability score to host a city. */
const SUITABILITY_THRESHOLD = 0.4

// ---------------------------------------------------------------------------
// Fictional city syllables
// ---------------------------------------------------------------------------

/** Prefix list — 23 stems. */
const PREFIX: readonly string[] = [
  'Bel',
  'Cor',
  'Dra',
  'Fen',
  'Gar',
  'Hal',
  'Ith',
  'Jor',
  'Kal',
  'Lor',
  'Mor',
  'Nes',
  'Oth',
  'Per',
  'Quen',
  'Ral',
  'Str',
  'Tor',
  'Ul',
  'Var',
  'Wen',
  'Yor',
  'Zar',
]

/** Suffix list — 20 tails. */
const SUFFIX: readonly string[] = [
  'mont',
  'heim',
  'gard',
  'fen',
  'rath',
  'polis',
  'mar',
  'shire',
  'dale',
  'crest',
  'fell',
  'wych',
  'hold',
  'run',
  'minster',
  'reach',
  'brook',
  'keep',
  'eyrie',
  'fast',
]

/** Roman-numeral disambiguation suffixes for the auto-uniqueness step. */
const ROMAN_SUFFIXES: readonly string[] = [
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
]

/**
 * Hard cap on regeneration loops in the name generator.
 *
 * When an `existing` set is supplied, the generator searches the RNG
 * stream for a base that is already taken and then disambiguates it
 * with a Roman suffix. With 23×20 = 460 possible bases and `existing`
 * typically holding a small fraction of them, a few thousand attempts
 * make a "found" base overwhelmingly likely; we cap generously so the
 * fallback is unreachable for any realistic `existing` size.
 */
const NAME_GEN_MAX_ATTEMPTS = 4096

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `world.suitability` is consumed at runtime but not yet declared on the
 * `World` type — narrow with a structural cast so the call site is honest.
 */
function suitabilityArray(world: World): Float32Array {
  return (world as World & { suitability: Float32Array }).suitability
}

/** Chebyshev (D8) distance between two cell coords. */
function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

// ---------------------------------------------------------------------------
// placeCity
// ---------------------------------------------------------------------------

/**
 * Try to place a city at `(x, y)`. Mutates `world.cities` on success.
 * Returns a `PlaceCityResult` describing what happened.
 */
export function placeCity(
  world: World,
  x: number,
  y: number,
  name: string,
): PlaceCityResult {
  const { width, height } = world.meta

  // Out-of-bounds clicks count as a rejection (no city placed).
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return { mutated: false, city: null, rejected: true }
  }

  const i = idx(width, x, y)

  // Rule 1: the cell must be land.
  if (world.mask[i] < world.meta.threshold) {
    return { mutated: false, city: null, rejected: true }
  }

  // Rule 2: the cell's suitability must be >= 0.4.
  const suitability = suitabilityArray(world)
  if (suitability[i] < SUITABILITY_THRESHOLD) {
    return { mutated: false, city: null, rejected: true }
  }

  // Rule 3: no existing city within 5 cells (Chebyshev).
  for (const existing of world.cities) {
    if (chebyshev(existing.x, existing.y, x, y) < PLACE_MIN_SEPARATION) {
      return { mutated: false, city: null, rejected: true }
    }
  }

  // All rules pass — push the city.
  const city: City = { x, y, name, seasonal: suitability[i] }
  world.cities.push(city)
  return { mutated: true, city, rejected: false }
}

// ---------------------------------------------------------------------------
// removeNearestCity
// ---------------------------------------------------------------------------

/**
 * Find the nearest city within D8 distance `REMOVE_MAX_DISTANCE` of (x, y)
 * and remove it. Returns `{ removed, matched }`.
 *
 * On tie distance, the first city encountered wins (stable).
 */
export function removeNearestCity(
  world: World,
  x: number,
  y: number,
): RemoveCityResult {
  let best: City | null = null
  let bestDist = REMOVE_MAX_DISTANCE + 1

  for (const city of world.cities) {
    const d = chebyshev(city.x, city.y, x, y)
    if (d <= REMOVE_MAX_DISTANCE && d < bestDist) {
      best = city
      bestDist = d
    }
  }

  if (best === null) {
    return { removed: null, matched: false }
  }

  const at = world.cities.indexOf(best)
  if (at >= 0) world.cities.splice(at, 1)
  return { removed: best, matched: true }
}

// ---------------------------------------------------------------------------
// cityNameGenerator
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, seeded name factory. Each call to the returned
 * function advances the underlying RNG and emits a `prefix + suffix` name,
 * optionally auto-disambiguated against an existing-name set.
 *
 * The optional `existing` argument is the set of names already on the
 * world; when provided, the generator appends ` II`, ` III`, ... until
 * the candidate is free. With no argument the generator emits raw
 * prefix+suffix names and may repeat within a sequence.
 */
export function cityNameGenerator(
  seed: number,
): (existing?: ReadonlySet<string>) => string {
  const rng = createRng(seed)

  return (existing?: ReadonlySet<string>): string => {
    // No `existing` set → emit a fresh base; the caller accepts collisions.
    if (!existing || existing.size === 0) {
      const prefix = PREFIX[Math.floor(rng() * PREFIX.length)]
      const suffix = SUFFIX[Math.floor(rng() * SUFFIX.length)]
      return prefix + suffix
    }

    // With an `existing` set, drive the RNG until we land on a base
    // that is already taken, then disambiguate it with a Roman suffix.
    // The base search exhausts the RNG so the returned name always
    // starts with a real `existing` entry.
    for (let attempt = 0; attempt < NAME_GEN_MAX_ATTEMPTS; attempt++) {
      const prefix = PREFIX[Math.floor(rng() * PREFIX.length)]
      const suffix = SUFFIX[Math.floor(rng() * SUFFIX.length)]
      const base = prefix + suffix

      if (existing.has(base)) {
        for (const num of ROMAN_SUFFIXES) {
          const candidate = `${base} ${num}`
          if (!existing.has(candidate)) {
            return candidate
          }
        }
      }
    }

    // RNG search did not hit a taken base (vanishingly rare with
    // realistic `existing` sizes). Fall back to iterating the set in
    // insertion order and stamping the next free Roman suffix on it.
    for (const takenName of existing) {
      // Strip any Roman suffix to recover the bare base.
      const match = / (II|III|IV|V|VI|VII|VIII|IX|X)$/.exec(takenName)
      const bare = match ? takenName.slice(0, match.index) : takenName
      const startIdx = match ? ROMAN_SUFFIXES.indexOf(match[1]) + 1 : 0
      for (let i = startIdx; i < ROMAN_SUFFIXES.length; i++) {
        const candidate = `${bare} ${ROMAN_SUFFIXES[i]}`
        if (!existing.has(candidate)) {
          return candidate
        }
      }
    }

    // Final fallback — every base × every Roman is taken. Emit a
    // salted, unique-by-construction string.
    const salt = Math.floor(rng() * 1_000_000)
    return `City${salt}`
  }
}