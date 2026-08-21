/**
 * Optional signed-in library. Grids are blobs, never jsonb of number[].
 *
 * Until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY exist, this module
 * reports disabled and the writer keeps Download JSON / localStorage.
 * Boot never calls loadWorld(); Resume is an explicit later click.
 */

export interface CloudConfig {
  url: string
  anonKey: string
}

type EnvMap = { readonly [key: string]: string | boolean | undefined }

function envStr(env: EnvMap, key: string): string {
  const v = env[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** True when a Supabase project has been pasted into the Vite env. */
export function cloudLibraryEnabled(env: EnvMap = import.meta.env as EnvMap): boolean {
  return Boolean(readCloudConfig(env))
}

export function readCloudConfig(env: EnvMap = import.meta.env as EnvMap): CloudConfig | null {
  const url = envStr(env, 'VITE_SUPABASE_URL')
  const anonKey = envStr(env, 'VITE_SUPABASE_ANON_KEY')
  if (!url || !anonKey) return null
  return { url, anonKey }
}

/**
 * Catalog DDL for when a project exists. Worlds table holds metadata;
 * the grid lives in Storage at `blob_path`. Never store World arrays in SQL.
 */
export const WORLDS_CATALOG_SQL = `
create table if not exists public.worlds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled world',
  seed integer not null,
  blob_path text not null,
  created_at timestamptz not null default now()
);
alter table public.worlds enable row level security;
create policy worlds_owner on public.worlds
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
`.trim()

/**
 * Upload is a no-op until keys exist. Callers must keep Download JSON.
 */
export async function uploadWorldBlob(
  _bytes: Uint8Array,
  _path: string,
  env: EnvMap = import.meta.env as EnvMap,
): Promise<boolean> {
  if (!readCloudConfig(env)) return false
  return false
}
