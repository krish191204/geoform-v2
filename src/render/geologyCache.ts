import type { World } from '../world/types'
import { readGeology, type GeologyReading } from '../sketch/geology'
import { readResources, type ResourceReading } from '../sketch/resources'

const geology = new WeakMap<World, GeologyReading>()
const resources = new WeakMap<World, ResourceReading>()

/** One geology read per grounded world. A new Make sense makes a new World. */
export function geologyFor(world: World): GeologyReading {
  let reading = geology.get(world)
  if (!reading) {
    reading = readGeology(world)
    geology.set(world, reading)
  }
  return reading
}

export function resourcesFor(world: World): ResourceReading {
  let reading = resources.get(world)
  if (!reading) {
    reading = readResources(world, geologyFor(world).lith)
    resources.set(world, reading)
  }
  return reading
}
