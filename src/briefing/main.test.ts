// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { defaultBriefingState, mountBriefing } from './main'

function host(): HTMLElement {
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  return root
}

describe('interactive briefing', () => {
  it('starts on the session tour and advances beats', () => {
    const root = host()
    const app = mountBriefing(root)
    expect(root.querySelector('h2')?.textContent).toBe('Play a session')
    expect(root.querySelector('[data-beat]')?.getAttribute('data-beat')).toBe('0')
    const next = Array.from(root.querySelectorAll('button')).find((btn) => btn.textContent === 'Next beat')
    next?.click()
    expect(app.getState().beat).toBe(1)
    expect(root.querySelector('[data-beat]')?.getAttribute('data-beat')).toBe('1')
  })

  it('grades a tiny doodle as F using the live rubric', () => {
    const root = host()
    mountBriefing(root, { ...defaultBriefingState(), lab: 'grade' })
    const card = root.querySelector('[data-letter]') as HTMLElement
    expect(card.getAttribute('data-letter')).toBe('F')
    expect(card.textContent).toContain('Not ready to ground')
  })

  it('caps ice-desert-dualism at F even as a world exam', () => {
    const root = host()
    mountBriefing(root, {
      ...defaultBriefingState(),
      lab: 'grade',
      exam: 'world',
      selected: ['ice-desert-dualism'],
    })
    const card = root.querySelector('[data-letter]') as HTMLElement
    expect(card.getAttribute('data-letter')).toBe('F')
    expect(Number(card.getAttribute('data-score'))).toBeLessThanOrEqual(59)
    expect(card.textContent).toContain('Fails a non-negotiable check')
  })

  it('keeps not-a-planet-yet from being a geography F by itself', () => {
    const root = host()
    mountBriefing(root, {
      ...defaultBriefingState(),
      lab: 'grade',
      exam: 'sketch',
      selected: ['not-a-planet-yet'],
    })
    const card = root.querySelector('[data-letter]') as HTMLElement
    expect(card.getAttribute('data-letter')).toBe('A')
    expect(card.textContent).toContain('Ready to ground')
  })

  it('classifies alpine override in the biome mixer', () => {
    const root = host()
    mountBriefing(root, { ...defaultBriefingState(), lab: 'map', alpine: true })
    expect(root.querySelector('[data-biome]')?.getAttribute('data-biome')).toBe('alpine')
  })

  it('marks a quiz answer with live feedback', () => {
    const root = host()
    mountBriefing(root, { ...defaultBriefingState(), lab: 'quiz' })
    const firstGood = Array.from(root.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Press Make sense'),
    )
    firstGood?.click()
    expect(root.querySelector('.briefing-callout.ok')?.textContent).toContain('Correct')
    expect(root.querySelector('[data-quiz-score]')?.getAttribute('data-quiz-score')).toBe('1/1')
  })
})
