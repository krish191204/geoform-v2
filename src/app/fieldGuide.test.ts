// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIELD_GUIDE_KEY,
  FIELD_GUIDE_STEPS,
  markFieldGuideDone,
  mountFieldGuide,
  shouldShowFieldGuide,
} from './fieldGuide'

function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k)
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
  }
}

function q<T extends Element>(root: ParentNode, sel: string): T {
  const node = root.querySelector<T>(sel)
  if (!node) throw new Error(`missing ${sel}`)
  return node
}

function pressEscape(root: HTMLElement): void {
  const from = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : root
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('field guide copy', () => {
  it('has four steps of at most two sentences each', () => {
    expect(FIELD_GUIDE_STEPS.map((s) => s.id)).toEqual(['sketch', 'make-sense', 'read-the-planet', 'worldbuild'])
    for (const step of FIELD_GUIDE_STEPS) {
      const sentences = step.body.match(/[.!?](?=\s|$)/g) ?? []
      expect(sentences.length).toBeLessThanOrEqual(2)
    }
  })
})

describe('mountFieldGuide', () => {
  it('renders step 1 in a non-modal dialog and focuses the heading', () => {
    const root = mountFieldGuide({ storage: fakeStorage() })
    const heading = q<HTMLElement>(root, '.field-guide-title')
    expect(root.getAttribute('role')).toBe('dialog')
    expect(root.getAttribute('aria-modal')).toBe('false')
    expect(root.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(heading.textContent).toBe('Sketch')
    expect(q(root, '.field-guide-count').textContent).toBe('1 of 4')
    expect(document.activeElement).toBe(heading)
    for (const btn of Array.from(root.querySelectorAll('button'))) expect(btn.getAttribute('type')).toBe('button')
  })

  it('Next advances to 2 of 4 and Back goes back', () => {
    const root = mountFieldGuide({ storage: fakeStorage() })
    const back = q<HTMLButtonElement>(root, '.field-guide-back')
    expect(back.disabled).toBe(true)
    q<HTMLButtonElement>(root, '.field-guide-next').click()
    expect(q(root, '.field-guide-count').textContent).toBe('2 of 4')
    expect(q(root, '.field-guide-title').textContent).toBe('Make sense')
    expect(document.activeElement).toBe(q(root, '.field-guide-title'))
    back.click()
    expect(q(root, '.field-guide-count').textContent).toBe('1 of 4')
    expect(q(root, '.field-guide-title').textContent).toBe('Sketch')
  })

  it('Done calls onClose and writes done', () => {
    const storage = fakeStorage()
    const onClose = vi.fn()
    const root = mountFieldGuide({ storage, onClose })
    const next = q<HTMLButtonElement>(root, '.field-guide-next')
    next.click()
    next.click()
    next.click()
    expect(next.textContent).toBe('Done')
    next.click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(storage.getItem(FIELD_GUIDE_KEY)).toBe('done')
    expect(root.isConnected).toBe(false)
  })

  it('Escape closes without writing done', () => {
    const storage = fakeStorage()
    const onClose = vi.fn()
    const root = mountFieldGuide({ storage, onClose })
    pressEscape(root)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(root.isConnected).toBe(false)
    expect(storage.getItem(FIELD_GUIDE_KEY)).toBeNull()
    expect(shouldShowFieldGuide(storage)).toBe(true)
  })

  it('Escape writes done when the skip box is ticked', () => {
    const storage = fakeStorage()
    const root = mountFieldGuide({ storage })
    q<HTMLInputElement>(root, 'input.field-guide-skip').checked = true
    pressEscape(root)
    expect(storage.getItem(FIELD_GUIDE_KEY)).toBe('done')
  })

  it('moves the target highlight between steps and clears it on close', () => {
    const a = document.createElement('button')
    a.id = 'a'
    const b = document.createElement('button')
    b.id = 'b'
    document.body.append(a, b)
    const root = mountFieldGuide({
      storage: fakeStorage(),
      steps: [
        { id: 'one', title: 'One', body: 'First.', target: '#a' },
        { id: 'two', title: 'Two', body: 'Second.', target: '#b' },
        { id: 'three', title: 'Three', body: 'Third.', target: '#missing' },
      ],
    })
    expect(a.classList.contains('field-guide-target')).toBe(true)
    q<HTMLButtonElement>(root, '.field-guide-next').click()
    expect(a.classList.contains('field-guide-target')).toBe(false)
    expect(b.classList.contains('field-guide-target')).toBe(true)
    pressEscape(root)
    expect(b.classList.contains('field-guide-target')).toBe(false)
    expect(document.querySelector('.field-guide-target')).toBeNull()
  })

  it('renders step text as text, never markup', () => {
    const root = mountFieldGuide({
      storage: fakeStorage(),
      steps: [{ id: 'x', title: '<b>Bold</b>', body: '<img src=x onerror=alert(1)>' }],
    })
    expect(q(root, '.field-guide-title').textContent).toBe('<b>Bold</b>')
    expect(root.querySelector('b, img')).toBeNull()
  })
})

describe('field guide storage', () => {
  it('stops showing after markFieldGuideDone with the same storage', () => {
    const storage = fakeStorage()
    expect(shouldShowFieldGuide(storage)).toBe(true)
    markFieldGuideDone(storage)
    expect(shouldShowFieldGuide(storage)).toBe(false)
  })

  it('shows when storage throws, and marking never throws', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('denied')
      },
      setItem: (): void => {
        throw new Error('quota')
      },
    }
    expect(shouldShowFieldGuide(broken)).toBe(true)
    expect(() => markFieldGuideDone(broken)).not.toThrow()
  })
})
