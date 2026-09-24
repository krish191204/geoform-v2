/**
 * Writer-facing kingdom notes. The sigil and the suggestion are read
 * off the grounded cell at the capital. They do not change climate,
 * borders, or the mask.
 */

import type { Polity, World } from '../world/types'
import { idx } from '../world/types'

export const SIGIL_CHARGES = ['Wave', 'Peak', 'Sheaf', 'Net', 'Pine', 'Salt'] as const
export type SigilCharge = (typeof SIGIL_CHARGES)[number]

const SIGIL_PATH: Record<SigilCharge, string> = {
  Wave: 'M6 22c4-8 8-8 12 0s8 8 12 0',
  Peak: 'M8 26 L18 8 L28 26 Z',
  Sheaf: 'M18 28 V8 M12 16c4-6 8-6 12 0 M12 22c4-6 8-6 12 0',
  Net: 'M10 10h16v16H10z M10 18h16 M18 10v16',
  Pine: 'M18 28 V16 M10 18 L18 8 L26 18',
  Salt: 'M10 18h16 M18 10v16',
}

export function sigilMark(charge: string): string {
  const key = (SIGIL_CHARGES as readonly string[]).includes(charge) ? (charge as SigilCharge) : 'Salt'
  const d = SIGIL_PATH[key]
  return `<svg class="sigil" viewBox="0 0 36 36" aria-hidden="true"><rect width="36" height="36" rx="2" fill="none" stroke="currentColor"/><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`
}

/** Charge implied by the capital, not by a writer note. */
export function chargeFor(world: World, polity: Polity): SigilCharge {
  if (!world.meta || !world.elev || !world.mask) return 'Salt'
  const { width: w, height: h, threshold } = world.meta
  const x = polity.capitalX
  const y = polity.capitalY
  const elev = world.elev[idx(w, x, y)] ?? 0
  if (elev > 1200) return 'Peak'
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = (x + dx + w) % w
    const ny = y + dy
    if (ny < 0 || ny >= h || world.mask[idx(w, nx, ny)] < threshold) {
      return polity.exports.includes('fish') ? 'Net' : 'Wave'
    }
  }
  if (polity.exports.includes('grain') || polity.exports.includes('livestock')) return 'Sheaf'
  if (polity.exports.includes('timber')) return 'Pine'
  return 'Salt'
}

export interface KingdomSuggestion {
  charge: SigilCharge
  /** One sentence the writer can keep or replace. */
  history: string
  /** Why that sentence is the realistic one. */
  hint: string
}

const SITE_WORD = ['', 'a salt mirror', 'a hot spring', 'travertine steps', 'hoodoos', 'a slot canyon'] as const

/** Surfaces the age pass marked inside this country's cells. Empty when none. */
export function groundInRealm(world: World, polityId: number): string[] {
  const sites = world.sites
  const hold = world.polityId
  if (!sites || !hold || sites.length !== hold.length) return []
  const seen = new Set<number>()
  for (let i = 0; i < sites.length; i++) {
    if (hold[i] === polityId && sites[i] > 0) seen.add(sites[i])
  }
  const words: string[] = []
  for (const code of [1, 2, 3, 4, 5]) {
    if (seen.has(code)) words.push(SITE_WORD[code])
  }
  return words
}

export function suggestKingdom(world: World, polity: Polity, origin: string | null): KingdomSuggestion {
  const charge = chargeFor(world, polity)
  const land = polity.analog.label
  const because = polity.analog.because
  const sells = polity.exports[0] ?? 'little surplus'
  const ground = groundInRealm(world, polity.id)
  const aged = ground.length ? ` The border already holds ${ground.join(', ')}.` : ''
  const history =
    (origin && origin.length > 0
      ? origin
      : `${polity.name} holds ${land.toLowerCase()} country. The seat lives by ${sells}.`) + aged
  const hint = `${because} A ${charge.toLowerCase()} sigil matches that land.${aged} The note should not invent a climate the cell does not have.`
  return { charge, history, hint }
}
