/**
 * Deterministic test fixtures for the pipeline layer.
 *
 * Every fixture is a `TestWorld`: a soft land mask plus the geography
 * the Make-sense modules need to compute against. All fixtures are
 * fully reproducible — same call → same mask, bit-for-bit.
 */

import { createRng } from '../helpers'

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** Default seed for the single-continent fixture. */
export const SEED_1 = 12345
/** Alternate seed used to verify that two runs diverge. */
export const SEED_2 = 67890
/** Seed used by the "criss-cross" tectonic regression cases. */
export const SEED_CRISSCROSS = 42

// ---------------------------------------------------------------------------
// TestWorld
// ---------------------------------------------------------------------------

/** A self-contained world fixture: mask + the meta the pipeline needs. */
export interface TestWorld {
  /** Map width in cells. */
  width: number
  /** Map height in cells. */
  height: number
  /** Soft land mask, length width*height, values 0..1. */
  mask: Float32Array
  /** Planet radius in km (default Earth = 6371). */
  planetRadiusKm: number
  /** Axial tilt in degrees (default Earth = 23.5). */
  obliquityDeg: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_RADIUS_KM = 6371
const DEFAULT_OBLIQUITY_DEG = 23.5

function emptyMask(width: number, height: number): Float32Array {
  return new Float32Array(width * height)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * 64×32 world with a single circular continent centred at (32, 16), radius 20.
 * The seed parameter is accepted for symmetry with other fixtures but is
 * unused here — the continent is geometric, not stochastic.
 */
export function makeContinentWorld(seed: number = SEED_1): TestWorld {
  void seed // accepted for API symmetry; geometry is deterministic.
  const width = 64
  const height = 32
  const mask = emptyMask(width, height)
  const cx = 32
  const cy = 16
  const r = 20
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distance measured through the wrap seam so the continent stays round.
      const bestDx = Math.min(
        Math.abs(x - cx),
        Math.abs(x - cx + width),
        Math.abs(x - cx - width),
      )
      const dy = y - cy
      mask[y * width + x] = bestDx * bestDx + dy * dy < r * r ? 1 : 0
    }
  }
  return {
    width,
    height,
    mask,
    planetRadiusKm: DEFAULT_RADIUS_KM,
    obliquityDeg: DEFAULT_OBLIQUITY_DEG,
  }
}

/**
 * 96×48 world with two continents at (24, 24) and (72, 24), radius 15 each.
 * Use this when a fixture needs to exercise more than one plate boundary.
 */
export function makeTwinContinentWorld(): TestWorld {
  const width = 96
  const height = 48
  const mask = emptyMask(width, height)
  const continents = [
    { cx: 24, cy: 24, r: 15 },
    { cx: 72, cy: 24, r: 15 },
  ]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = false
      for (const c of continents) {
        const bestDx = Math.min(
          Math.abs(x - c.cx),
          Math.abs(x - c.cx + width),
          Math.abs(x - c.cx - width),
        )
        const dy = y - c.cy
        if (bestDx * bestDx + dy * dy < c.r * c.r) {
          hit = true
          break
        }
      }
      mask[y * width + x] = hit ? 1 : 0
    }
  }
  return {
    width,
    height,
    mask,
    planetRadiusKm: DEFAULT_RADIUS_KM,
    obliquityDeg: DEFAULT_OBLIQUITY_DEG,
  }
}

/**
 * 64×32 world with a full-width polar strip of land from y = 0..3.
 * Used to exercise high-latitude climate behaviour and polar biome tagging.
 */
export function makePolarStripWorld(): TestWorld {
  const width = 64
  const height = 32
  const mask = emptyMask(width, height)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < width; x++) {
      mask[y * width + x] = 1
    }
  }
  return {
    width,
    height,
    mask,
    planetRadiusKm: DEFAULT_RADIUS_KM,
    obliquityDeg: DEFAULT_OBLIQUITY_DEG,
  }
}

/**
 * 64×32 world where each cell is independently 5% land via a seeded RNG.
 * Useful for connectivity tests, speckle-noise assertions, and fuzz-style
 * regressions — the exact pattern depends on the seed.
 */
export function makeSpeckleWorld(seed: number = SEED_1): TestWorld {
  const width = 64
  const height = 32
  const mask = emptyMask(width, height)
  const rng = createRng(seed)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = rng() < 0.05 ? 1 : 0
  }
  return {
    width,
    height,
    mask,
    planetRadiusKm: DEFAULT_RADIUS_KM,
    obliquityDeg: DEFAULT_OBLIQUITY_DEG,
  }
}

/**
 * 32×16 world with no land at all. Exercises the all-sea degenerate case:
 * pipeline must return sane zeros, not NaN, for empty masks.
 */
export function makeEmptySeaWorld(): TestWorld {
  const width = 32
  const height = 16
  return {
    width,
    height,
    mask: emptyMask(width, height),
    planetRadiusKm: DEFAULT_RADIUS_KM,
    obliquityDeg: DEFAULT_OBLIQUITY_DEG,
  }
}