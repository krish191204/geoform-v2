/**
 * Clear-sea bulk action: zero out every mask cell below a threshold.
 *
 * Sketch's "make it all ocean" brush. Mutates the mask in place.
 */

export interface ClearSeaResult {
  /** Number of cells that were brought to zero. */
  clearedCells: number
  /**
   * True when enough land was cleared that we should hand the map back to
   * the autopilot (the rest is too sparse to make a useful world).
   * Implementation detail of the shell; the brushes just report the flag.
   */
  autopilotTriggered: boolean
}

/**
 * Set `mask[i] = 0` for every cell whose value is below `threshold`.
 * Returns the count of cells touched and whether the autopilot should fire.
 *
 * The autopilot flag is set when more than half the grid is below the
 * threshold — the writer's sketch is mostly empty water.
 */
export function clearSea(
  mask: Float32Array,
  threshold: number,
): ClearSeaResult {
  let clearedCells = 0
  const total = mask.length

  for (let i = 0; i < total; i++) {
    if (mask[i] !== 0 && mask[i] < threshold) {
      mask[i] = 0
      clearedCells++
    }
  }

  const autopilotTriggered = total > 0 && clearedCells * 2 > total
  return { clearedCells, autopilotTriggered }
}