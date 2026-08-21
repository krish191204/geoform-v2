// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  accountErrorMessage,
  accountFromUser,
  readAccountConfig,
  validateCredentials,
} from './account'
import type { User } from '@supabase/supabase-js'

describe('readAccountConfig', () => {
  it('needs both a url and a publishable key', () => {
    expect(readAccountConfig({})).toBeNull()
    expect(readAccountConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBeNull()
    expect(
      readAccountConfig({
        VITE_SUPABASE_URL: 'https://x.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }),
    ).toEqual({
      url: 'https://x.supabase.co',
      key: 'sb_publishable_test',
    })
  })

  it('accepts the legacy anon key', () => {
    expect(
      readAccountConfig({
        VITE_SUPABASE_URL: 'https://x.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'anon',
      })?.key,
    ).toBe('anon')
  })
})

describe('validateCredentials', () => {
  it('rejects empty-looking email and short passwords', () => {
    expect(validateCredentials('', 'abcdefgh')).toMatch(/email/i)
    expect(validateCredentials('writer@geoform.test', 'short')).toMatch(/8/)
    expect(validateCredentials('writer@geoform.test', 'abcdefgh')).toBeNull()
  })
})

describe('accountFromUser', () => {
  it('drops users without an email', () => {
    expect(accountFromUser({ id: 'u1' } as User)).toBeNull()
    expect(accountFromUser({ id: 'u1', email: 'a@b.c' } as User)).toEqual({
      id: 'u1',
      email: 'a@b.c',
    })
  })
})

describe('accountErrorMessage', () => {
  it('rewrites the usual Auth failures', () => {
    expect(accountErrorMessage({ message: 'Invalid login credentials' })).toMatch(/wrong/i)
    expect(accountErrorMessage({ message: 'User already registered' })).toMatch(/already/i)
  })
})
