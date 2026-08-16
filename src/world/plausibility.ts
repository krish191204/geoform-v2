import type { World } from './types'

export interface HealthSummary {
  hasNaN: boolean
  hasLand: boolean
  hasAnyRivers: boolean
  meanTempRange: number
  meanFlux: number
  continentCount: number
}

export function worldHealth(world: World): HealthSummary {
  let hasNaN = false
  let hasLand = false
  let hasAnyRivers = false
  let totalRange = 0, rangeCount = 0
  let totalFlux = 0
  let landCount = 0
  for (let i = 0; i < world.elev.length; i++) {
    if (Number.isNaN(world.elev[i])) hasNaN = true
    if (world.mask[i] >= world.meta.threshold) {
      hasLand = true
      landCount++
      if (world.rivers[i] === 1) hasAnyRivers = true
      totalFlux += world.flux[i]
    }
    if (Number.isFinite(world.tempRange[i])) {
      totalRange += world.tempRange[i]
      rangeCount++
    }
  }
  return {
    hasNaN,
    hasLand,
    hasAnyRivers,
    meanTempRange: rangeCount > 0 ? totalRange / rangeCount : 0,
    meanFlux: landCount > 0 ? totalFlux / landCount : 0,
    continentCount: 0   // TODO: wire to bigComponentsMask if needed
  }
}