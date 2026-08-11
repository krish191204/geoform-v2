import { describe, it, expect, beforeEach } from 'vitest'
import {
  serializeWorld,
  deserializeWorld,
  autosaveWorld,
  loadAutosave,
  clearAutosave,
  hasAutosave,
  readWorldFile,
} from './persist'
import { generateWorld } from './generate'

describe('persist', () => {
  beforeEach(() => {
    clearAutosave()
  })

  it('roundtrips a world through serialize/deserialize', () => {
    const original = generateWorld(20, 12, 31)
    original.cities.push({ x: 5, y: 6, name: 'Testopolis', score: 0.5 })

    const saved = serializeWorld(original)
    expect(saved.version).toBe(1)
    expect(saved.width).toBe(original.width)
    expect(saved.height).toBe(original.height)
    expect(saved.seed).toBe(31)
    expect(saved.elev.length).toBe(original.elev.length)

    const restored = deserializeWorld(saved)
    expect(restored.width).toBe(original.width)
    expect(restored.height).toBe(original.height)
    expect(Array.from(restored.elev)).toEqual(Array.from(original.elev))
    expect(Array.from(restored.plateId)).toEqual(Array.from(restored.plateId))
    expect(restored.cities.length).toBe(1)
    expect(restored.cities[0]!.name).toBe('Testopolis')
    expect(restored.engine).toBe(original.engine)
  })

  it('autosaveWorld / loadAutosave round-trip through localStorage', () => {
    const w = generateWorld(16, 12, 11)
    autosaveWorld(w)
    expect(hasAutosave()).toBe(true)
    const loaded = loadAutosave()
    expect(loaded).not.toBeNull()
    expect(loaded!.seed).toBe(11)
    expect(loaded!.width).toBe(16)
  })

  it('loadAutosave returns null when nothing was saved', () => {
    clearAutosave()
    expect(loadAutosave()).toBeNull()
  })

  it('deserializeWorld rejects unknown save versions', () => {
    expect(() => deserializeWorld({ version: 99 as never } as never)).toThrow()
  })

  it('readWorldFile reads an exported JSON blob', async () => {
    const w = generateWorld(16, 12, 9)
    const saved = serializeWorld(w)
    const blob = new Blob([JSON.stringify(saved)], { type: 'application/json' })
    const file = new File([blob], 'world.json', { type: 'application/json' })
    const loaded = await readWorldFile(file)
    expect(loaded.seed).toBe(9)
    expect(loaded.width).toBe(16)
  })
})
