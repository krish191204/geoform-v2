import { describe, expect, it } from 'vitest'
import { DEFAULT_META } from './types'
import { MaskHistory } from './history'

describe('MaskHistory', () => {
  it('undoes to a copy so later dabs cannot rewrite the snapshot', () => {
    const hist = new MaskHistory()
    const a = new Float32Array(4)
    hist.push({ meta: { ...DEFAULT_META, width: 2, height: 2 }, mask: a })
    a[0] = 1
    const b = new Float32Array([1, 0, 0, 0])
    hist.push({ meta: { ...DEFAULT_META, width: 2, height: 2 }, mask: b })
    const undone = hist.undo()
    expect(undone).toBeTruthy()
    expect(undone!.mask[0]).toBe(0)
    expect(hist.canRedo()).toBe(true)
    const redone = hist.redo()
    expect(redone!.mask[0]).toBe(1)
  })

  it('copies range notes so a later dab cannot rewrite undo', () => {
    const hist = new MaskHistory()
    const live = new Uint8Array([1, 0, 0, 0])
    hist.push({
      meta: { ...DEFAULT_META, width: 2, height: 2 },
      mask: new Float32Array(4),
      marks: live,
    })
    hist.push({
      meta: { ...DEFAULT_META, width: 2, height: 2 },
      mask: new Float32Array([1, 0, 0, 0]),
      marks: new Uint8Array([2, 0, 0, 0]),
    })
    live[0] = 9
    const prev = hist.undo()
    expect(prev?.marks?.[0]).toBe(1)
    expect(live[0]).toBe(9)
  })
})
