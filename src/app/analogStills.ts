/**
 * Original SVG stills keyed to landscape analogs — not scraped photos.
 * Caption in the inspector must stay: Earth climate cousin, not this pixel.
 *
 * v2: layered scenes instead of colour bands — sky gradient with haze, a far
 * ridgeline, a near ridgeline, a ground band, and one signature feature per
 * analog (dunes, canopy, water, ice). Everything is deterministic per analog
 * id, tiny (one data-URI, ~1–2 KB), and allocation-free at runtime beyond the
 * string itself.
 */

import type { PlaceAnalogId } from '../world/types'

export const ANALOG_STILL_CAPTION = 'Earth climate cousin, not this pixel.'

type Feature = 'trees' | 'palms' | 'dunes' | 'water' | 'ice' | 'fields' | 'mesa' | 'reeds'

interface Scene {
  skyTop: string
  skyLow: string
  /** Distant ridge (atmospheric, light). */
  far: string
  /** Near ridge (darker). */
  near: string
  ground: string
  feature: Feature
  featureColor: string
  /** 0 soft rolling horizon … 1 jagged peaks. */
  jag: number
  /** Optional low haze band strength 0..1. */
  haze: number
}

const SCENES: Record<PlaceAnalogId, Scene> = {
  'mediterranean-coast': {
    skyTop: '#a8c6dc', skyLow: '#e8dfc2', far: '#9fae96', near: '#6a8f5a',
    ground: '#c4b07a', feature: 'water', featureColor: '#3d7a96', jag: 0.35, haze: 0.25,
  },
  'monsoon-delta': {
    skyTop: '#8fb6c8', skyLow: '#d8dcc0', far: '#7fa87a', near: '#4a7a52',
    ground: '#6a9a62', feature: 'reeds', featureColor: '#3d6e8c', jag: 0.1, haze: 0.55,
  },
  'fog-desert-coast': {
    skyTop: '#c8c8c2', skyLow: '#e2ddd0', far: '#b2a88e', near: '#8a7a62',
    ground: '#c4a574', feature: 'water', featureColor: '#7a94a0', jag: 0.3, haze: 0.8,
  },
  'interior-steppe': {
    skyTop: '#b8cede', skyLow: '#e6e2c8', far: '#a8ac86', near: '#8a9a5a',
    ground: '#b8a86a', feature: 'fields', featureColor: '#9a8f56', jag: 0.15, haze: 0.15,
  },
  'highland-plateau': {
    skyTop: '#93b2cc', skyLow: '#d5d3c6', far: '#8d8474', near: '#6e6258',
    ground: '#9a8a72', feature: 'mesa', featureColor: '#7d6e5c', jag: 0.75, haze: 0.2,
  },
  'boreal-forest': {
    skyTop: '#9db6be', skyLow: '#d2d8d2', far: '#5e7a68', near: '#2e4636',
    ground: '#4a6a52', feature: 'trees', featureColor: '#243c2c', jag: 0.45, haze: 0.35,
  },
  'tropical-forest': {
    skyTop: '#7cb0a2', skyLow: '#d8e2c2', far: '#3d7a55', near: '#1e4a30',
    ground: '#2f6b45', feature: 'trees', featureColor: '#173a24', jag: 0.25, haze: 0.5,
  },
  'savanna-belt': {
    skyTop: '#d8c89a', skyLow: '#ecd9a8', far: '#b09a5c', near: '#6a8a40',
    ground: '#c4a050', feature: 'palms', featureColor: '#55702f', jag: 0.1, haze: 0.2,
  },
  'tundra-edge': {
    skyTop: '#b8c8d4', skyLow: '#e2e2da', far: '#a8b2b8', near: '#8a9aa4',
    ground: '#c8c4bc', feature: 'ice', featureColor: '#e8ecec', jag: 0.4, haze: 0.3,
  },
  'oasis-corridor': {
    skyTop: '#d8c8a0', skyLow: '#f0e0b8', far: '#c0a468', near: '#8a7448',
    ground: '#c4a060', feature: 'dunes', featureColor: '#3d7a5a', jag: 0.1, haze: 0.25,
  },
  'island-arc': {
    skyTop: '#6ca4c4', skyLow: '#c8e0e0', far: '#4a8a7a', near: '#3d7a6a',
    ground: '#f0e6c8', feature: 'water', featureColor: '#2d6a8c', jag: 0.85, haze: 0.3,
  },
  'temperate-farmland': {
    skyTop: '#a8c4d8', skyLow: '#e2e0c8', far: '#8aa476', near: '#5c8248',
    ground: '#7a9a5a', feature: 'fields', featureColor: '#c4b070', jag: 0.2, haze: 0.2,
  },
}

/** Deterministic 0..1 hash so ridgelines differ per analog but never per render. */
function h01(seedStr: string, n: number): number {
  let acc = 2166136261
  for (let i = 0; i < seedStr.length; i++) acc = Math.imul(acc ^ seedStr.charCodeAt(i), 16777619)
  acc = Math.imul(acc ^ n, 2654435761)
  return ((acc >>> 9) & 0xfffff) / 0xfffff
}

/** A wandering ridgeline path across the 160px frame at base height `y0`. */
function ridgePath(id: string, y0: number, amp: number, jag: number, layer: number): string {
  const pts: string[] = [`M0 ${y0.toFixed(1)}`]
  const step = jag > 0.5 ? 16 : 26
  for (let x = step; x <= 160; x += step) {
    const r = h01(id, x * 7 + layer * 131)
    const peak = y0 - amp * (0.25 + r * 0.75)
    const mid = x - step / 2
    if (jag > 0.5) {
      pts.push(`L${mid} ${peak.toFixed(1)} L${x} ${(y0 - amp * 0.15 * h01(id, x + layer)).toFixed(1)}`)
    } else {
      pts.push(`Q${mid} ${peak.toFixed(1)} ${x} ${(y0 - amp * 0.3 * h01(id, x + layer)).toFixed(1)}`)
    }
  }
  return `${pts.join(' ')} L160 72 L0 72 Z`
}

function featureMarkup(id: string, s: Scene): string {
  const c = s.featureColor
  switch (s.feature) {
    case 'water':
      return `<rect y="56" width="160" height="16" fill="${c}"/>
<path d="M0 58 Q40 56.6 80 58 T160 57.4" stroke="#e8f0f0" stroke-width="0.7" fill="none" opacity="0.5"/>
<path d="M0 63 Q50 61.8 100 63 T160 62.4" stroke="#dce8ea" stroke-width="0.5" fill="none" opacity="0.35"/>`
    case 'trees': {
      let t = ''
      for (let i = 0; i < 9; i++) {
        const x = 8 + i * 17 + h01(id, i) * 8
        const hgt = 7 + h01(id, i + 50) * 6
        t += `<path d="M${x.toFixed(1)} ${58 - hgt} L${(x - 3).toFixed(1)} 58 L${(x + 3).toFixed(1)} 58 Z" fill="${c}"/>`
      }
      return t
    }
    case 'palms': {
      let t = ''
      for (let i = 0; i < 3; i++) {
        const x = 24 + i * 52 + h01(id, i) * 14
        t += `<line x1="${x}" y1="58" x2="${x}" y2="47" stroke="${c}" stroke-width="1.2"/>
<path d="M${x} 47 q-7 -4 -11 -1 M${x} 47 q7 -4 11 -1 M${x} 47 q-4 -6 -8 -6 M${x} 47 q4 -6 8 -6" stroke="${c}" stroke-width="1" fill="none"/>`
      }
      return t
    }
    case 'dunes':
      return `<path d="M0 60 Q30 52 62 60 T124 59 T160 60 V72 H0 Z" fill="${s.ground}" opacity="0.85"/>
<path d="M20 60 Q40 55 62 60" stroke="#8a6f42" stroke-width="0.6" fill="none" opacity="0.5"/>
<ellipse cx="118" cy="60" rx="14" ry="3.5" fill="${c}" opacity="0.9"/>`
    case 'ice':
      return `<path d="M0 58 L22 52 L38 58 L60 50 L84 58 L110 53 L134 58 L160 54 V72 H0 Z" fill="${c}" opacity="0.9"/>`
    case 'fields': {
      let t = ''
      for (let i = 0; i < 5; i++) {
        const y = 58 + i * 2.8
        t += `<path d="M0 ${y} Q80 ${y - 1.6} 160 ${y}" stroke="${c}" stroke-width="0.8" fill="none" opacity="${0.5 - i * 0.07}"/>`
      }
      return t
    }
    case 'mesa':
      return `<path d="M96 58 V44 H128 V58 Z" fill="${c}"/><path d="M96 44 H128 L124 40 H100 Z" fill="${c}" opacity="0.7"/>
<path d="M30 58 V49 H48 V58 Z" fill="${c}" opacity="0.8"/>`
    case 'reeds': {
      let t = `<rect y="57" width="160" height="15" fill="${c}" opacity="0.85"/>`
      for (let i = 0; i < 12; i++) {
        const x = 4 + i * 13 + h01(id, i) * 6
        t += `<line x1="${x.toFixed(1)}" y1="60" x2="${(x + 1.5).toFixed(1)}" y2="51" stroke="#4a6a3a" stroke-width="0.7"/>`
      }
      return t
    }
  }
}

export function analogStillDataUri(id: PlaceAnalogId): string {
  const s = SCENES[id]
  const haze = s.haze > 0
    ? `<rect y="30" width="160" height="16" fill="${s.skyLow}" opacity="${(s.haze * 0.6).toFixed(2)}"/>`
    : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 72" width="160" height="72">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${s.skyTop}"/><stop offset="1" stop-color="${s.skyLow}"/>
</linearGradient></defs>
<rect width="160" height="72" fill="url(#sky)"/>
<circle cx="126" cy="16" r="6" fill="#f4ecd8" opacity="0.85"/>
<path d="${ridgePath(id, 44, 16, s.jag, 1)}" fill="${s.far}" opacity="0.75"/>
${haze}
<path d="${ridgePath(id, 52, 13, s.jag, 2)}" fill="${s.near}"/>
<rect y="56" width="160" height="16" fill="${s.ground}"/>
${featureMarkup(id, s)}
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
