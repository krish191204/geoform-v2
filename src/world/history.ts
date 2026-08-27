/**
 * Mask-only undo. The full World state is rebuilt deterministically from
 * the mask + a seed via makeSense(), so the only thing to undo is the mask.
 */
import type { WorldMeta } from './types'

export interface MaskSnapshot {
  meta: WorldMeta
  mask: Float32Array
  /** Range / river notes. Same length as mask; optional on old snapshots. */
  marks?: Uint8Array
}

const MAX_PAST = 24

function copySnapshot(snapshot: MaskSnapshot): MaskSnapshot {
  return {
    meta: { ...snapshot.meta },
    mask: new Float32Array(snapshot.mask),
    marks: snapshot.marks ? new Uint8Array(snapshot.marks) : undefined,
  }
}

export class MaskHistory {
  private past: MaskSnapshot[] = []
  private future: MaskSnapshot[] = []
  private current: MaskSnapshot | null = null

  push(snapshot: MaskSnapshot): void {
    if (this.current) this.past.push(this.current)
    this.current = copySnapshot(snapshot)
    this.future = []
    while (this.past.length > MAX_PAST) this.past.shift()
  }

  undo(): MaskSnapshot | null {
    if (this.past.length === 0) return null
    const prev = this.past.pop()!
    if (this.current) this.future.push(this.current)
    this.current = prev
    return copySnapshot(this.current)
  }

  redo(): MaskSnapshot | null {
    if (this.future.length === 0) return null
    const next = this.future.pop()!
    if (this.current) this.past.push(this.current)
    this.current = next
    return copySnapshot(this.current)
  }

  clear(): void {
    this.past = []
    this.future = []
    this.current = null
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  snapshot(): MaskSnapshot | null {
    return this.current ? copySnapshot(this.current) : null
  }
}
