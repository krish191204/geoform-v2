#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS = ['Smooth', 'Ridge', 'Channel', 'Plateau', 'Director', 'Alternatives', 'Full continents']
const SKIP_DIR = new Set(['node_modules', 'dist', '.git'])
const SKIP_EXT = new Set(['.bak', '.orig', '.tmp'])

const violations = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (SKIP_DIR.has(entry)) continue
    const st = statSync(p)
    if (st.isDirectory()) {
      walk(p)
    } else if (st.isFile()) {
      if (SKIP_EXT.has(extname(p))) continue
      if (p.endsWith('.test.ts')) continue
      scan(p)
    }
  }
}
function extname(p) {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i)
}
function scan(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // Allow escape hatches
    const allow = matchAllowComment(raw)
    const text = allow ? raw.replace(allow[0], '') : raw
    for (const tok of TOKENS) {
      if (allow && allow[1].includes(tok)) continue
      const idx = text.indexOf(tok)
      if (idx >= 0) {
        violations.push({ path, line: i + 1, col: idx + 1, token: tok })
      }
    }
  }
}
function matchAllowComment(line) {
  const m = line.match(/\/\/ allow-coach-token:\s*([\w\s,]+)/)
  return m ? [m[0], m[1].split(',').map((s) => s.trim())] : null
}

walk(join(process.cwd(), 'src'))
if (violations.length > 0) {
  for (const v of violations) {
    console.error(`${v.path}:${v.line}:${v.col}: ${v.token}`)
  }
  console.error(`\n${violations.length} forbidden coach token(s) found in src/.`)
  process.exit(1)
}
console.log('ok')
