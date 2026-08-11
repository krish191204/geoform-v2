import { describe, it, expect } from 'vitest'
import {
  worldFromPayload,
  worldFromContractWorld,
  worldToContractWorld,
  fetchWorldEngineWorld,
  recomputeWorldEngine,
} from './worldengine'
import type { Biome, ContractWorld, WorldEnginePayload } from './types'

function makePayload(): WorldEnginePayload {
  const w = 16
  const h = 12
  return {
    engine: 'worldengine',
    width: w,
    height: h,
    seed: 123,
    seaLevel: 0.5,
    plateCount: 6,
    elev: Array.from({ length: w * h }, (_, i) => (i % w) / w),
    plateId: Array.from({ length: w * h }, () => 0),
    temp: Array.from({ length: w * h }, () => 0.5),
    moist: Array.from({ length: w * h }, () => 0.5),
    flux: Array.from({ length: w * h }, () => 0),
    biome: Array.from({ length: w * h }, () => 'ocean' as const),
    rawElevMin: 0,
    rawElevMax: 1,
    rawSeaThreshold: 0.5,
  }
}

function makeContractWorld(): ContractWorld {
  const w = 16
  const h = 12
  const oceanIdx = 12 // BIOME_NAMES index for "ocean"
  const row = (n: number, fn: (x: number) => number) => Array.from({ length: n }, (_, x) => fn(x))
  return {
    schema_version: 1,
    name: 'world-test',
    width: w,
    height: h,
    seed: 123,
    generation_params: {
      n_plates: 6,
      ocean_level: 0.5,
      step: 'full',
      fade_borders: true,
    },
    temps: [],
    humids: [],
    gamma_curve: 1.25,
    curve_offset: 0.2,
    layers: {
      elevation: { data: Array.from({ length: h }, () => row(w, (x) => x / w)) },
      plates: { data: Array.from({ length: h }, () => row(w, () => 0)) },
      temperature: { data: Array.from({ length: h }, () => row(w, () => 0.5)) },
      humidity: { data: Array.from({ length: h }, () => row(w, () => 0.5)) },
      watermap: { data: Array.from({ length: h }, () => row(w, () => 0)) },
      biome: { data: Array.from({ length: h }, () => row(w, () => oceanIdx)) },
    },
    sculpt: [],
    settlements: null,
  }
}

describe('worldengine bridge (legacy payload)', () => {
  it('worldFromPayload constructs a valid World', () => {
    const payload = makePayload()
    const world = worldFromPayload(payload)
    expect(world.width).toBe(payload.width)
    expect(world.height).toBe(payload.height)
    expect(world.seed).toBe(123)
    expect(world.engine).toBe('worldengine')
    expect(world.elev.length).toBe(payload.width * payload.height)
    expect(world.plateId.length).toBe(payload.width * payload.height)
    expect(world.temp.length).toBe(payload.width * payload.height)
    expect(world.moist.length).toBe(payload.width * payload.height)
    expect(world.flux.length).toBe(payload.width * payload.height)
    expect(world.biome.length).toBe(payload.width * payload.height)
    expect(world.suitability.length).toBe(payload.width * payload.height)
    expect(Array.isArray(world.cities)).toBe(true)
    expect(world.cities.length).toBe(0)
    expect(world.plateCount).toBe(6)
  })

  it('worldFromPayload preserves existing cities that fit in bounds', () => {
    const payload = makePayload()
    const cities = [
      { x: 1, y: 1, name: 'A', score: 0.5 },
      { x: -1, y: 5, name: 'B', score: 0.3 }, // out of bounds; should be dropped
    ]
    const world = worldFromPayload(payload, cities)
    expect(world.cities.length).toBe(1)
    expect(world.cities[0]!.name).toBe('A')
  })
})

describe('worldengine bridge (contract world)', () => {
  it('worldFromContractWorld constructs a valid World', () => {
    const doc = makeContractWorld()
    const world = worldFromContractWorld(doc)
    expect(world.width).toBe(doc.width)
    expect(world.height).toBe(doc.height)
    expect(world.seed).toBe(123)
    expect(world.engine).toBe('worldengine')
    expect(world.elev.length).toBe(doc.width * doc.height)
    expect(world.plateId.length).toBe(doc.width * doc.height)
    expect(world.temp.length).toBe(doc.width * doc.height)
    expect(world.moist.length).toBe(doc.width * doc.height)
    expect(world.flux.length).toBe(doc.width * doc.height)
    expect(world.biome.length).toBe(doc.width * doc.height)
    expect(world.suitability.length).toBe(doc.width * doc.height)
    expect(world.cities.length).toBe(0)
    expect(world.plateCount).toBe(doc.generation_params.n_plates)
    expect(world.biome[0]).toBe('ocean')
  })

  it('worldFromContractWorld preserves in-bounds cities', () => {
    const doc = makeContractWorld()
    const cities = [
      { x: 1, y: 1, name: 'A', score: 0.5 },
      { x: -1, y: 5, name: 'B', score: 0.3 },
    ]
    const world = worldFromContractWorld(doc, cities)
    expect(world.cities.length).toBe(1)
    expect(world.cities[0]!.name).toBe('A')
  })

  it('worldToContractWorld round-trips through worldFromContractWorld', () => {
    const base = worldFromContractWorld(makeContractWorld())
    base.cities.push({ x: 2, y: 2, name: 'Round', score: 0.7 })
    const doc = worldToContractWorld(base)
    expect(doc.width).toBe(base.width)
    expect(doc.height).toBe(base.height)
    expect(doc.seed).toBe(base.seed)
    expect(doc.layers.elevation?.data.length).toBe(base.height)
    expect(doc.layers.elevation?.data[0]?.length).toBe(base.width)
    const restored = worldFromContractWorld(doc, base.cities)
    expect(restored.cities.length).toBe(1)
    expect(restored.cities[0]!.name).toBe('Round')
    // biome strings survived the round-trip
    expect(restored.biome.length).toBe(base.biome.length)
  })
})

describe('worldengine HTTP bridge', () => {
  it('fetchWorldEngineWorld posts the contract shape and converts the response', async () => {
    const doc = makeContractWorld()
    let captured: { url: string; body: string } | null = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : '',
      }
      return new Response(JSON.stringify(doc), { status: 200 })
    }) as typeof fetch

    try {
      const world = await fetchWorldEngineWorld(123, doc.width, doc.height, 6)
      expect(world.engine).toBe('worldengine')
      expect(world.seed).toBe(123)
      expect(world.width).toBe(doc.width)
      expect(captured).not.toBeNull()
      expect(captured!.url).toContain('/api/generate')
      const sent = JSON.parse(captured!.body) as Record<string, unknown>
      expect(typeof sent.name).toBe('string')
      expect(sent.name).toMatch(/^world-123-/)
      expect(sent.width).toBe(doc.width)
      expect(sent.height).toBe(doc.height)
      expect(sent.seed).toBe(123)
      expect(sent.num_plates).toBe(6)
      expect(sent.step).toBe('full')
      expect(sent.ocean_level).toBe(1.0)
      expect(sent.fade_borders).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fetchWorldEngineWorld throws on bad status', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 500 })) as typeof fetch

    try {
      await expect(fetchWorldEngineWorld(1, 16, 12, 4)).rejects.toThrow(/nope/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fetchWorldEngineWorld surfaces server message before error code', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'detailed failure', error: 'oops' }), {
        status: 422,
      })) as typeof fetch

    try {
      await expect(fetchWorldEngineWorld(1, 16, 12, 4)).rejects.toThrow(/detailed failure/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('recomputeWorldEngine POSTs the full world and preserves cities', async () => {
    const doc = makeContractWorld()
    let captured: { url: string; body: string } | null = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : '',
      }
      return new Response(JSON.stringify(doc), { status: 200 })
    }) as typeof fetch

    try {
      const base = worldFromContractWorld(makeContractWorld())
      base.cities.push({ x: 1, y: 1, name: 'Keepme', score: 0.5 })
      const next = await recomputeWorldEngine(base)
      expect(next.width).toBe(doc.width)
      expect(next.cities.length).toBe(1)
      expect(next.cities[0]!.name).toBe('Keepme')
      expect(captured).not.toBeNull()
      expect(captured!.url).toContain('/api/recompute')
      const sent = JSON.parse(captured!.body) as { world: ContractWorld }
      expect(sent.world.width).toBe(doc.width)
      expect(sent.world.height).toBe(doc.height)
      expect(sent.world.seed).toBe(123)
      expect(sent.world.layers.elevation?.data.length).toBe(doc.height)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('recomputeWorldEngine throws "recompute failed" fallback when envelope is empty', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('not json', { status: 500, headers: { 'Content-Type': 'text/plain' } })) as typeof fetch

    try {
      await expect(
        recomputeWorldEngine(worldFromContractWorld(makeContractWorld())),
      ).rejects.toThrow(/recompute failed|HTTP 500/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('worldengine biome index mapping', () => {
  it('maps index 12 to "ocean"', () => {
    const doc = makeContractWorld()
    const world = worldFromContractWorld(doc)
    for (let i = 0; i < world.biome.length; i++) {
      expect(world.biome[i]).toBe<Biome>('ocean')
    }
  })

  it('round-trips a non-ocean biome', () => {
    const doc = makeContractWorld()
    const forestIdx = 2 // "boreal moist forest"
    doc.layers.biome = {
      data: Array.from({ length: doc.height }, () =>
        Array.from({ length: doc.width }, () => forestIdx),
      ),
    }
    const world = worldFromContractWorld(doc)
    expect(world.biome[0]).toBe('boreal moist forest')
    const sent = worldToContractWorld(world)
    expect(sent.layers.biome?.data[0]?.[0]).toBe(forestIdx)
  })
})
