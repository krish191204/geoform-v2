/**
 * Earth landscape analogs from climate — place, not people.
 *
 * Writers get “this would feel like X because…” so they can name the
 * tradition themselves. Never assigns a real-world ethnicity to a cell.
 */

import type { PlaceAnalog, PlaceAnalogId, World } from '../world/types'
import { matchAnalogAt } from '../science/matchAnalog'

export const PLACE_ANALOGS: Record<PlaceAnalogId, PlaceAnalog> = {
  'mediterranean-coast': {
    id: 'mediterranean-coast',
    label: 'Mediterranean grain-and-olive coast',
    because: 'Warm dry summers, wetter winters, and a hilly shore.',
    tradition: 'Coastal farmers and sailors in a summer-dry climate.',
  },
  'monsoon-delta': {
    id: 'monsoon-delta',
    label: 'Monsoon river delta',
    because: 'Hot wet lowland on a big river.',
    tradition: 'Wet-field and river people of a humid lowland.',
  },
  'fog-desert-coast': {
    id: 'fog-desert-coast',
    label: 'Fog-desert west coast',
    because: 'Hot dry shore with little rain — like an Atacama or Namib coast.',
    tradition: 'Sparse shore people living off fog, fish, and rare rivers.',
  },
  'interior-steppe': {
    id: 'interior-steppe',
    label: 'Interior grassland',
    because: 'Open steppe far from the sea, with a real seasonal swing.',
    tradition: 'Herders of an inland grassland.',
  },
  'highland-plateau': {
    id: 'highland-plateau',
    label: 'High plateau',
    because: 'High land in the trades — thin air, short crops, long views.',
    tradition: 'Highland farmers and herders above the heat of the plains.',
  },
  'boreal-forest': {
    id: 'boreal-forest',
    label: 'Boreal forest',
    because: 'Cold woods, short summers, long dark winters.',
    tradition: 'Forest hunters and timber people of the cold belt.',
  },
  'tropical-forest': {
    id: 'tropical-forest',
    label: 'Tropical forest',
    because: 'Hot and wet all year, dense canopy.',
    tradition: 'Forest gardeners of a hot wet interior.',
  },
  'savanna-belt': {
    id: 'savanna-belt',
    label: 'Savanna belt',
    because: 'Hot land with a wet season and a dry season, not a desert.',
    tradition: 'Seasonal herders and grain growers of a wet-dry tropical belt.',
  },
  'tundra-edge': {
    id: 'tundra-edge',
    label: 'Tundra edge',
    because: 'Too cold for trees; the ground barely thaws.',
    tradition: 'Sparse cold-coast and tundra people.',
  },
  'oasis-corridor': {
    id: 'oasis-corridor',
    label: 'Desert oasis corridor',
    because: 'Dry land with a wet cell — a river, spring, or coastal fog pocket.',
    tradition: 'Caravan and oasis people stitching dry country together.',
  },
  'island-arc': {
    id: 'island-arc',
    label: 'Island arc',
    because: 'Small land in a lot of ocean.',
    tradition: 'Island sailors who live by the sea more than the soil.',
  },
  'temperate-farmland': {
    id: 'temperate-farmland',
    label: 'Temperate farmland',
    because: 'Mild woods and fields with enough rain to farm.',
    tradition: 'Mixed farmers of a mild forest climate.',
  },
}

export const TRADE_GOOD_LABEL: Record<
  import('../world/types').TradeGood,
  string
> = {
  grain: 'grain',
  livestock: 'livestock',
  fish: 'fish',
  timber: 'timber',
  metals: 'metals',
  caravan: 'caravan goods',
  forest: 'forest goods',
}

/**
 * Landscape analog at a land cell. Ocean returns null.
 * Copy lives here; the nearest Earth centroid is scored in science.
 */
export function analogAt(world: World, x: number, y: number): PlaceAnalog | null {
  const match = matchAnalogAt(world, x, y)
  if (!match) return null
  return PLACE_ANALOGS[match.id]
}

/** Majority analog in a set of cells; island-arc if the hinterland is tiny. */
export function analogForCells(
  world: World,
  cells: readonly { x: number; y: number }[],
  landCells: number,
): PlaceAnalog {
  const votes = new Map<PlaceAnalogId, number>()
  for (const c of cells) {
    const a = analogAt(world, c.x, c.y)
    if (!a) continue
    votes.set(a.id, (votes.get(a.id) ?? 0) + 1)
  }
  if (landCells > 0 && landCells < 80) return PLACE_ANALOGS['island-arc']
  let best: PlaceAnalog = PLACE_ANALOGS['temperate-farmland']
  let n = 0
  for (const [id, count] of votes) {
    if (count > n) {
      n = count
      best = PLACE_ANALOGS[id]
    }
  }
  return best
}
