// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { ANALOG_STILL_CAPTION, analogStillDataUri } from './analogStills'
import { worldInspectHtml } from './ui'

describe('analog stills', () => {
  it('keeps the cousin caption and ships an SVG for each analog', () => {
    expect(ANALOG_STILL_CAPTION).toBe('Earth climate cousin, not this pixel.')
    const uri = analogStillDataUri('temperate-farmland')
    expect(uri.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('shows the still and caption on land hover', () => {
    const html = worldInspectHtml(
      {
        elev: '12 m',
        plateId: '3',
        tempSummer: '18°C',
        tempWinter: '4°C',
        tempRange: '14°C',
        moistSummer: '0.40 · 0–1',
        moistWinter: '0.32 · 0–1',
        biome: 'temperate-forest',
      },
      10,
      12,
      true,
      {
        analog: 'Temperate farmland',
        analogId: 'temperate-farmland',
        because: 'Mild summers, wet enough for grain.',
      },
      'biome',
    )
    expect(html).toContain(ANALOG_STILL_CAPTION)
    expect(html).toContain('data:image/svg+xml')
    expect(html).not.toContain('More about this cell')
    expect(html).toContain('Biome')
  })

  it('names the Earth cousin on a wonder cell', () => {
    const html = worldInspectHtml(
      {
        elev: '12 m',
        plateId: '3',
        tempSummer: '18°C',
        tempWinter: '4°C',
        tempRange: '14°C',
        moistSummer: '0.40 · 0–1',
        moistWinter: '0.32 · 0–1',
        biome: 'hot-desert',
      },
      10,
      12,
      true,
      {
        wonder: 'Corfen Pan. A hard white pan floors this closed basin.',
        wonderEarth: 'Salar de Uyuni, Bolivia',
      },
      'biome',
    )
    expect(html).toContain('On Earth this is Salar de Uyuni, Bolivia.')
  })
})
