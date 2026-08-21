/**
 * Writer accounts. Email + password live in Supabase Auth, never in this
 * client. Worlds still sit in localStorage until a later cloud library.
 */

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

export const MIN_PASSWORD = 8

export type Account = {
  readonly id: string
  readonly email: string
}

export type AccountResult =
  | { readonly ok: true; readonly account: Account | null; readonly needsConfirm: boolean }
  | { readonly ok: false; readonly error: string }

type AccountConfig = {
  readonly url: string
  readonly key: string
}

let client: SupabaseClient | null | undefined

export function readAccountConfig(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): AccountConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim()
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY)?.trim()
  if (!url || !key) return null
  return { url, key }
}

export function accountsConfigured(): boolean {
  return readAccountConfig() !== null
}

/** Tests only — drop the cached client after env stubs. */
export function resetAccountClient(): void {
  client = undefined
}

export function getAccountClient(): SupabaseClient | null {
  if (client !== undefined) return client
  const cfg = readAccountConfig()
  if (!cfg) {
    client = null
    return null
  }
  client = createClient(cfg.url, cfg.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return client
}

export function validateCredentials(email: string, password: string): string | null {
  const trimmed = email.trim()
  if (!trimmed.includes('@') || trimmed.startsWith('@') || trimmed.endsWith('@')) {
    return 'Need a real email.'
  }
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`
  }
  return null
}

export function accountFromUser(user: User | null | undefined): Account | null {
  if (!user?.id) return null
  const email = user.email?.trim()
  if (!email) return null
  return { id: user.id, email }
}

export function accountErrorMessage(error: { message?: string } | null | undefined): string {
  const raw = error?.message?.trim() ?? ''
  const lower = raw.toLowerCase()
  if (!raw) return 'Could not reach the account server.'
  if (lower.includes('invalid login')) return 'Email or password is wrong.'
  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return 'That email already has an account. Sign in instead.'
  }
  if (lower.includes('email not confirmed')) {
    return 'Check your email and confirm the account, then sign in.'
  }
  if (lower.includes('password')) return raw
  return raw
}

async function rememberProfile(supabase: SupabaseClient, account: Account): Promise<void> {
  const { error } = await supabase.from('profiles').upsert(
    { id: account.id, email: account.email },
    { onConflict: 'id' },
  )
  if (error) {
    // Auth still succeeded; the trigger usually inserts the row.
    console.warn('profile upsert', error.message)
  }
}

export async function loadAccount(): Promise<Account | null> {
  const supabase = getAccountClient()
  if (!supabase) return null
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return accountFromUser(data.user)
}

export async function signUpAccount(email: string, password: string): Promise<AccountResult> {
  const bad = validateCredentials(email, password)
  if (bad) return { ok: false, error: bad }
  const supabase = getAccountClient()
  if (!supabase) return { ok: false, error: 'Accounts are not wired on this build.' }
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: window.location.origin },
  })
  if (error) return { ok: false, error: accountErrorMessage(error) }
  const account = accountFromUser(data.user)
  if (account && data.session) await rememberProfile(supabase, account)
  return { ok: true, account, needsConfirm: !data.session }
}

export async function signInAccount(email: string, password: string): Promise<AccountResult> {
  const bad = validateCredentials(email, password)
  if (bad) return { ok: false, error: bad }
  const supabase = getAccountClient()
  if (!supabase) return { ok: false, error: 'Accounts are not wired on this build.' }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  })
  if (error) return { ok: false, error: accountErrorMessage(error) }
  const account = accountFromUser(data.user)
  if (account) await rememberProfile(supabase, account)
  return { ok: true, account, needsConfirm: false }
}

export async function signOutAccount(): Promise<void> {
  const supabase = getAccountClient()
  if (!supabase) return
  await supabase.auth.signOut()
}

export function watchAccount(onChange: (account: Account | null) => void): () => void {
  const supabase = getAccountClient()
  if (!supabase) {
    onChange(null)
    return () => {}
  }
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    onChange(accountFromUser(session?.user))
  })
  return () => data.subscription.unsubscribe()
}
