/**
 * Public Make-sense orchestrator.
 *
 * Tries the Web Worker variant first (so the heavy pipeline never blocks
 * the UI thread); falls back to the inline runner when `Worker` is
 * unavailable (SSR, tests, very old runtimes). The fallback path
 * delegates straight to `makeSenseInline` so both paths produce
 * byte-identical output for the same input.
 *
 * The public surface is:
 *
 *   - `makeSense(input)`            — fire-and-await entry point.
 *   - `worldFromMakeSense(...)`     — stitch result + mask into a World.
 *   - `MakeSenseWorker`             — long-lived worker wrapper.
 *   - `TOTAL_STEPS`                 — the seven-step step count.
 *   - `MASK_LOCK_AREA_FRACTION`     — 5% drift budget.
 *   - `MASK_LOCK_MIN_COMPONENT`     — 100-cell per-component epsilon.
 */

import type { CellBiome, Provenance, World, WorldMeta } from '../world/types'
import { SEASONS_V1 } from '../world/types'
import type { MakeSenseInput, MakeSenseResult, StepResult } from './types'
import { MakeSenseWorker } from './makeSense.worker'
import { makeSenseInline } from './makeSense_inline'

export {
  MakeSenseWorker,
} from './makeSense.worker'

export {
  TOTAL_STEPS,
  MASK_LOCK_AREA_FRACTION,
  MASK_LOCK_MIN_COMPONENT,
  makeSenseInline,
} from './makeSense_inline'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Make-sense pipeline. Prefers the Web Worker when available;
 * otherwise drives the inline runner directly. Progress is forwarded to
 * `onStep` (if supplied) and announced through the coach channel
 * regardless of which path is taken.
 *
 * The returned promise resolves with the full `MakeSenseResult` and
 * rejects if any step throws — most commonly when the mask lock is
 * violated after step 7.
 */
export async function makeSense(
  input: MakeSenseInput,
  onStep?: (step: StepResult) => void,
): Promise<MakeSenseResult> {
  const stepSink = onStep ?? noop
  const worker = tryCreateWorker()
  if (worker !== null) {
    try {
      return await runWithWorker(worker, input, stepSink)
    } catch (err) {
      // Worker failure isn't recoverable for the current input; surface it
      // instead of silently retrying inline. Mask-lock errors fall through
      // here unchanged.
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
  return makeSenseInline(input, stepSink)
}

/**
 * Turn a pipeline result into the World the rest of the app reads.
 * Uses the grounded mask from Make sense when present; otherwise the sketch.
 */
export function worldFromMakeSense(
  result: MakeSenseResult,
  meta: WorldMeta,
  mask: Float32Array,
): World {
  return {
    meta: { ...meta },
    mask: new Float32Array(result.mask ?? mask),
    plateId: result.plateId,
    plateVx: result.plateVx,
    plateVy: result.plateVy,
    elev: result.elev,
    seasons: SEASONS_V1,
    summer: result.summer,
    winter: result.winter,
    summerMoist: result.summerMoist,
    winterMoist: result.winterMoist,
    tempMean: result.tempMean,
    tempRange: result.tempRange,
    moistMean: result.moistMean,
    flux: result.flux,
    rivers: result.rivers,
    biome: result.biome as CellBiome[],
    suitability: result.suitability,
    cities: [],
  }
}

/** Map pipeline provenance onto the editor Provenance shape. */
export function provenanceFromResult(result: MakeSenseResult): Provenance {
  return {
    steps: result.provenance.steps.map((s) => {
      const measurements: Record<string, number> = {}
      for (const [k, v] of Object.entries(s.measurements)) {
        if (typeof v === 'number') measurements[k] = v
      }
      return { name: s.stepName, at: s.elapsedMs, measurements }
    }),
    inputMaskArea: result.provenance.inputMaskArea,
    outputMaskArea: result.provenance.outputMaskArea,
    maskDeltaPct: Number.isFinite(result.provenance.maskDeltaPct)
      ? result.provenance.maskDeltaPct
      : 0,
    scoreBefore: result.provenance.scoreBefore,
    scoreAfter: result.provenance.scoreAfter,
  }
}

// ---------------------------------------------------------------------------
// Internal: worker path
// ---------------------------------------------------------------------------

/**
 * Spin up a `MakeSenseWorker`, forward progress to `onStep`, await the
 * result, then terminate the worker so each `makeSense` call uses a
 * fresh isolate. Terminating is cheap; spawning is the dominant cost.
 */
function runWithWorker(
  worker: MakeSenseWorker,
  input: MakeSenseInput,
  onStep: (step: StepResult) => void,
): Promise<MakeSenseResult> {
  const unsubscribe = worker.onProgress(onStep)
  return worker.run(input).finally(unsubscribe).finally(() => worker.terminate())
}

/** Minimal lazy import to avoid pulling the worker module into bundles that don't need it. */
function tryCreateWorker(): MakeSenseWorker | null {
  try {
    return new MakeSenseWorker()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// No-op sink
// ---------------------------------------------------------------------------

/** Default progress sink used when the caller doesn't supply one. */
function noop(_step: StepResult): void {
  /* discard */
}