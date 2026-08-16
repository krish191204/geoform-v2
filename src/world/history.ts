/**
 * Mask-only undo. The full World state is rebuilt deterministically from
 * the mask + a seed via makeSense(), so the only thing to undo is the mask.
 */
import type { WorldMeta } from './types'

export interface MaskSnapshot {
  meta: WorldMeta
  mask: Float32Array
}

export class MaskHistory {
  private past: MaskSnapshot[] = []
  private future: MaskSnapshot[] = []
  private current: MaskSnapshot | null = null

  push(snapshot: MaskSnapshot): void {
    if (this.current) this.past.push(this.current)
    this.current = snapshot
    this.future = []
  }

  undo(): MaskSnapshot | null {
    if (this.past.length === 0) return null
    const prev = this.past.pop()!
    if (this.current) this.future.push(this.current)
    this.current = prev
    return this.current
  }

  redo(): MaskSnapshot | null {
    if (this.future.length === 0) return null
    const next = this.future.pop()!
    if (this.current) this.past.push(this.current)
    this.current = next
    return this.current
  }

  canUndo(): boolean { return this.past.length > 0 }
  canRedo(): boolean { return this.future.length > 0 }
  snapshot(): MaskSnapshot | null { return this.current }
}