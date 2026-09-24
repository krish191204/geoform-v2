import { describe, expect, it } from 'vitest'
import { groundInRealm, suggestKingdom } from './kingdomLore'
import type { Polity, World } from '../world/types'

function polity(): Polity {
  return {
    id: 0,
    name: 'Nesdale',
    capitalX: 2,
    capitalY: 2,
    analog: {
      id: 'mediterranean-coast',
      label: 'Summer-dry coast',
      because: 'The wet season is winter.',
      tradition: 'The shore folk',
    },
    tradition: 'The shore folk',
    exports: ['grain'],
    imports: ['timber'],
    meltingPot: 0,
    mass: 1,
  }
}

describe('kingdom lore', () => {
  it('cites a salt mirror only when that country holds the cell', () => {
    const world = {
      meta: { width: 4, height: 4, threshold: 0.5 },
      mask: new Float32Array(16).fill(1),
      elev: new Float32Array(16).fill(80),
      sites: new Uint8Array(16),
      polityId: new Int16Array(16).fill(-1),
    } as World
    world.sites![0] = 1
    world.polityId[0] = 0
    world.sites![5] = 2
    world.polityId[5] = 1
    expect(groundInRealm(world, 0)).toEqual(['a salt mirror'])
    expect(groundInRealm(world, 1)).toEqual(['a hot spring'])
    const line = suggestKingdom(world, polity(), null)
    expect(line.history).toContain('a salt mirror')
    expect(line.history).not.toContain('hot spring')
    expect(line.charge).toBe('Sheaf')
  })
})
