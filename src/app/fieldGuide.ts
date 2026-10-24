/**
 * First-run field guide — a small card bottom-left, not a modal. The map stays
 * live underneath; the card only points at controls and explains the three stages.
 */

export interface GuideStep {
  id: string
  title: string
  body: string
  /** CSS selector to softly highlight while this step is shown. */
  target?: string
}

export const FIELD_GUIDE_KEY = 'geoform:field-guide:v1'
const TARGET_CLASS = 'field-guide-target'

export const FIELD_GUIDE_STEPS: readonly GuideStep[] = Object.freeze([
  {
    id: 'sketch',
    title: 'Sketch',
    body: 'Paint land or drag a continent onto the sea. Mountains and rivers you draw are notes, not geography yet.',
    target: '.ux-stage-btn[data-stage="sketch"]',
  },
  {
    id: 'make-sense',
    title: 'Make sense',
    body: 'Make sense turns the doodle into a planet: plates, mountains, seasons, rivers. The coast may move; the amount of land stays.',
    target: '.ux-stage-btn[data-stage="make-sense"]',
  },
  {
    id: 'read-the-planet',
    title: 'Read the planet',
    body: 'Switch on the Geology layer to see the rock under each place and how old it is. Deep time shows the sunlight your world gets, what its rocks hold, and the long history its land allows.',
    target: '[data-look="geology"]',
  },
  {
    id: 'worldbuild',
    title: 'Worldbuild',
    body: 'Place towns, draw countries, and lay trade routes on the planet. Each one sits on land that can support it.',
    target: '.ux-stage-btn[data-stage="worldbuild"]',
  },
])

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

export function shouldShowFieldGuide(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const store = storage ?? defaultStorage()
    if (!store) return true
    return store.getItem(FIELD_GUIDE_KEY) !== 'done'
  } catch {
    return true
  }
}

export function markFieldGuideDone(storage?: Pick<Storage, 'setItem'>): void {
  try {
    const store = storage ?? defaultStorage()
    store?.setItem(FIELD_GUIDE_KEY, 'done')
  } catch {
    // Private mode or quota: the guide simply shows again next visit.
  }
}

type Attrs = Record<string, string | number | boolean | null | undefined>

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue
      if (v === true) node.setAttribute(k, '')
      else node.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

function findTarget(selector: string): Element | null {
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

let mountCount = 0

export function mountFieldGuide(
  opts: { steps?: readonly GuideStep[]; onClose?: () => void; storage?: Storage } = {},
): HTMLElement {
  const steps = opts.steps && opts.steps.length > 0 ? opts.steps : FIELD_GUIDE_STEPS
  const uid = ++mountCount
  const titleId = `field-guide-title-${uid}`
  const bodyId = `field-guide-body-${uid}`

  const title = el('h2', { class: 'field-guide-title', id: titleId, tabindex: -1 })
  const body = el('p', { class: 'field-guide-body', id: bodyId })
  const count = el('p', { class: 'field-guide-count' })
  const closeBtn = el(
    'button',
    { type: 'button', class: 'field-guide-close', 'aria-label': 'Close field guide' },
    '×',
  )
  const progress = el('ol', { class: 'field-guide-progress', 'aria-hidden': 'true' })
  const segments = steps.map(() => el('li', { class: 'field-guide-segment' }))
  progress.append(...segments)

  const skip = el('input', { type: 'checkbox', class: 'field-guide-skip' })
  const skipLabel = el('label', { class: 'field-guide-skip-label' }, skip, "Don't show this again")
  const backBtn = el('button', { type: 'button', class: 'field-guide-back' }, 'Back')
  const nextBtn = el('button', { type: 'button', class: 'field-guide-next' }, 'Next')

  const root = el(
    'aside',
    {
      class: 'field-guide',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': titleId,
      'aria-describedby': bodyId,
    },
    el('div', { class: 'field-guide-head' }, el('p', { class: 'field-guide-eyebrow' }, 'Field guide'), count, closeBtn),
    title,
    body,
    progress,
    el(
      'div',
      { class: 'field-guide-foot' },
      skipLabel,
      el('div', { class: 'field-guide-actions' }, backBtn, nextBtn),
    ),
  )

  let index = 0
  let closed = false
  let lit: Element | null = null
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const clearTarget = (): void => {
    lit?.classList.remove(TARGET_CLASS)
    lit = null
  }

  const render = (): void => {
    const step = steps[index]
    title.textContent = step.title
    body.textContent = step.body
    count.textContent = `${index + 1} of ${steps.length}`
    segments.forEach((seg, i) => {
      seg.classList.toggle('is-done', i < index)
      seg.classList.toggle('is-current', i === index)
    })
    backBtn.disabled = index === 0
    nextBtn.textContent = index === steps.length - 1 ? 'Done' : 'Next'
    root.dataset.step = step.id

    clearTarget()
    const target = step.target ? findTarget(step.target) : null
    if (target) {
      target.classList.add(TARGET_CLASS)
      lit = target
    }
    title.focus()
  }

  const close = (finished: boolean): void => {
    if (closed) return
    closed = true
    if (finished || skip.checked) markFieldGuideDone(opts.storage)
    clearTarget()
    root.remove()
    if (returnFocus && returnFocus.isConnected && returnFocus !== document.body) returnFocus.focus()
    opts.onClose?.()
  }

  nextBtn.addEventListener('click', () => {
    if (index >= steps.length - 1) {
      close(true)
      return
    }
    index += 1
    render()
  })
  backBtn.addEventListener('click', () => {
    if (index === 0) return
    index -= 1
    render()
  })
  closeBtn.addEventListener('click', () => close(false))
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    close(false)
  })

  document.body.append(root)
  render()
  return root
}
