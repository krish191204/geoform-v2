/**
 * Memoised wonders per World. `findWonders` is a pure whole-grid scan;
 * the shell and the worldbuild panel both read the same list, so compute
 * it once per derived world and let the WeakMap release it with the world.
 */
import { findWonders, type Wonder } from '../sketch/wonders'
import type { World } from '../world/types'

const cache = new WeakMap<World, readonly Wonder[]>()

export function wondersFor(world: World): readonly Wonder[] {
  // Partial worlds (UI test fixtures, mid-hydration saves) scan nothing.
  if (!world?.meta || !world.elev || !world.biome) return []
  let hit = cache.get(world)
  if (!hit) {
    hit = findWonders(world)
    cache.set(world, hit)
  }
  return hit
}
