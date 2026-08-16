/**
 * Internal pipeline types — the foundation every Make-sense module reads.
 *
 * Distinct from `src/world/types.ts` which holds the user-facing `World` shape.
 * Pipeline modules never see `World`; they read `MakeSenseInput` and emit
 * the intermediate types below. The conductor stitches them into `World`.
 */

// ---------------------------------------------------------------------------
// Tectonics
// ---------------------------------------------------------------------------

/** A single tectonic plate: id, centroid, drift velocity, and area. */
export interface Plate {
  /** Stable plate id in [0, plateCount-1]. */
  id: number
  /** Centroid x in cells. */
  cx: number
  /** Centroid y in cells. */
  cy: number
  /** Drift velocity x in cells per Myr. */
  vx: number
  /** Drift velocity y in cells per Myr. */
  vy: number
  /** Cell count covered by this plate. */
  area: number
}

/** Boundary classification between two adjacent plates. */
export type BoundaryClass =
  /** Continental-continental collision → mountains. */
  | 'convergent-cc'
  /** Oceanic-continental subduction → arc + trench. */
  | 'convergent-oc'
  /** Spreading ridge → rift valley. */
  | 'divergent'
  /** Lateral slide → no elevation change. */
  | 'transform'
  /** Same-plate edge (not a real boundary). */
  | 'passive'

/** A single boundary segment between two adjacent plates. */
export interface Boundary {
  /** Cell index of the boundary cell. */
  i: number
  /** Cell index of the neighbouring plate's cell. */
  ji: number
  /** Primary plate id at cell `i`. */
  plateId: number
  /** Secondary plate id at cell `ji`. */
  otherPlateId: number
  /** Classified boundary type. */
  class: BoundaryClass
  /** Relative velocity x between the two plates, cells/Myr. */
  relativeVx: number
  /** Relative velocity y between the two plates, cells/Myr. */
  relativeVy: number
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** One pipeline step: what it did, when, and what it measured. */
export interface StepResult {
  /** Step identifier (e.g. "tectonics", "climate", "biomes"). */
  stepName: string
  /** Measurements emitted by the step (numeric e.g. landArea, meanTemp; label e.g. dominantBiome). */
  measurements: Record<string, number | string>
  /** Wall-clock time the step took, in milliseconds. */
  elapsedMs: number
}

// ---------------------------------------------------------------------------
// Climate intermediates
// ---------------------------------------------------------------------------

/** Climate fields before the seasonal aggregator writes them onto the world. */
export interface ClimateInter {
  /** Summer (warm half) mean temperature per cell, °C. Length W*H. */
  summer: Float32Array
  /** Winter (cold half) mean temperature per cell, °C. Length W*H. */
  winter: Float32Array
  /** Summer monthly precipitation index, 0..1. Length W*H. */
  summerMoist: Float32Array
  /** Winter monthly precipitation index, 0..1. Length W*H. */
  winterMoist: Float32Array
}

// ---------------------------------------------------------------------------
// Cached intermediates
// ---------------------------------------------------------------------------

/** Coastal distance cache: BFS distance from the nearest sea cell. */
export interface CoastDist {
  /** Distance in cells from any sea cell (sea cells = 0). Length W*H. */
  dist: Float32Array
  /** Unix milliseconds when the cache was built. */
  computedAt: number
}

// ---------------------------------------------------------------------------
// Pipeline IO bundles
// ---------------------------------------------------------------------------

/** What every pipeline module receives at the top of Make-sense. */
export interface MakeSenseInput {
  /** Sketch-stage parameters, locked at pipeline entry. */
  meta: {
    /** World seed. */
    seed: number
    /** Map width in cells. */
    width: number
    /** Map height in cells. */
    height: number
    /** Planet radius in km. */
    planetRadiusKm: number
    /** Axial tilt in degrees (drives seasonality). */
    obliquityDeg: number
    /** Sea level as a fractional mask threshold, 0..1. */
    seaLevel: number
    /** Land mask threshold, 0..1. */
    threshold: number
  }
  /** Authoritative soft mask from Sketch, 0..1, length W*H. */
  mask: Float32Array
}

/** Everything Make-sense produces; the conductor maps it into `World`. */
export interface MakeSenseResult {
  /** Per-cell plate id; length W*H. */
  plateId: Int16Array
  /** Per-cell drift velocity x in cells/Myr; length W*H. */
  plateVx: Float32Array
  /** Per-cell drift velocity y in cells/Myr; length W*H. */
  plateVy: Float32Array
  /** Elevation in metres; length W*H. */
  elev: Float32Array
  /** Summer mean temperature, °C; length W*H. */
  summer: Float32Array
  /** Winter mean temperature, °C; length W*H. */
  winter: Float32Array
  /** Summer precipitation index, 0..1; length W*H. */
  summerMoist: Float32Array
  /** Winter precipitation index, 0..1; length W*H. */
  winterMoist: Float32Array
  /** Annual mean temperature, °C; length W*H. */
  tempMean: Float32Array
  /** Annual temperature swing (summer − winter), °C; length W*H. */
  tempRange: Float32Array
  /** Annual mean precipitation index, 0..1; length W*H. */
  moistMean: Float32Array
  /** Accumulated downhill water flux per cell; length W*H. */
  flux: Float32Array
  /** 1 = river cell, 0 = not; length W*H. */
  rivers: Uint8Array
  /** Per-cell biome id; length W*H. */
  biome: string[]
  /** Per-cell suitability score, 0..1; length W*H. */
  suitability: Float32Array
  /** Anti-gaslight trail of what the pipeline did and how the mask moved. */
  provenance: {
    /** Ordered list of step results. */
    steps: StepResult[]
    /** Land cell count of the input mask. */
    inputMaskArea: number
    /** Land cell count of the output mask. */
    outputMaskArea: number
    /** Percent change between input and output mask areas. */
    maskDeltaPct: number
    /** Plausibility score before any mask edits. */
    scoreBefore: number
    /** Plausibility score after all mask edits. */
    scoreAfter: number
  }
}