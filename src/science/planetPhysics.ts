/**
 * Planet-scale physics for the planet card and the inspector.
 *
 * Geoform stores only radius and axial tilt, so everything else is Earth's:
 * bulk density 5514 kg/m³, sidereal day 86164 s, solar constant 1361 W/m²
 * (total solar irradiance at 1 AU), G = 6.674e-11 m³ kg⁻¹ s⁻².
 *
 * The orbit is a circle at 1 AU. Perihelion is ignored, so both hemispheres
 * get mirror-image seasons. Real Earth is ~3.3% dimmer than this at July
 * aphelion and ~3.4% brighter at January perihelion.
 *
 * Insolation is top-of-atmosphere on a horizontal surface — sunlight before
 * clouds and air take their share. Day lengths are geometric (sun's centre on
 * a flat horizon, no refraction), so real days run a few minutes longer.
 */

import type { World, WorldMeta } from '../world/types'

/** Newtonian constant of gravitation, m³ kg⁻¹ s⁻². */
export const G_NEWTON = 6.674e-11
/** Earth's mean bulk density, kg/m³. Geoform has no density field. */
export const EARTH_DENSITY_KG_M3 = 5514
/** Earth's mean radius, km. */
export const EARTH_RADIUS_KM = 6371
/** Earth's sidereal day, s. Geoform has no day-length field. */
export const SIDEREAL_DAY_S = 86164
/** Total solar irradiance at 1 AU, W/m². */
export const SOLAR_CONSTANT_WM2 = 1361
/** Days in one orbit. */
export const YEAR_DAYS = 365.25
/** Day of year of the March equinox on the circular orbit. */
export const MARCH_EQUINOX_DAY = 80
/** Day of year used for the June solstice. */
export const JUNE_SOLSTICE_DAY = 172
/** Day of year used for the December solstice. */
export const DECEMBER_SOLSTICE_DAY = 355
/** Conventional standard gravity, m/s² — Earth's felt pull, spin included. */
export const STANDARD_GRAVITY = 9.80665
/** Specific gas constant of dry air, J kg⁻¹ K⁻¹. */
export const R_DRY_AIR = 287
/** Mean sea-level pressure, hPa. Held at Earth's value on every planet. */
export const SEA_LEVEL_PRESSURE_HPA = 1013.25

/** Standard-atmosphere lapse rate, K per metre. */
const LAPSE_RATE_K_PER_M = 0.0065
/** One sample every five days. The integrand is smooth and periodic, so this is plenty. */
const ANNUAL_SAMPLES = 73
const DEG = Math.PI / 180
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g

// ---------------------------------------------------------------------------
// Bulk planet
// ---------------------------------------------------------------------------

/**
 * Surface gravity of a uniform sphere, m/s²: g = 4/3·π·G·ρ·R.
 * Earth → 9.82. That is the pure gravitational pull; spin trims the felt
 * value to 9.78 at the equator and ~9.81 at mid-latitudes.
 */
export function surfaceGravity(radiusKm: number, densityKgM3 = EARTH_DENSITY_KG_M3): number {
  return (4 / 3) * Math.PI * G_NEWTON * densityKgM3 * radiusKm * 1000
}

/** Escape velocity from the surface, km/s: √(2gR). Earth → 11.19. */
export function escapeVelocity(radiusKm: number, densityKgM3 = EARTH_DENSITY_KG_M3): number {
  return Math.sqrt(2 * surfaceGravity(radiusKm, densityKgM3) * radiusKm * 1000) / 1000
}

/** Distance to the geometric horizon, km: √(2Rh + h²). No refraction. Earth, 1.7 m eye → 4.65. */
export function horizonKm(radiusKm: number, eyeHeightM = 1.7): number {
  const r = radiusKm * 1000
  const h = Math.max(0, eyeHeightM)
  return Math.sqrt(2 * r * h + h * h) / 1000
}

/** Equatorial circumference, km. Earth → 40 030. */
export function circumferenceKm(radiusKm: number): number {
  return 2 * Math.PI * radiusKm
}

/** East–west width of one grid cell at the equator, km. Shrinks by cos(latitude) toward the poles. */
export function cellKm(radiusKm: number, width: number): number {
  return width > 0 ? circumferenceKm(radiusKm) / width : 0
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

/**
 * Solar declination, radians: sin δ = sin ε · sin(2π(d − 80)/yearDays).
 * Circular orbit: the sun moves along the ecliptic at a constant rate, so the
 * March equinox is day 80 and the two halves of the year are equal. On real
 * Earth the northern summer half is about a week longer.
 */
export function solarDeclinationRad(
  obliquityDeg: number,
  dayOfYear: number,
  yearDays = YEAR_DAYS,
): number {
  const lambda = (2 * Math.PI * (dayOfYear - MARCH_EQUINOX_DAY)) / yearDays
  return Math.asin(Math.sin(obliquityDeg * DEG) * Math.sin(lambda))
}

/**
 * Sunrise hour angle h0 ∈ [0, π] from cos h0 = −tan φ · tan δ.
 * Written as a ratio so the poles (cos φ → 0) clamp cleanly:
 * 0 is polar night, π is polar day.
 */
function sunriseHourAngle(latRad: number, declRad: number): number {
  const num = -Math.sin(latRad) * Math.sin(declRad)
  const den = Math.cos(latRad) * Math.cos(declRad)
  if (num >= den) return 0
  if (num <= -den) return Math.PI
  return Math.acos(num / den)
}

/**
 * Daily-mean top-of-atmosphere insolation, W/m²:
 * Q = S0/π · (h0 sin φ sin δ + cos φ cos δ sin h0).
 * Equator at equinox → S0/π = 433. Pole at the June solstice → S0·sin δ = 541
 * (real Earth gets ~524 there because June falls near aphelion).
 */
export function dailyMeanInsolation(
  latRad: number,
  declRad: number,
  S0 = SOLAR_CONSTANT_WM2,
): number {
  const h0 = sunriseHourAngle(latRad, declRad)
  const q =
    (S0 / Math.PI) *
    (h0 * Math.sin(latRad) * Math.sin(declRad) +
      Math.cos(latRad) * Math.cos(declRad) * Math.sin(h0))
  return Math.max(0, q)
}

/**
 * Annual-mean top-of-atmosphere insolation, W/m². Midpoint rule over one
 * orbit with 73 samples. At Earth's tilt: equator 415.5, poles 172.5.
 * The pole's mean is exactly S0·sin ε/π on a circular orbit.
 */
export function annualMeanInsolation(
  latRad: number,
  obliquityDeg: number,
  S0 = SOLAR_CONSTANT_WM2,
): number {
  let sum = 0
  for (let k = 0; k < ANNUAL_SAMPLES; k++) {
    const day = MARCH_EQUINOX_DAY + ((k + 0.5) * YEAR_DAYS) / ANNUAL_SAMPLES
    sum += dailyMeanInsolation(latRad, solarDeclinationRad(obliquityDeg, day), S0)
  }
  return sum / ANNUAL_SAMPLES
}

/** Hours from sunrise to sunset: 24·h0/π. 0 in polar night, 24 in polar day. */
export function dayLengthHours(latRad: number, declRad: number): number {
  return (24 * sunriseHourAngle(latRad, declRad)) / Math.PI
}

/** Latitude of the Arctic and Antarctic circles, degrees: 90 − ε. */
export function polarCircleDeg(obliquityDeg: number): number {
  return 90 - obliquityDeg
}

/** Latitude of the tropics, degrees: ε. */
export function tropicDeg(obliquityDeg: number): number {
  return obliquityDeg
}

// ---------------------------------------------------------------------------
// Spin and air
// ---------------------------------------------------------------------------

/** Coriolis parameter f = 2Ω sin φ, s⁻¹, with Ω = 2π / sidereal day. Earth at 45° → 1.03e-4. */
export function coriolisParameter(latRad: number, dayS = SIDEREAL_DAY_S): number {
  return ((4 * Math.PI) / dayS) * Math.sin(latRad)
}

/** Inertial-oscillation period 2π/|f|, hours. 11.97 h at Earth's poles; Infinity at the equator. */
export function inertialPeriodHours(latRad: number, dayS = SIDEREAL_DAY_S): number {
  const f = Math.abs(coriolisParameter(latRad, dayS))
  return f > 0 ? (2 * Math.PI) / f / 3600 : Infinity
}

/** Isothermal atmospheric scale height H = R_d·T/g, km. 15 °C on Earth → 8.43. */
export function scaleHeightKm(tempC: number, gravity = STANDARD_GRAVITY): number {
  return (R_DRY_AIR * (tempC + 273.15)) / gravity / 1000
}

/**
 * Air pressure at an elevation, hPa: 1013.25·exp(−z/H).
 * `tempC` is the mean temperature of the air between sea level and `elevM`.
 * Negative elevations (dry basins below sea level) read above 1013.
 */
export function pressureAtElevationHpa(
  elevM: number,
  tempC: number,
  gravity = STANDARD_GRAVITY,
): number {
  return SEA_LEVEL_PRESSURE_HPA * Math.exp(-elevM / 1000 / scaleHeightKm(tempC, gravity))
}

// ---------------------------------------------------------------------------
// Per cell and per planet
// ---------------------------------------------------------------------------

export interface CellPhysics {
  latDeg: number
  /** Daily-mean top-of-atmosphere sunlight on the June solstice, W/m². */
  insolationJune: number
  /** Daily-mean top-of-atmosphere sunlight on the December solstice, W/m². */
  insolationDecember: number
  /** Annual-mean top-of-atmosphere sunlight, W/m². */
  annualInsolation: number
  /** Hours of daylight on the June solstice. */
  dayLengthJune: number
  /** Hours of daylight on the December solstice. */
  dayLengthDecember: number
  /** Coriolis parameter, s⁻¹. Negative in the south. */
  coriolis: number
  /** Mean surface air pressure, hPa. */
  pressureHpa: number
}

/**
 * Sun, daylight, spin, and air for cell `i`. Reads `world`, never writes it.
 * Ocean cells read air pressure at the sea surface, not the seabed. Pressure
 * uses the mean temperature of the air column (the cell's annual mean plus
 * half the standard lapse over its climb) and felt gravity scaled with radius
 * at Earth's density.
 */
export function cellPhysics(world: World, i: number): CellPhysics {
  const { width, height, obliquityDeg, planetRadiusKm } = world.meta
  const y = Math.floor(i / width)
  const lat = height > 1 ? Math.PI / 2 - (Math.PI * y) / (height - 1) : 0
  const june = solarDeclinationRad(obliquityDeg, JUNE_SOLSTICE_DAY)
  const december = solarDeclinationRad(obliquityDeg, DECEMBER_SOLSTICE_DAY)
  const z = world.biome[i] === 'ocean' ? 0 : world.elev[i]
  const columnTempC = world.tempMean[i] + (LAPSE_RATE_K_PER_M * z) / 2
  const gravity = STANDARD_GRAVITY * (planetRadiusKm / EARTH_RADIUS_KM)
  return {
    latDeg: lat / DEG,
    insolationJune: dailyMeanInsolation(lat, june),
    insolationDecember: dailyMeanInsolation(lat, december),
    annualInsolation: annualMeanInsolation(lat, obliquityDeg),
    dayLengthJune: dayLengthHours(lat, june),
    dayLengthDecember: dayLengthHours(lat, december),
    coriolis: coriolisParameter(lat),
    pressureHpa: pressureAtElevationHpa(z, columnTempC, gravity),
  }
}

export interface PlanetCard {
  /** m/s² */
  gravity: number
  escapeKmS: number
  horizonKm: number
  circumferenceKm: number
  /** East–west width of one grid cell at the equator. */
  cellKm: number
  tropicDeg: number
  polarCircleDeg: number
  equatorAnnualWm2: number
  poleAnnualWm2: number
}

/** The bulk numbers for one planet, from radius, tilt, and grid width. */
export function planetCard(meta: WorldMeta): PlanetCard {
  const r = meta.planetRadiusKm
  const tilt = meta.obliquityDeg
  return {
    gravity: surfaceGravity(r),
    escapeKmS: escapeVelocity(r),
    horizonKm: horizonKm(r),
    circumferenceKm: circumferenceKm(r),
    cellKm: cellKm(r, meta.width),
    tropicDeg: tropicDeg(tilt),
    polarCircleDeg: polarCircleDeg(tilt),
    equatorAnnualWm2: annualMeanInsolation(0, tilt),
    poleAnnualWm2: annualMeanInsolation(Math.PI / 2, tilt),
  }
}

function wholeKm(n: number): string {
  return String(Math.round(n)).replace(THOUSANDS, ',')
}

/** Short lines a writer can read as facts. */
export function formatPlanetCard(card: PlanetCard): string[] {
  const earthGravity = surfaceGravity(EARTH_RADIUS_KM)
  const sunRatio = card.poleAnnualWm2 > 0 ? card.equatorAnnualWm2 / card.poleAnnualWm2 : Infinity
  return [
    `Gravity ${card.gravity.toFixed(2)} m/s² (${(card.gravity / earthGravity).toFixed(2)}× Earth)`,
    `Escape velocity ${card.escapeKmS.toFixed(1)} km/s`,
    `Horizon ${card.horizonKm.toFixed(1)} km away at eye level`,
    `Equator ${wholeKm(card.circumferenceKm)} km around; one map cell spans ${wholeKm(card.cellKm)} km there`,
    `Tropics at ${card.tropicDeg.toFixed(1)}°, polar circles at ${card.polarCircleDeg.toFixed(1)}°`,
    Number.isFinite(sunRatio)
      ? `Equator gets ${sunRatio.toFixed(1)}× the sunlight of the poles over a year`
      : 'With no tilt the polar sun only skims the horizon, so the poles get no warming sunlight',
  ]
}

function daylight(month: string, hours: number): string {
  if (hours >= 24) return `the ${month} sun never sets`
  if (hours <= 0) return `the ${month} sun never rises`
  return `the ${month} day lasts ${hours.toFixed(1)} h`
}

/** One inspector sentence: daylight at both solstices and air pressure. */
export function describeSky(c: CellPhysics): string {
  const lat = Math.round(Math.abs(c.latDeg))
  const hemisphere = lat === 0 ? '' : c.latDeg > 0 ? 'N' : 'S'
  return (
    `At ${lat}°${hemisphere} ${daylight('June', c.dayLengthJune)} and ` +
    `${daylight('December', c.dayLengthDecember)}; air pressure about ${Math.round(c.pressureHpa)} hPa.`
  )
}
