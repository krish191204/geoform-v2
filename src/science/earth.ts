/**
 * Frozen Earth climatology used to score Geoform worlds.
 *
 * Not a GCM and not a live reanalysis pull. Zonal annual 2 m air
 * temperatures are textbook climatology (Hartmann / Peixoto–Oort
 * style, ~10° bands). Analog centroids are Earth landscape moments,
 * not ethnicities.
 *
 * Pipeline climate is unchanged. This module only *measures*.
 */

import type { PlaceAnalogId } from '../world/types'

/** Latitude (°N) → annual mean 2 m air temperature (°C). */
export const EARTH_ZONAL_T_C: readonly { lat: number; t: number }[] = [
  { lat: -90, t: -27 },
  { lat: -80, t: -18 },
  { lat: -70, t: -10 },
  { lat: -60, t: -2 },
  { lat: -50, t: 5 },
  { lat: -40, t: 12 },
  { lat: -30, t: 18 },
  { lat: -20, t: 23 },
  { lat: -10, t: 26 },
  { lat: 0, t: 26.7 },
  { lat: 10, t: 26.2 },
  { lat: 20, t: 24 },
  { lat: 30, t: 20 },
  { lat: 40, t: 13 },
  { lat: 50, t: 5 },
  { lat: 60, t: -1 },
  { lat: 70, t: -10 },
  { lat: 80, t: -16 },
  { lat: 90, t: -20 },
]

export interface ClimateFeatures {
  /** Annual mean °C. */
  meanT: number
  /** Summer − winter, °C. */
  tempRange: number
  /** Precipitation index 0..1. */
  moist: number
  /** 0 coast … 1 deep interior. */
  inland: number
  /** Elevation in kilometres. */
  elevKm: number
}

/**
 * Earth analog centroids in the same feature space.
 * Units match `ClimateFeatures`. Scale of each axis is in `FEATURE_SCALE`.
 */
export const EARTH_ANALOG_CENTROIDS: Record<PlaceAnalogId, ClimateFeatures> = {
  'mediterranean-coast': { meanT: 16, tempRange: 12, moist: 0.32, inland: 0.18, elevKm: 0.25 },
  'monsoon-delta': { meanT: 26, tempRange: 7, moist: 0.78, inland: 0.12, elevKm: 0.04 },
  'fog-desert-coast': { meanT: 18, tempRange: 8, moist: 0.08, inland: 0.06, elevKm: 0.15 },
  'interior-steppe': { meanT: 8, tempRange: 28, moist: 0.24, inland: 0.82, elevKm: 0.45 },
  'highland-plateau': { meanT: 7, tempRange: 16, moist: 0.28, inland: 0.55, elevKm: 3.4 },
  'boreal-forest': { meanT: 0, tempRange: 28, moist: 0.46, inland: 0.48, elevKm: 0.3 },
  'tropical-forest': { meanT: 25, tempRange: 4, moist: 0.82, inland: 0.4, elevKm: 0.25 },
  'savanna-belt': { meanT: 24, tempRange: 10, moist: 0.34, inland: 0.42, elevKm: 0.4 },
  'tundra-edge': { meanT: -8, tempRange: 24, moist: 0.32, inland: 0.35, elevKm: 0.2 },
  'oasis-corridor': { meanT: 22, tempRange: 18, moist: 0.14, inland: 0.7, elevKm: 0.35 },
  'island-arc': { meanT: 24, tempRange: 6, moist: 0.55, inland: 0.02, elevKm: 0.2 },
  'temperate-farmland': { meanT: 10, tempRange: 18, moist: 0.55, inland: 0.35, elevKm: 0.2 },
}

/** Feature scales so temperature °C and moisture 0–1 share a metric. */
export const FEATURE_SCALE: ClimateFeatures = {
  meanT: 12,
  tempRange: 14,
  moist: 0.28,
  inland: 0.4,
  elevKm: 1.6,
}

/** Interpolate Earth's zonal T at a latitude in degrees. */
export function earthZonalT(latDeg: number): number {
  const lat = Math.max(-90, Math.min(90, latDeg))
  const rows = EARTH_ZONAL_T_C
  for (let i = 1; i < rows.length; i++) {
    if (lat > rows[i].lat) continue
    const a = rows[i - 1]
    const b = rows[i]
    const t = (lat - a.lat) / Math.max(1e-6, b.lat - a.lat)
    return a.t + (b.t - a.t) * t
  }
  return rows[rows.length - 1].t
}

export function scaledDistance(a: ClimateFeatures, b: ClimateFeatures): number {
  const s = FEATURE_SCALE
  const dt = (a.meanT - b.meanT) / s.meanT
  const dr = (a.tempRange - b.tempRange) / s.tempRange
  const dm = (a.moist - b.moist) / s.moist
  const di = (a.inland - b.inland) / s.inland
  const de = (a.elevKm - b.elevKm) / s.elevKm
  return Math.sqrt(dt * dt + dr * dr + dm * dm + di * di + de * de)
}
