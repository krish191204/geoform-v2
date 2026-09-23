// @vitest-environment happy-dom
/**
 * Derived kingdom history: ages, origins, and a short ruin list.
 * Same grounded world, same chronicle. The mask stays put.
 */

import { describe, expect, it } from 'vitest'
import { mountStageWork } from '../app/ui'
import type { ShellStateView } from '../app/stages'
import { DEFAULT_META, emptyPolityState, type PlaceAnalog, type Polity, type World } from '../world/types'
import { ensureWorldbuild } from './polities'
import { attachChronicle, buildChronicle, foundingLine, MAX_RUINS } from './chronicle'

const FARM: PlaceAnalog = {
  id: 'temperate-farmland',
  label: 'Temperate farmland',
  because: 'Mild forest climate.',
  tradition: 'Mixed farmers of a mild forest climate.',
}

const HIGH: PlaceAnalog = {
  id: 'highland-plateau',
  label: 'High plateau',
  because: 'Thin air.',
  tradition: 'Highland farmers and herders above the heat of the plains.',
}

function sheet(width: number, height: number, seed = 11): World {
  const n = width * height
  return {
    meta: { ...DEFAULT_META, seed, width, height },
    mask: new Float32Array(n).fill(1),
    plateId: new Int16Array(n),
    plateVx: new Float32Array(n),
    plateVy: new Float32Array(n),
    elev: new Float32Array(n).fill(180),
    seasons: 2,
    summer: new Float32Array(n).fill(16),
    winter: new Float32Array(n).fill(6),
    summerMoist: new Float32Array(n).fill(0.45),
    winterMoist: new Float32Array(n).fill(0.4),
    tempMean: new Float32Array(n).fill(11),
    tempRange: new Float32Array(n).fill(10),
    moistMean: new Float32Array(n).fill(0.42),
    flux: new Float32Array(n),
    rivers: new Uint8Array(n),
    biome: Array.from({ length: n }, () => 'temperate-deciduous' as const),
    suitability: new Float32Array(n).fill(0.62),
    cities: [],
    ...emptyPolityState(n),
  }
}

function polity(partial: Pick<Polity, 'id' | 'name' | 'capitalX' | 'capitalY'> & Partial<Polity>): Polity {
  return {
    analog: FARM,
    tradition: FARM.tradition,
    exports: ['grain'],
    imports: ['timber'],
    meltingPot: 0.2,
    mass: 1,
    ...partial,
  }
}

function claim(world: World, x0: number, x1: number, id: number, suit: number): void {
  const { width: w, height: h } = world.meta
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x
      world.polityId[i] = id
      world.suitability[i] = suit
    }
  }
}

function view(world: World, act: ShellStateView['worldbuildAct']): ShellStateView {
  return {
    stage: 'worldbuild',
    world,
    meta: world.meta,
    tool: 'claim-land',
    brushSize: 8,
    strength: 1,
    issues: [],
    provenance: null,
    isProcessing: false,
    mask: world.mask,
    maskCommitted: true,
    makeSenseComplete: true,
    score: 0,
    layer: 'relief',
    season: 'summer',
    pipelineStep: 7,
    inspectHtml: '',
    viewMode: 'atlas',
    layoutMode: 'chrome',
    continentCount: 1,
    polityCount: world.polities.length,
    worldbuildAct: act,
    focusCell: null,
    worldOverlay: 'countries',
    canUndo: false,
    canRedo: false,
    sketchPlane: 'land',
    hasSketchNotes: false,
  }
}

describe('buildChronicle', () => {
  it('is deterministic for one seed and changes when the seed changes', () => {
    const world = sheet(36, 14, 5)
    claim(world, 0, 24, 0, 0.8)
    claim(world, 24, 36, 1, 0.2)
    world.polities = [
      polity({ id: 0, name: 'Westmark', capitalX: 6, capitalY: 7, tradition: 'Westfolk' }),
      polity({ id: 1, name: 'Eastmark', capitalX: 30, capitalY: 7, tradition: 'Eastfolk' }),
    ]
    const first = buildChronicle(world)
    const second = buildChronicle(world)
    expect(second).toEqual(first)
    const shifted = buildChronicle({ ...world, meta: { ...world.meta, seed: world.meta.seed + 97 } })
    expect(shifted).not.toEqual(first)
    expect(shifted.entries.map((e) => e.polityId)).toEqual(first.entries.map((e) => e.polityId))
  })

  it('gives every polity an origin and makes richer, larger land older', () => {
    const world = sheet(40, 16, 9)
    claim(world, 0, 28, 0, 0.86)
    claim(world, 28, 40, 1, 0.12)
    world.flux[7 * 40 + 6] = 40
    world.flux[7 * 40 + 34] = 40
    world.polities = [
      polity({ id: 0, name: 'Westmark', capitalX: 6, capitalY: 7, tradition: 'Westfolk' }),
      polity({ id: 1, name: 'Eastmark', capitalX: 34, capitalY: 7, tradition: 'Eastfolk' }),
    ]
    world.cities = [
      { x: 6, y: 7, name: 'West Seat', seasonal: 1, role: 'seat_of_power', polityId: 0 },
      { x: 34, y: 7, name: 'East Seat', seasonal: 1, role: 'seat_of_power', polityId: 1 },
      { x: 8, y: 7, name: 'Harbour', seasonal: 1, role: 'fishing', polityId: 0 },
    ]
    for (let y = 4; y < 9; y++) {
      for (let x = 10; x < 15; x++) world.biome[y * 40 + x] = 'mangrove'
    }
    const mask = Array.from(world.mask)
    const ids = Array.from(world.polityId)
    const chronicle = buildChronicle(world)
    expect(Array.from(world.mask)).toEqual(mask)
    expect(Array.from(world.polityId)).toEqual(ids)
    expect(world.polities).toHaveLength(2)

    expect(chronicle.entries).toHaveLength(2)
    for (const entry of chronicle.entries) {
      expect(entry.origin.trim().length).toBeGreaterThan(0)
      expect(entry.yearsAgo).toBeGreaterThan(80)
      expect(foundingLine(entry)).toMatch(/years ago/)
    }
    const west = chronicle.entries.find((e) => e.polityId === 0)!
    const east = chronicle.entries.find((e) => e.polityId === 1)!
    expect(west.yearsAgo).toBeGreaterThan(east.yearsAgo)
    expect(west.people).toBe('Westfolk')
    expect(east.people).toBe('Eastfolk')
    expect(east.origin).toMatch(/split from Westmark/)
    expect(west.border).toMatch(/Eastmark/)
    expect(east.border).toMatch(/Westmark/)
    expect(west.wonder).toMatch(/stands in this country/)
    expect(chronicle.ruins.length).toBe(MAX_RUINS)
    expect(chronicle.ruins.length).toBeLessThanOrEqual(6)
    expect(chronicle.ruins.every((r) => r.cause === 'The seat moved to the river.')).toBe(true)
    expect(chronicle.ruins.every((r) => r.name.length > 0 && r.landmass.length > 0)).toBe(true)
    const live = new Set(world.cities.map((c) => `${c.x},${c.y}`))
    expect(chronicle.ruins.every((r) => !live.has(`${r.x},${r.y}`))).toBe(true)
  })

  it('reads a highland hold and an empty coast from the land', () => {
    const high = sheet(20, 12, 3)
    high.elev.fill(1900)
    high.polityId.fill(0)
    high.polities = [
      polity({
        id: 0,
        name: 'Hold',
        capitalX: 10,
        capitalY: 6,
        analog: HIGH,
        tradition: HIGH.tradition,
      }),
    ]
    expect(buildChronicle(high).entries[0].origin).toMatch(/highland hold/)

    const coast = sheet(20, 12, 4)
    for (let y = 0; y < 12; y++) coast.mask[y * 20] = 0
    for (let i = 0; i < coast.polityId.length; i++) {
      if (coast.mask[i] >= coast.meta.threshold) coast.polityId[i] = 0
    }
    coast.polities = [polity({ id: 0, name: 'Haven', capitalX: 2, capitalY: 6, tradition: 'Shore folk' })]
    const origin = buildChronicle(coast).entries[0].origin
    expect(origin).toMatch(/empty coast/)
    expect(origin).toMatch(/Shore folk/)
  })

  it('does not throw on an empty world', () => {
    expect(() => buildChronicle(undefined as unknown as World)).not.toThrow()
    expect(buildChronicle({} as World)).toEqual({ entries: [], ruins: [] })
    const bare = sheet(8, 6, 1)
    bare.polities = []
    expect(() => attachChronicle(bare)).not.toThrow()
    expect(bare.chronicle?.entries).toEqual([])
    expect(bare.chronicle?.ruins.length).toBeLessThanOrEqual(MAX_RUINS)
  })

  it('hooks ensureWorldbuild without painting a new mask or a new kingdom', () => {
    const world = sheet(28, 16, 2)
    world.cities = [
      { x: 6, y: 8, name: 'SeatA', seasonal: 1, role: 'seat_of_power', rank: 'seat' },
      { x: 20, y: 8, name: 'SeatB', seasonal: 1, role: 'seat_of_power', rank: 'seat' },
    ]
    const mask = Array.from(world.mask)
    ensureWorldbuild(world, 2)
    expect(world.polities.length).toBe(2)
    expect(world.polities.length).toBeLessThanOrEqual(24)
    expect(world.chronicle?.entries).toHaveLength(2)
    expect(world.chronicle?.entries.every((e) => e.origin.length > 0)).toBe(true)
    expect((world.chronicle?.ruins.length ?? 0) <= MAX_RUINS).toBe(true)
    expect(Array.from(world.mask)).toEqual(mask)
  })

  it('prints the founding line and that kingdom’s towns, and lists ruins on the land page', () => {
    const world = sheet(40, 16, 9)
    claim(world, 0, 28, 0, 0.86)
    claim(world, 28, 40, 1, 0.12)
    world.flux[7 * 40 + 6] = 40
    world.polities = [
      polity({ id: 0, name: 'Westmark', capitalX: 6, capitalY: 7, tradition: 'Westfolk' }),
      polity({ id: 1, name: 'Eastmark', capitalX: 34, capitalY: 7, tradition: 'Eastfolk' }),
    ]
    world.cities = [
      { x: 6, y: 7, name: 'West Seat', seasonal: 1, role: 'seat_of_power', polityId: 0 },
      { x: 8, y: 7, name: 'Harbour', seasonal: 1, role: 'fishing', polityId: 0 },
    ]
    attachChronicle(world)
    const kingdoms = mountStageWork(view(world, 'kingdoms'))
    const text = kingdoms.textContent ?? ''
    expect(text).toMatch(/The continent/)
    expect(text).toMatch(/Westmark/)
    expect(text).toMatch(/Founded \d+ years ago/)
    expect(text).toMatch(/Westfolk/)
    expect(text).toMatch(/Harbour/)
    const names = Array.from(kingdoms.querySelectorAll('.place-name')) as HTMLInputElement[]
    expect(names.map((el) => el.value)).toEqual(['Westmark', 'Westfolk', 'Eastmark', 'Eastfolk'])
    expect(kingdoms.querySelector('[aria-label="People name"]')).toBeTruthy()

    const land = mountStageWork(view(world, 'land'))
    const ruin = world.chronicle?.ruins[0]
    expect(ruin).toBeTruthy()
    expect(land.textContent).toMatch(/ruins/)
    expect(land.textContent).toContain(ruin!.name)
    expect(land.textContent).toContain(ruin!.cause)
  })
})
