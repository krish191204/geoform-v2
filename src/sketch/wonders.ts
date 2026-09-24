/**
 * Natural wonders on a derived World.
 *
 * Runs after Make sense, downstream-only like polities: pure functions over
 * `World`, no mutation, no app imports. Scans relief, climate, and hydrology
 * for the alien-looking-but-real places writers love — salt pans, fjord
 * coasts, great deltas — and explains the mechanism that made each one.
 */

import type { CellBiome, World } from '../world/types'
import { hash2 } from '../world/types'

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type WonderKind =
  | 'salt-flat'
  | 'fjord-coast'
  | 'great-delta'
  | 'painted-mesa'
  | 'monsoon-coast'
  | 'glacier-field'
  | 'mangrove-labyrinth'
  | 'dune-sea'
  | 'rift-gorge'
  | 'stone-forest'
  | 'hot-spring'
  | 'travertine'
  | 'hoodoo'
  | 'slot-canyon'

export interface Wonder {
  /** Stable id: `${kind}-${rank within kind}`. */
  id: string
  kind: WonderKind
  /** Evocative name, deterministic from world seed + location. */
  name: string
  x: number
  y: number
  /** What it looks like and the mechanism that formed it. */
  blurb: string
  /** One honest line about how it could change down the line. */
  futures: string
  /** A real Earth place that formed the same way, at a similar latitude. */
  earthCousin: string
  /** One local measurement for the grouped gazetteer row (height, temperature). */
  fact: string
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Hard cap on the returned list. */
export const MAX_WONDERS = 8
/** At most this many wonders of one kind. */
export const MAX_PER_KIND = 2
/** Two same-kind wonders must sit at least this far apart (cells, wrapped). */
export const MIN_KIND_SPACING = 12

const KINDS: readonly WonderKind[] = [
  'salt-flat',
  'fjord-coast',
  'great-delta',
  'painted-mesa',
  'monsoon-coast',
  'glacier-field',
  'mangrove-labyrinth',
  'dune-sea',
  'rift-gorge',
  'stone-forest',
  'hot-spring',
  'travertine',
  'hoodoo',
  'slot-canyon',
]

const K_SALT = 0
const K_FJORD = 1
const K_DELTA = 2
const K_MESA = 3
const K_MONSOON = 4
const K_GLACIER = 5
const K_MANGROVE = 6
const K_DUNE = 7
const K_RIFT = 8
const K_STONE = 9
const K_SPRING = 10
const K_TERRACE = 11
const K_HOODOO = 12
const K_SLOT = 13

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

function wrapX(x: number, w: number): number {
  return ((x % w) + w) % w
}

/** Euclidean cell distance with horizontal wrap. */
function wrapDist(ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = Math.min(Math.abs(ax - bx), w - Math.abs(ax - bx))
  return Math.hypot(dx, ay - by)
}

const N4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** BFS distance to the nearest ocean cell; 0 on ocean, 1e5 on sealess worlds. */
function coastDistField(world: World): Float32Array {
  const { width: w, height: h, threshold } = world.meta
  const n = w * h
  const dist = new Float32Array(n).fill(1e5)
  const q = new Int32Array(n)
  let tail = 0
  for (let i = 0; i < n; i++) {
    if (world.mask[i] >= threshold) continue
    dist[i] = 0
    q[tail++] = i
  }
  let head = 0
  while (head < tail) {
    const i = q[head++]
    const x = i % w
    const y = (i - x) / w
    const d = dist[i] + 1
    for (const [dx, dy] of N4) {
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      const ni = ny * w + wrapX(x + dx, w)
      if (d >= dist[ni]) continue
      dist[ni] = d
      q[tail++] = ni
    }
  }
  return dist
}

function seaAdjacent(world: World, x: number, y: number): boolean {
  const { width: w, height: h, threshold } = world.meta
  for (const [dx, dy] of N4) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    if (world.mask[ny * w + wrapX(x + dx, w)] < threshold) return true
  }
  return false
}

/**
 * How far this cell sits below the mean land elevation of its radius-4
 * neighbourhood. Returns -1 when the window is mostly ocean — a coastal
 * low is not an endorheic basin.
 */
function basinDepth(world: World, x: number, y: number): number {
  const { width: w, height: h, threshold } = world.meta
  let sum = 0
  let landN = 0
  let total = 0
  for (let dy = -4; dy <= 4; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -4; dx <= 4; dx++) {
      const i = ny * w + wrapX(x + dx, w)
      total++
      if (world.mask[i] < threshold) continue
      landN++
      sum += world.elev[i]
    }
  }
  if (!total || landN / total < 0.6) return -1
  return sum / landN - world.elev[y * w + x]
}

/** Max minus min land elevation within Chebyshev radius `r`. */
function landRelief(world: World, x: number, y: number, r: number): number {
  const { width: w, height: h, threshold } = world.meta
  let lo = Infinity
  let hi = -Infinity
  let landN = 0
  for (let dy = -r; dy <= r; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -r; dx <= r; dx++) {
      const i = ny * w + wrapX(x + dx, w)
      if (world.mask[i] < threshold) continue
      landN++
      const e = world.elev[i]
      if (e < lo) lo = e
      if (e > hi) hi = e
    }
  }
  return landN < 3 ? 0 : hi - lo
}

/** Standard deviation of land elevation within Chebyshev radius `r`. */
function landElevStd(world: World, x: number, y: number, r: number): number {
  const { width: w, height: h, threshold } = world.meta
  let sum = 0
  let sq = 0
  let landN = 0
  for (let dy = -r; dy <= r; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -r; dx <= r; dx++) {
      const i = ny * w + wrapX(x + dx, w)
      if (world.mask[i] < threshold) continue
      landN++
      const e = world.elev[i]
      sum += e
      sq += e * e
    }
  }
  if (landN < 4) return 0
  const mean = sum / landN
  return Math.sqrt(Math.max(0, sq / landN - mean * mean))
}

/** Fraction of the radius-2 window whose biome is in `wanted`. */
function biomeClusterFrac(
  world: World,
  x: number,
  y: number,
  wanted: readonly CellBiome[],
): number {
  const { width: w, height: h } = world.meta
  let hit = 0
  let total = 0
  for (let dy = -2; dy <= 2; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -2; dx <= 2; dx++) {
      total++
      if (wanted.includes(world.biome[ny * w + wrapX(x + dx, w)])) hit++
    }
  }
  return total ? hit / total : 0
}

/** Fraction of the radius-4 window that is hot desert. */
function hotDesertFrac(world: World, x: number, y: number): number {
  const { width: w, height: h } = world.meta
  let hit = 0
  let total = 0
  for (let dy = -4; dy <= 4; dy++) {
    const ny = y + dy
    if (ny < 0 || ny >= h) continue
    for (let dx = -4; dx <= 4; dx++) {
      total++
      if (world.biome[ny * w + wrapX(x + dx, w)] === 'hot-desert') hit++
    }
  }
  return total ? hit / total : 0
}

/**
 * Gorge wall height: for each opposite pair of cells two steps out, take the
 * lower of the two rims minus the floor; return the best pair. -1 if no pair
 * of land walls exists.
 */
function gorgeWall(world: World, x: number, y: number): number {
  const { width: w, height: h, threshold } = world.meta
  const floor = world.elev[y * w + x]
  const pairs: readonly [number, number][] = [
    [2, 0],
    [0, 2],
    [2, 2],
    [2, -2],
  ]
  let best = -1
  for (const [dx, dy] of pairs) {
    const ay = y + dy
    const by = y - dy
    if (ay < 0 || ay >= h || by < 0 || by >= h) continue
    const a = ay * w + wrapX(x + dx, w)
    const b = by * w + wrapX(x - dx, w)
    if (world.mask[a] < threshold || world.mask[b] < threshold) continue
    const wall = Math.min(world.elev[a], world.elev[b]) - floor
    if (wall > best) best = wall
  }
  return best
}

/**
 * Which side (if any) holds a range at least 900 m above this cell within
 * 3..10 cells along the row — the rain-shadow culprit for a desert basin.
 */
function rainShadowSide(world: World, x: number, y: number): 'western' | 'eastern' | null {
  const { width: w } = world.meta
  const here = world.elev[y * w + x]
  let west = -Infinity
  let east = -Infinity
  for (let d = 3; d <= 10; d++) {
    const ew = world.elev[y * w + wrapX(x - d, w)]
    const ee = world.elev[y * w + wrapX(x + d, w)]
    if (ew > west) west = ew
    if (ee > east) east = ee
  }
  const bar = here + 900
  if (west < bar && east < bar) return null
  return west >= east ? 'western' : 'eastern'
}

/** Latitude in degrees, +N, from grid row (row 0 is the north pole). */
function latDeg(y: number, h: number): number {
  return 90 - ((y + 0.5) / h) * 180
}

/** Named latitude band for a row, from grid geometry. */
function latBand(y: number, h: number): string {
  const lat = Math.abs(latDeg(y, h))
  if (lat < 23.5) return 'tropical'
  if (lat < 35) return 'subtropical'
  if (lat < 55) return 'mid-latitude'
  if (lat < 66.5) return 'subpolar'
  return 'polar'
}

/**
 * Real Earth place that formed the same way. Hemisphere and latitude pick
 * between two honest cousins so a Patagonian fjord is not sold as Norway.
 */
export function earthCousinFor(kind: WonderKind, y: number, height: number): string {
  const lat = latDeg(y, height)
  const south = lat < 0
  const abs = Math.abs(lat)
  switch (kind) {
    case 'salt-flat':
      if (south) return 'Salar de Uyuni, Bolivia'
      if (abs < 20) return 'Danakil Depression, Ethiopia'
      return 'Bonneville Salt Flats, Utah'
    case 'fjord-coast':
      return south ? 'Milford Sound, New Zealand' : 'Geirangerfjord, Norway'
    case 'great-delta':
      if (abs < 30) return 'Ganges–Brahmaputra Delta, Bangladesh'
      return south ? 'Paraná Delta, Argentina' : 'Mississippi Delta, Louisiana'
    case 'painted-mesa':
      return south ? 'Valle de la Luna, Atacama, Chile' : 'Painted Desert, Arizona'
    case 'monsoon-coast':
      return south ? 'Kimberley Coast, Australia' : 'Malabar Coast, India'
    case 'glacier-field':
      if (south) return 'Southern Patagonian Ice Field, Chile'
      if (abs > 60) return 'Greenland Ice Sheet'
      return 'Vatnajökull, Iceland'
    case 'mangrove-labyrinth':
      return south ? 'Rufiji Delta, Tanzania' : 'Sundarbans, Bangladesh'
    case 'dune-sea':
      return south ? 'Namib Sand Sea, Namibia' : 'Rubʿ al-Khali, Arabian Peninsula'
    case 'rift-gorge':
      if (abs < 20) return 'Main Ethiopian Rift'
      return south ? 'Fish River Canyon, Namibia' : 'Grand Canyon, Arizona'
    case 'stone-forest':
      return south ? 'Tsingy de Bemaraha, Madagascar' : 'Shilin Stone Forest, Yunnan'
    case 'hot-spring':
      return south ? 'Rotorua, New Zealand' : 'Grand Prismatic Spring, Wyoming'
    case 'travertine':
      return south ? 'Wai-O-Tapu sinter, New Zealand' : 'Pamukkale, Turkey'
    case 'hoodoo':
      return south ? 'Putangirua Pinnacles, New Zealand' : 'Cappadocia, Turkey'
    case 'slot-canyon':
      return south ? 'Chambers Gorge, South Australia' : 'Antelope Canyon, Arizona'
  }
}

/** Shore adjective from mean temperature — never "cold subtropical" when mean is −11°C. */
function shoreFeel(tempC: number): string {
  if (tempC < -10) return 'frigid'
  if (tempC < 0) return 'cold'
  if (tempC < 10) return 'cool'
  if (tempC < 18) return 'mild'
  return 'warm'
}

// ---------------------------------------------------------------------------
// Naming — same syllable flavour as the city namer in worldbuild.ts
// ---------------------------------------------------------------------------

const PREFIX: readonly string[] = [
  'Bel',
  'Cor',
  'Dra',
  'Fen',
  'Gar',
  'Hal',
  'Ith',
  'Kal',
  'Lor',
  'Mor',
  'Oth',
  'Quen',
  'Tor',
  'Ul',
  'Var',
  'Zar',
]

const SUFFIX: readonly string[] = [
  'mont',
  'heim',
  'gard',
  'fen',
  'mar',
  'dale',
  'crest',
  'fell',
  'run',
  'reach',
  'brook',
  'fast',
]

const KIND_EPITHET: Readonly<Record<WonderKind, string>> = {
  'salt-flat': 'Pan',
  'fjord-coast': 'Fjords',
  'great-delta': 'Delta',
  'painted-mesa': 'Badlands',
  'monsoon-coast': 'Coast',
  'glacier-field': 'Icefield',
  'mangrove-labyrinth': 'Maze',
  'dune-sea': 'Erg',
  'rift-gorge': 'Gorge',
  'stone-forest': 'Pinnacles',
  'hot-spring': 'Spring',
  travertine: 'Terraces',
  hoodoo: 'Chimneys',
  'slot-canyon': 'Slot',
}

/** Gazetteer heading for a kind — one essay, many named places. */
export const KIND_LABEL: Readonly<Record<WonderKind, string>> = {
  'salt-flat': 'Salt pans',
  'fjord-coast': 'Fjords',
  'great-delta': 'Deltas',
  'painted-mesa': 'Badlands',
  'monsoon-coast': 'Monsoon coasts',
  'glacier-field': 'Icefields',
  'mangrove-labyrinth': 'Mangrove mazes',
  'dune-sea': 'Sand seas',
  'rift-gorge': 'Gorges',
  'stone-forest': 'Stone forests',
  'hot-spring': 'Hot springs',
  travertine: 'Travertine',
  hoodoo: 'Hoodoos',
  'slot-canyon': 'Slot canyons',
}

/** Shared mechanism — printed once per kind, not once per twin. */
export const KIND_MECHANISM: Readonly<Record<WonderKind, string>> = {
  'salt-flat': 'Closed basins evaporate in place; salt remains where a river would be.',
  'fjord-coast': 'Ice cut troughs to the sea; the drowned valleys are deep and still.',
  'great-delta': 'A great river meets the sea and drops its load, splitting into a fan of silt.',
  'painted-mesa': 'Dry air and rare cloudbursts carve flat beds into mesas and banded slopes.',
  'monsoon-coast': 'Onshore winds wring a wet season against the land, then reverse and leave it parched.',
  'glacier-field': 'Snowfall outpaces melt; crevassed ice drains the accumulation zone toward the valleys.',
  'mangrove-labyrinth': 'Tidal channels and roots knit the mud each tide delivers, and the forest builds its own land.',
  'dune-sea': 'Far from the sea and starved of rivers, sand here moves only with the wind.',
  'rift-gorge': 'A river cuts down as fast as the land around it stands up.',
  'stone-forest': 'Warm rain etches moderately broken rock into fins, sinkholes, and pinnacle thickets.',
  'hot-spring': 'Where a plate pulls apart, groundwater comes up hot and leaves a coloured pool.',
  travertine: 'That water cools as it steps downhill and drops a white mineral crust.',
  hoodoo: 'Dry air leaves a hard cap on a soft peak; the sides fall away and a chimney remains.',
  'slot-canyon': 'Rare floods in a dry river cut a narrow slot between high walls.',
}

export interface WonderKindGroup {
  readonly kind: WonderKind
  readonly label: string
  readonly mechanism: string
  readonly places: readonly Wonder[]
}

/** Drop the kind epithet when the group heading already names it. */
export function shortWonderName(wonder: Wonder): string {
  const suffix = ` ${KIND_EPITHET[wonder.kind]}`
  return wonder.name.endsWith(suffix) ? wonder.name.slice(0, -suffix.length) : wonder.name
}

/** Cluster twins so the gazetteer does not reprint the same essay. */
export function groupWondersByKind(wonders: readonly Wonder[]): WonderKindGroup[] {
  const buckets = new Map<WonderKind, Wonder[]>()
  for (const w of wonders) {
    const list = buckets.get(w.kind)
    if (list) list.push(w)
    else buckets.set(w.kind, [w])
  }
  const groups: WonderKindGroup[] = []
  for (const kind of KINDS) {
    const places = buckets.get(kind)
    if (!places?.length) continue
    groups.push({
      kind,
      label: KIND_LABEL[kind],
      mechanism: KIND_MECHANISM[kind],
      places,
    })
  }
  return groups
}

function wonderName(kind: WonderKind, x: number, y: number, seed: number): string {
  const p = PREFIX[Math.floor(hash2(x, y, seed) * PREFIX.length)]
  const s = SUFFIX[Math.floor(hash2(x + 101, y + 57, seed ^ 0x9e3779) * SUFFIX.length)]
  return `${p}${s} ${KIND_EPITHET[kind]}`
}

// ---------------------------------------------------------------------------
// Blurbs — field-geographer voice, citing the actual local conditions
// ---------------------------------------------------------------------------

function pickFuture(a: string, b: string, x: number, y: number, seed: number): string {
  return hash2(x * 3 + 1, y * 5 + 2, seed) < 0.5 ? a : b
}

/** Compact local fact for a grouped row — the essay lives in inspect. */
function localFact(kind: WonderKind, world: World, x: number, y: number): string {
  const i = y * world.meta.width + x
  switch (kind) {
    case 'salt-flat':
      return `${Math.max(0, Math.round(basinDepth(world, x, y)))} m below rims`
    case 'fjord-coast':
      return `${Math.round(landRelief(world, x, y, 2))} m, ${Math.round(world.tempMean[i])}°C`
    case 'great-delta':
      return `flux ≈${Math.round(world.flux[i])}`
    case 'painted-mesa':
      return `~${Math.round(landElevStd(world, x, y, 2))} m relief`
    case 'monsoon-coast':
      return `swing ${Math.abs(world.summerMoist[i] - world.winterMoist[i]).toFixed(2)}`
    case 'glacier-field':
      return world.elev[i] > 2000
        ? `${Math.round(world.elev[i])} m`
        : `mean ${Math.round(world.tempMean[i])}°C`
    case 'mangrove-labyrinth':
      return `${shoreFeel(world.tempMean[i])} ${latBand(y, world.meta.height)} shore`
    case 'dune-sea':
      return `${Math.round(world.moistMean[i] * 100)}% moisture`
    case 'rift-gorge':
      return `${Math.round(gorgeWall(world, x, y))} m walls`
    case 'stone-forest':
      return `moisture ${world.moistMean[i].toFixed(2)}`
    case 'hot-spring':
      return `${Math.round(world.tempMean[i])}°C at a plate edge`
    case 'travertine':
      return `${Math.round(world.elev[i])} m, downhill of a spring`
    case 'hoodoo':
      return `${Math.round(landRelief(world, x, y, 1))} m drop`
    case 'slot-canyon':
      return `${Math.round(world.flux[i])} flux, dry`
  }
}

function describe(
  kind: WonderKind,
  world: World,
  x: number,
  y: number,
  coast: Float32Array,
): { blurb: string; futures: string } {
  const { width: w, height: h, seed } = world.meta
  const i = y * w + x
  const band = latBand(y, h)
  const elev = world.elev[i]

  switch (kind) {
    case 'salt-flat': {
      const depth = Math.max(0, Math.round(basinDepth(world, x, y)))
      const shadow = rainShadowSide(world, x, y)
      const why = shadow
        ? ` in the rain shadow of the ${shadow} range`
        : ` under a dry ${band} sky`
      return {
        blurb:
          `A hard white pan floors this closed basin${why}, roughly ${depth} m below its rims. ` +
          `What little runoff arrives evaporates in place, leaving salt where a river would be.`,
        futures: pickFuture(
          'If the climate wets, this pan floods into a shallow soda lake.',
          'If the region dries further, the crust thickens and cracks into vast salt polygons.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'fjord-coast': {
      const relief = Math.round(landRelief(world, x, y, 2))
      return {
        blurb:
          `Rock walls climb about ${relief} m within sight of this ${shoreFeel(world.tempMean[i])} shore ` +
          `(mean ${Math.round(world.tempMean[i])}°C). Glaciers ground these troughs down to the sea; ` +
          `the drowned valleys behind them are deep and still.`,
        futures: pickFuture(
          'If seas rise, the drowned valleys lengthen into deeper inlets.',
          'A warming climate sends the feeding ice into retreat, leaving hanging valleys and waterfalls.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'great-delta': {
      const fx = Math.round(world.flux[i])
      return {
        blurb:
          `A great river meets the sea here and drops its load, splitting into distributaries ` +
          `across a fan of silt. The flux funnelled through this mouth (≈${fx}) is among the highest on the map.`,
        futures: pickFuture(
          'Deltas wander: a few floods from now the main channel may avulse and build a new lobe.',
          'Any rise in sea level trims the fan back; a fall would let it march seaward.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'painted-mesa': {
      const std = Math.round(landElevStd(world, x, y, 2))
      return {
        blurb:
          `Dry ${band} badlands: flat-lying beds carved into mesas and banded slopes, with ` +
          `~${std} m of local relief and too little rain (moisture index ${world.moistMean[i].toFixed(2)}) ` +
          `for vegetation to hide the strata. Rare cloudbursts, not steady rivers, do the cutting.`,
        futures: pickFuture(
          'Each storm retreats the scarps a little further; the mesas are being consumed from their edges.',
          'A wetter regime would green the slopes and soften the painted banding within millennia.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'monsoon-coast': {
      const asym = Math.abs(world.summerMoist[i] - world.winterMoist[i])
      return {
        blurb:
          `This warm ${band} coast swings between a drenched half-year and a dry one — the seasonal ` +
          `moisture index differs by ${asym.toFixed(2)}. Onshore winds in the warm season wring their ` +
          `moisture out against the land, then reverse and leave it parched.`,
        futures: pickFuture(
          'A shifted storm track could shorten the wet season, and the coast’s forests with it.',
          'If the seasonal contrast sharpens, floods and droughts will trade places here every year.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'glacier-field': {
      const where =
        elev > 2000
          ? `at ${Math.round(elev)} m, high enough that snowfall outpaces melt`
          : `across this ${band} ground, cold enough (mean ${Math.round(world.tempMean[i])}°C) that snow outlasts summer`
      return {
        blurb:
          `Ice holds this land ${where}. Crevassed white streams drain the accumulation zone ` +
          `toward the valleys below.`,
        futures: pickFuture(
          'Sustained warming would pull the ice back upslope, leaving polished rock and moraine lines.',
          'A colder turn thickens the field and sends tongues of ice into the lowlands.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'mangrove-labyrinth': {
      return {
        blurb:
          `A tidal maze of mangrove channels lines this warm ${band} shore, roots knitting the mud ` +
          `each tide delivers. The forest builds its own land as it advances seaward.`,
        futures: pickFuture(
          'Slow sea-level rise the mangroves can outbuild; a fast rise would drown the maze from the outside in.',
          'Given silt and centuries, the labyrinth firms into coastal plain and the forest steps seaward again.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'dune-sea': {
      const cd = Math.round(coast[i])
      return {
        blurb:
          `An erg of live dunes deep in the ${band} interior, ${cd} cells from the nearest coast. ` +
          `Starved of rivers and too far from the sea for moisture to reach it, sand here moves only with the wind.`,
        futures: pickFuture(
          'A wetter regime would pin these dunes under grass within centuries.',
          'If the drying continues, the sand sea spreads and swallows its own margins.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'rift-gorge': {
      const wall = Math.round(gorgeWall(world, x, y))
      return {
        blurb:
          `A river runs between walls some ${wall} m high, cutting down as fast as the land ` +
          `around it stands up. The gorge marks where flowing water and rising rock disagree.`,
        futures: pickFuture(
          'Continued incision deepens the slot canyon year on year.',
          'If uplift stalls, the walls will slump back into an ordinary river valley.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'stone-forest': {
      return {
        blurb:
          `Warm, wet, moderately broken ground — the dissolution regime. Steady ${band} rain ` +
          `(moisture index ${world.moistMean[i].toFixed(2)}) etches the bedrock into fins, sinkholes, ` +
          `and pinnacle thickets under the canopy.`,
        futures: pickFuture(
          'Rain keeps sharpening the pinnacles until they undermine and topple, seeding a new generation below.',
          'A drier climate would halt the etching and leave the stone forest as a fossil landscape.',
          x,
          y,
          seed,
        ),
      }
    }
    case 'hot-spring':
      return {
        blurb: `Groundwater rises where the plate is pulling apart. The pool is hot for this ${band} latitude, and mineral rings stain the rim.`,
        futures: pickFuture(
          'If the rift keeps opening, the spring stays and the crust around it thickens.',
          'If the plates stop moving, the spring cools and the colour fades.',
          x,
          y,
          seed,
        ),
      }
    case 'travertine':
      return {
        blurb: `Water from the spring steps downhill and cools. Each step drops a white crust, so the slope becomes a stair of shallow pools.`,
        futures: pickFuture(
          'The stair grows as long as the spring runs.',
          'A drier climate leaves the terraces as dry white stone.',
          x,
          y,
          seed,
        ),
      }
    case 'hoodoo':
      return {
        blurb: `An arid peak with a steep side. The cap stays; the softer rock around it does not, so a chimney is left standing.`,
        futures: pickFuture(
          'Further dry weathering narrows the neck until the cap falls.',
          'A wetter climate rounds the chimney back into a hill.',
          x,
          y,
          seed,
        ),
      }
    case 'slot-canyon':
      return {
        blurb: `A river in dry country runs between walls high enough to shade the channel. Floods, not the mean rain, cut the slot.`,
        futures: pickFuture(
          'The next flood deepens the slot.',
          'If the river dies, the walls slowly slump and the slot fills.',
          x,
          y,
          seed,
        ),
      }
  }
}

// ---------------------------------------------------------------------------
// findWonders
// ---------------------------------------------------------------------------

/**
 * Scan a derived World for its natural wonders. Deterministic: same World →
 * same list. At most 8 wonders, at most 2 per kind, same-kind pairs at least
 * 12 cells apart (wrapped).
 */
export function findWonders(world: World): Wonder[] {
  const { width: w, height: h, threshold, seed } = world.meta
  const n = w * h
  const coast = coastDistField(world)

  // Parallel number arrays per kind — no per-cell object allocation.
  const cellsByKind: number[][] = KINDS.map(() => [])
  const scoresByKind: number[][] = KINDS.map(() => [])
  const add = (k: number, i: number, s: number): void => {
    cellsByKind[k].push(i)
    scoresByKind[k].push(s)
  }

  for (let i = 0; i < n; i++) {
    if (world.mask[i] < threshold) continue
    const x = i % w
    const y = (i - x) / w
    const b = world.biome[i]
    const elev = world.elev[i]
    const t = world.tempMean[i]
    const moist = world.moistMean[i]
    const fx = world.flux[i]
    const cd = coast[i]

    const site = world.sites?.[i] ?? 0
    if (world.salt?.[i]) add(K_SALT, i, site === 1 ? 0.95 : 0.7)
    if (site === 2) add(K_SPRING, i, 0.85)
    if (site === 3) add(K_TERRACE, i, 0.8)
    if (site === 4) add(K_HOODOO, i, 0.75)
    if (site === 5) add(K_SLOT, i, 0.8)

    // salt-flat: dry desert cell on the floor of a closed local basin.
    if (!world.salt?.[i] && (b === 'hot-desert' || b === 'boreal-desert') && moist < 0.16 && fx < 2.5) {
      const depth = basinDepth(world, x, y)
      if (depth > 120) {
        add(K_SALT, i, Math.min(1, depth / 450) * 0.75 + Math.min(0.25, 0.16 - moist))
      }
    }

    // fjord-coast: cold shore with steep relief within two cells of the sea.
    if (cd <= 2 && t < 2) {
      const relief = landRelief(world, x, y, 2)
      if (relief > 500) {
        add(K_FJORD, i, Math.min(1, relief / 1600) * 0.8 + Math.min(0.2, (2 - t) / 40))
      }
    }

    // great-delta: river mouth on the coast; raw flux, normalized below.
    if ((world.rivers[i] === 1 || fx >= 25) && seaAdjacent(world, x, y)) {
      if (fx >= 25) add(K_DELTA, i, fx)
    }

    // painted-mesa: desert badlands — high local relief variance, no summit.
    if (
      (b === 'hot-desert' || b === 'boreal-desert' || b === 'polar-desert') &&
      moist < 0.2 &&
      elev < 3200
    ) {
      const std = landElevStd(world, x, y, 2)
      if (std > 90) {
        add(K_MESA, i, Math.min(1, std / 380) * 0.85 + Math.max(0, Math.min(0.15, 0.16 - moist)))
      }
    }

    // monsoon-coast: warm shore with a strong seasonal moisture swing.
    if (cd <= 2 && t > 14) {
      const asym = Math.abs(world.summerMoist[i] - world.winterMoist[i])
      if (asym > 0.3) add(K_MONSOON, i, Math.min(1, asym * 1.6))
    }

    // glacier-field: contiguous ice or alpine ground.
    if (b === 'ice' || b === 'alpine') {
      const cluster = biomeClusterFrac(world, x, y, ['ice', 'alpine'])
      if (cluster >= 0.4) {
        add(K_GLACIER, i, cluster * 0.55 + Math.min(0.45, Math.max(0, elev) / 9000))
      }
    }

    // mangrove-labyrinth: mangrove cluster.
    if (b === 'mangrove') {
      const cluster = biomeClusterFrac(world, x, y, ['mangrove'])
      if (cluster >= 0.24) add(K_MANGROVE, i, 0.45 + cluster * 0.5)
    }

    // dune-sea: hot-desert heart, far from any coast, desert in every direction.
    if (b === 'hot-desert' && moist < 0.12 && cd > 10) {
      const frac = hotDesertFrac(world, x, y)
      if (frac >= 0.85) {
        add(K_DUNE, i, Math.min(1, cd / 28) * 0.5 + frac * 0.35 + (0.12 - moist))
      }
    }

    // rift-gorge: inland river pinched between high walls on both sides.
    if ((world.rivers[i] === 1 || fx >= 30) && cd > 2) {
      const wall = gorgeWall(world, x, y)
      if (wall > 350) {
        add(K_RIFT, i, Math.min(1, wall / 1200) * 0.85 + Math.min(0.15, fx / 400))
      }
    }

    // stone-forest: karst proxy — warm, wet forest over moderately broken rock.
    if (
      t >= 12 &&
      t <= 30 &&
      moist >= 0.5 &&
      elev >= 50 &&
      elev <= 2200 &&
      (b === 'rainforest' || b === 'temperate-forest' || b === 'temperate-deciduous')
    ) {
      const std = landElevStd(world, x, y, 2)
      if (std >= 60 && std <= 350) {
        add(K_STONE, i, (0.35 + moist * 0.25 + (std / 350) * 0.3) * 0.8)
      }
    }
  }

  // Deltas rank by how much of the map's best mouth flux they carry.
  if (cellsByKind[K_DELTA].length) {
    const raw = scoresByKind[K_DELTA]
    let best = 0
    for (const v of raw) if (v > best) best = v
    for (let k = 0; k < raw.length; k++) raw[k] = 0.6 + 0.4 * (raw[k] / best)
  }

  // Seeded tie-break so equal scores resolve the same way every run.
  const cellTie = (a: number, b: number): number => {
    const ha = hash2(a % w, (a - (a % w)) / w, seed)
    const hb = hash2(b % w, (b - (b % w)) / w, seed)
    return ha !== hb ? ha - hb : a - b
  }

  // Per kind: sort by score, greedily keep up to 2 with spacing enforced.
  const pickedKinds: number[] = []
  const pickedCells: number[] = []
  const pickedScores: number[] = []
  for (let k = 0; k < KINDS.length; k++) {
    const cells = cellsByKind[k]
    if (!cells.length) continue
    const scores = scoresByKind[k]
    const order = cells.map((_, j) => j)
    order.sort((p, q) => scores[q] - scores[p] || cellTie(cells[p], cells[q]))
    const chosen: number[] = []
    for (const j of order) {
      if (chosen.length >= MAX_PER_KIND) break
      const cx = cells[j] % w
      const cy = (cells[j] - cx) / w
      let ok = true
      for (const c of chosen) {
        if (wrapDist(cx, cy, c % w, (c - (c % w)) / w, w) < MIN_KIND_SPACING) {
          ok = false
          break
        }
      }
      if (!ok) continue
      chosen.push(cells[j])
      pickedKinds.push(k)
      pickedCells.push(cells[j])
      pickedScores.push(scores[j])
    }
  }

  // Global rank by distinctiveness, cap at 8.
  const order = pickedCells.map((_, j) => j)
  order.sort(
    (p, q) => pickedScores[q] - pickedScores[p] || cellTie(pickedCells[p], pickedCells[q]),
  )
  const top = order.slice(0, MAX_WONDERS)

  const perKindCount = new Int32Array(KINDS.length)
  const wonders: Wonder[] = []
  for (const j of top) {
    const k = pickedKinds[j]
    const kind = KINDS[k]
    const cell = pickedCells[j]
    const x = cell % w
    const y = (cell - x) / w
    const { blurb, futures } = describe(kind, world, x, y, coast)
    wonders.push({
      id: `${kind}-${perKindCount[k]++}`,
      kind,
      name: wonderName(kind, x, y, seed),
      x,
      y,
      blurb,
      futures,
      earthCousin: earthCousinFor(kind, y, h),
      fact: localFact(kind, world, x, y),
    })
  }
  return wonders
}
