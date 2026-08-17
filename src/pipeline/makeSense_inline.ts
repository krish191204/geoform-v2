/**
 * Inline (testable) Make-sense pipeline.
 *
 * Stitches the seven Make-sense modules into a single deterministic run that
 * can be exercised in either the main thread or a Web Worker. Every step is
 * timed, recorded into `StepResult`s, and surfaced through the `onStep`
 * callback and the existing `announce` coach channel. After step 7 the
 * orchestrator enforces the mask lock: the big-components count must not
 * move by more than 5% of the input land area (small components under
 * 100 cells may disappear).
 *
 * Pipeline modules MUST NOT mutate `input.mask`. They read it; they emit
 * new typed arrays. The mask lock is therefore computed against the
 * input mask both before and after, so any drift across the seven
 * steps would show up here.
 */

import { bigComponentsMask, meanLand } from './helpers'
import type {
  MakeSenseInput,
  MakeSenseResult,
  StepResult,
} from './types'
import { assignPlatesUnderMask } from './plates'
import { computeOrogeny } from './orogeny'
import { computeSeasonalClimate } from './seasonalClimate'
import { computeHydrology } from './hydrology'
import { computeBiomes } from './biomes'
import { computeSuitability } from './suitability'
import { announce } from '../app/coach'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of pipeline steps the orchestrator runs. */
export const TOTAL_STEPS = 7

/** Largest allowed relative drift in land area, expressed as a fraction. */
export const MASK_LOCK_AREA_FRACTION = 0.05

/** Components below this cell count are exempt from the mask lock. */
export const MASK_LOCK_MIN_COMPONENT = 100

/** Step identifier for the freeze-intent snapshot. */
const STEP_FREEZE = 'freezeIntent'
const STEP_PLATES = 'plates'
const STEP_OROGENY = 'orogeny'
const STEP_CLIMATE = 'seasonalClimate'
const STEP_HYDRO = 'hydrology'
const STEP_BIOMES = 'biomes'
const STEP_SUITABILITY = 'suitability'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-run provenance step index, 1-based. */
type StepIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Wall-clock in milliseconds; falls back to Date.now when performance is missing. */
function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/** Land-cell count of `mask` at the given threshold. */
function maskArea(mask: Float32Array, threshold: number): number {
  let count = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] >= threshold) count++
  }
  return count
}

/** Peak value of `values` over cells where `mask[i] >= threshold`. */
function peakLand(values: Float32Array, mask: Float32Array, threshold: number): number {
  let peak = 0
  for (let i = 0; i < values.length; i++) {
    if (mask[i] >= threshold && values[i] > peak) peak = values[i]
  }
  return peak
}

/** Mean of `values` over cells where `mask[i] >= threshold`; 0 when no land. */
function meanLandSafe(values: Float32Array, mask: Float32Array, threshold: number): number {
  return meanLand(values, mask, threshold)
}

/** Mean of `a - b` over land cells; 0 when no land. */
function meanDifferenceLand(
  a: Float32Array,
  b: Float32Array,
  mask: Float32Array,
  threshold: number,
): number {
  let sum = 0
  let count = 0
  for (let i = 0; i < a.length; i++) {
    if (mask[i] >= threshold) {
      sum += a[i] - b[i]
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

/** Sum of a Uint8Array. */
function sumUint8(arr: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < arr.length; i++) sum += arr[i]
  return sum
}

/** Encode the (x, y) of the max-suit cell into a single cell index. */
function packCell(i: number, width: number): number {
  void width
  return i
}

/** Record a step into the provenance trail, fire the callback, and announce. */
function recordStep(
  step: StepResult,
  index: StepIndex,
  onStep: (step: StepResult) => void,
): void {
  onStep(step)
  announce({
    kind: 'makeSense.step',
    stepName: step.stepName,
    stepIndex: index,
    totalSteps: TOTAL_STEPS,
    elapsedMs: step.elapsedMs,
  })
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run the full Make-sense pipeline in the current thread.
 *
 * Pure with respect to the caller — `input.mask` is never mutated. Returns
 * a fully-populated `MakeSenseResult` (or throws if the mask lock is
 * violated). Progress is reported through `onStep` after every step; the
 * same data is announced to the coach.
 */
export async function makeSenseInline(
  input: MakeSenseInput,
  onStep: (step: StepResult) => void,
): Promise<MakeSenseResult> {
  const { mask, meta } = input
  const { width, height, threshold, seed, planetRadiusKm, obliquityDeg } = meta
  const steps: StepResult[] = []
  const capture: (step: StepResult) => void = (s) => {
    steps.push(s)
  }
  const emit: (step: StepResult) => void = (s) => {
    capture(s)
    onStep(s)
  }
  const stage = (step: StepResult, index: StepIndex): void => {
    recordStep(step, index, emit)
  }

  // -- Step 1: freezeIntent -----------------------------------------------
  // Snapshot the input mask, count its land area, and stamp the big-
  // components fingerprint so the mask lock has something to compare
  // against at the end of the run.
  const t0 = now()
  const inputMaskArea = maskArea(mask, threshold)
  const bigBefore = bigComponentsMask(mask, width, height, threshold, MASK_LOCK_MIN_COMPONENT)
  stage(
    {
      stepName: STEP_FREEZE,
      measurements: {
        inputMaskArea,
        bigComponentsBefore: bigBefore.count,
      },
      elapsedMs: now() - t0,
    },
    1,
  )

  // -- Step 2: plates ------------------------------------------------------
  // Voronoi-style assignment under the soft mask, deterministic from
  // `seed`. Emits per-cell plate id, drift velocity, the plate roster,
  // and the classified boundaries between adjacent plates.
  const t1 = now()
  const platesResult = assignPlatesUnderMask(
    mask,
    width,
    height,
    seed,
    planetRadiusKm,
    obliquityDeg,
    threshold,
  )
  let plateCount = 0
  for (const p of platesResult.plates) {
    if (p.area > 0) plateCount++
  }
  stage(
    {
      stepName: STEP_PLATES,
      measurements: {
        plateCount,
        boundaryCount: platesResult.boundaries.length,
      },
      elapsedMs: now() - t1,
    },
    2,
  )

  // -- Step 3: orogeny -----------------------------------------------------
  // Convert plate boundaries + drift into elevation. Returns the elevation
  // field plus any auxiliary data the climate step needs.
  const t2 = now()
  const orogeny = computeOrogeny(platesResult, mask, width, height, threshold)
  const peakElev = peakLand(orogeny.elev, mask, threshold)
  const meanElev = meanLandSafe(orogeny.elev, mask, threshold)
  stage(
    {
      stepName: STEP_OROGENY,
      measurements: { peakElev, meanElev },
      elapsedMs: now() - t2,
    },
    3,
  )

  // -- Step 4: seasonalClimate ---------------------------------------------
  // Two-season climate (summer + winter, warm and cold halves of the year).
  // Drives everything downstream: biomes, suitability, plausibility score.
  const t3 = now()
  const seasonal = computeSeasonalClimate(
    orogeny,
    mask,
    width,
    height,
    threshold,
    planetRadiusKm,
    obliquityDeg,
    seed,
  )
  const meanSummerC = meanLandSafe(seasonal.summer, mask, threshold)
  const meanWinterC = meanLandSafe(seasonal.winter, mask, threshold)
  const meanRangeC = meanDifferenceLand(
    seasonal.summer,
    seasonal.winter,
    mask,
    threshold,
  )
  stage(
    {
      stepName: STEP_CLIMATE,
      measurements: { meanSummerC, meanWinterC, meanRangeC },
      elapsedMs: now() - t3,
    },
    4,
  )

  // -- Step 5: hydrology ---------------------------------------------------
  // Accumulate downhill flux from the elevation field; threshold the
  // accumulated flux into a rivers mask (Uint8).
  const t4 = now()
  const hydro = computeHydrology(orogeny.elev, mask, width, height, threshold)
  const riverCount = sumUint8(hydro.rivers)
  const maxFlux = peakLand(hydro.flux, mask, threshold)
  stage(
    {
      stepName: STEP_HYDRO,
      measurements: { riverCount, maxFlux },
      elapsedMs: now() - t4,
    },
    5,
  )

  // -- Step 6: biomes ------------------------------------------------------
  // Classify each land cell into one of the twelve atlas biomes from the
  // seasonal climate + mask.
  const t5 = now()
  const biomesResult = computeBiomes(
    seasonal.summer,
    seasonal.winter,
    seasonal.summerMoist,
    seasonal.winterMoist,
    mask,
    threshold,
    // Pass elevation so the alpine override (`elev >= 3500`) actually fires.
    // Without this, the alpine branch in `classifyBiome` is dead code.
    orogeny.elev,
    // Annual mean from the climate step (same as (summer+winter)/2 after
    // lapse, ocean inertia, and clamps).
    seasonal.tempMean,
  )
  const biomeCounts = new Map<string, number>()
  for (let i = 0; i < biomesResult.biome.length; i++) {
    if (mask[i] >= threshold) {
      const name = biomesResult.biome[i]
      biomeCounts.set(name, (biomeCounts.get(name) ?? 0) + 1)
    }
  }
  let dominantBiome = 'ocean'
  let dominantCount = 0
  for (const [name, count] of biomeCounts) {
    if (count > dominantCount) {
      dominantBiome = name
      dominantCount = count
    }
  }
  stage(
    {
      stepName: STEP_BIOMES,
      measurements: { dominantBiome, biomeCount: biomeCounts.size },
      elapsedMs: now() - t5,
    },
    6,
  )

  // -- Step 7: suitability -------------------------------------------------
  // Combine biome, hydrology, and seasonality into a 0..1 score per cell.
  const t6 = now()
  const suitabilityResult = computeSuitability(
    biomesResult.biome,
    hydro.flux,
    hydro.rivers,
    mask,
    seasonal.summer,
    seasonal.winter,
    width,
    height,
    threshold,
  )
  const suitability = suitabilityResult.suitability
  let maxSuit = 0
  let bestSuitLocation = -1
  for (let i = 0; i < suitability.length; i++) {
    if (suitability[i] > maxSuit) {
      maxSuit = suitability[i]
      bestSuitLocation = packCell(i, width)
    }
  }
  stage(
    {
      stepName: STEP_SUITABILITY,
      measurements: { bestSuitLocation, maxSuit },
      elapsedMs: now() - t6,
    },
    7,
  )

  // -- Annual aggregates ---------------------------------------------------
  // tempMean comes from the climate step. tempRange and moistMean
  // are the seasonal deltas / means used by Critique and the inspector.
  const tempRange = new Float32Array(mask.length)
  const moistMean = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) {
    tempRange[i] = seasonal.summer[i] - seasonal.winter[i]
    moistMean[i] = 0.5 * (seasonal.summerMoist[i] + seasonal.winterMoist[i])
  }

  // -- Mask lock -----------------------------------------------------------
  // Re-run the big-components fingerprint after the full pipeline and
  // demand the area not have moved by more than `MASK_LOCK_AREA_FRACTION`
  // of the input land area (with the per-component epsilon accounting
  // for sub-100-cell slivers that legitimately disappear under
  // thresholding).
  const bigAfter = bigComponentsMask(mask, width, height, threshold, MASK_LOCK_MIN_COMPONENT)
  let outputMaskArea = 0
  for (let i = 0; i < bigAfter.mask.length; i++) outputMaskArea += bigAfter.mask[i]
  const areaDelta = outputMaskArea - inputMaskArea
  const allowed = MASK_LOCK_AREA_FRACTION * Math.max(inputMaskArea, 1)
  if (Math.abs(areaDelta) > allowed) {
    throw new Error(
      `Mask lock violated: land area drifted by ${areaDelta} cells ` +
        `(${((areaDelta / Math.max(inputMaskArea, 1)) * 100).toFixed(2)}%), ` +
        `allowed ±${(MASK_LOCK_AREA_FRACTION * 100).toFixed(2)}% ` +
        `(±${allowed.toFixed(0)} cells of ${inputMaskArea}).`,
    )
  }
  const maskDeltaPct =
    inputMaskArea > 0 ? (areaDelta / inputMaskArea) * 100 : 0

  // -- Build result --------------------------------------------------------
  // Provenance scores are filled in by the conductor after Critique runs;
  // here we emit zero placeholders so the shape is complete.
  return {
    plateId: platesResult.plateId,
    plateVx: platesResult.plateVx,
    plateVy: platesResult.plateVy,
    elev: orogeny.elev,
    summer: seasonal.summer,
    winter: seasonal.winter,
    summerMoist: seasonal.summerMoist,
    winterMoist: seasonal.winterMoist,
    tempMean: seasonal.tempMean,
    tempRange,
    moistMean,
    flux: hydro.flux,
    rivers: hydro.rivers,
    biome: biomesResult.biome,
    suitability,
    provenance: {
      steps,
      inputMaskArea,
      outputMaskArea,
      maskDeltaPct,
      scoreBefore: 0,
      scoreAfter: 0,
    },
  }
}