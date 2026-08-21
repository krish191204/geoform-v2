/**
 * Score a derived world's zonal temperature against Earth.
 *
 * Does not rewrite climate. RMSE and r² say how Earth-like the
 * latitude curve is — a calibration diagnostic, not a grade.
 */

import type { World } from '../world/types'
import { earthZonalT } from './earth'

export interface ZonalBand {
  /** Band centre, degrees north. */
  lat: number
  planetC: number
  earthC: number
}

export interface ClimateFit {
  /** RMSE of land+ocean zonal mean T vs Earth, °C. */
  rmseC: number
  /** Pearson r² of the 18 bands. 0 if degenerate. */
  r2: number
  bands: ZonalBand[]
  note: string
}

function latDeg(y: number, height: number): number {
  if (height <= 1) return 0
  return 90 - (180 * y) / (height - 1)
}

/**
 * 10° latitude bins of annual mean temperature vs Earth's zonal profile.
 */
export function fitZonalClimate(world: World): ClimateFit {
  const { width: w, height: h, threshold } = world.meta
  const bins = 18
  const sum = new Float64Array(bins)
  const n = new Int32Array(bins)
  for (let y = 0; y < h; y++) {
    const lat = latDeg(y, h)
    const b = Math.min(bins - 1, Math.max(0, Math.floor((lat + 90) / 10)))
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const t = world.tempMean[i]
      if (!Number.isFinite(t)) continue
      if (world.mask[i] < threshold && world.mask[i] < 0) continue
      sum[b] += t
      n[b]++
    }
  }
  const bands: ZonalBand[] = []
  for (let b = 0; b < bins; b++) {
    if (n[b] < 4) continue
    const lat = -85 + b * 10
    bands.push({ lat, planetC: sum[b] / n[b], earthC: earthZonalT(lat) })
  }
  let sse = 0
  let meanP = 0
  for (const band of bands) meanP += band.planetC
  meanP /= Math.max(1, bands.length)
  let sst = 0
  for (const band of bands) {
    const e = band.planetC - band.earthC
    sse += e * e
    const d = band.planetC - meanP
    sst += d * d
  }
  const rmseC = bands.length ? Math.sqrt(sse / bands.length) : 99
  const r2 = sst > 1e-6 ? Math.max(0, Math.min(1, 1 - sse / sst)) : 0
  const note =
    rmseC < 5
      ? "Zonal temperature is close to Earth's published profile."
      : rmseC < 10
        ? "Zonal temperature is in Earth's neighbourhood, with a real residual."
        : 'Zonal temperature is not Earth-like. That is allowed — this is not Earth.'
  return { rmseC, r2, bands, note }
}
