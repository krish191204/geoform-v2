import { describe, it, expect } from 'vitest'
import { worldFromPayload, fetchWorldEngineWorld, recomputeWorldEngine } from './worldengine'
import type { WorldEnginePayload } from './types'

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

describe('worldengine bridge', () => {
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

  it('fetchWorldEngineWorld calls /api/generate and converts the payload', async () => {
    const payload = makePayload()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('/api/generate')
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as typeof fetch

    try {
      const world = await fetchWorldEngineWorld(123, payload.width, payload.height, 6)
      expect(world.engine).toBe('worldengine')
      expect(world.seed).toBe(123)
      expect(world.width).toBe(payload.width)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fetchWorldEngineWorld throws on bad status', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 500 })) as typeof fetch

    try {
      await expect(fetchWorldEngineWorld(1, 16, 12, 4)).rejects.toThrow(/nope|WorldEngine/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('recomputeWorldEngine sends only the recompute-friendly subset', async () => {
    const payload = makePayload()
    let captured: { url: string; body: string } | null = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : '',
      }
      return new Response(JSON.stringify({ ...payload, cities: [] }), { status: 200 })
    }) as typeof fetch

    try {
      const base = worldFromPayload(makePayload())
      base.cities.push({ x: 1, y: 1, name: 'Keepme', score: 0.5 })
      const next = await recomputeWorldEngine(base)
      expect(next.width).toBe(payload.width)
      expect(captured).not.toBeNull()
      expect(captured!.url).toContain('/api/recompute')
      const sent = JSON.parse(captured!.body) as Record<string, unknown>
      expect(sent.width).toBe(payload.width)
      expect(sent.height).toBe(payload.height)
      expect(sent.seed).toBe(123)
      expect(Array.isArray(sent.elev)).toBe(true)
      expect(Array.isArray(sent.plateId)).toBe(true)
      expect(sent.seaLevel).toBe(payload.seaLevel)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
