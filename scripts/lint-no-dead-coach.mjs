#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS = ['Smooth', 'Ridge', 'Channel', 'Plateau', 'Director', 'Alternatives', 'Full continents']
// The rule protects user-facing coach/chrome copy. Scanning every source file
// confuses renderer identifiers such as ImageSmoothingQuality and terrain
// terms such as ridge with retired UI labels.
const COPY_SURFACES = [
  'src/app/coach.ts',
  'src/app/ui.ts',
  'src/app/shell.ts',
]

const violations = []
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

for (const surface of COPY_SURFACES) scan(join(process.cwd(), surface))
if (violations.length > 0) {
  for (const v of violations) {
    console.error(`${v.path}:${v.line}:${v.col}: ${v.token}`)
  }
  console.error(`\n${violations.length} forbidden coach token(s) found in UI copy.`)
  process.exit(1)
}
console.log('ok')
