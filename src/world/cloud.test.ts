import { describe, expect, it } from 'vitest'
import { cloudLibraryEnabled, readCloudConfig, uploadWorldBlob, WORLDS_CATALOG_SQL } from './cloud'

describe('cloud library adapter', () => {
  it('stays disabled without URL and anon key', () => {
    expect(readCloudConfig({})).toBeNull()
    expect(cloudLibraryEnabled({})).toBe(false)
  })

  it('reads keys when both are present', () => {
    const cfg = readCloudConfig({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon',
    })
    expect(cfg).toEqual({
      url: 'https://example.supabase.co',
      anonKey: 'anon',
    })
  })

  it('does not upload until a project exists', async () => {
    expect(await uploadWorldBlob(new Uint8Array([1]), 'w.bin', {})).toBe(false)
    expect(await uploadWorldBlob(new Uint8Array([1]), 'w.bin', {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon',
    })).toBe(false)
  })

  it('catalog SQL stores a blob path, not jsonb grids', () => {
    expect(WORLDS_CATALOG_SQL).toMatch(/blob_path/)
    expect(WORLDS_CATALOG_SQL).not.toMatch(/jsonb/)
  })
})
