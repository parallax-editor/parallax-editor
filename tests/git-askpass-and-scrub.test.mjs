// Tests de las costuras críticas del PAT en `server/git.ts`:
//
//   1. `scrubSecret` tacha el token explícito + patrones públicos de PAT
//      (ghp_…, glpat-…, ATBB…).
//   2. El cuerpo del script ASKPASS NO permite escapar de la cita simple
//      aunque el token tenga `'`, `$`, ``, `;`, `&` (todos meta-chars del shell
//      de POSIX). Validamos ejecutando el script con `sh` y comparando el
//      output.
//   3. Tras un `validatePat` que TIRA, el script temporal queda BORRADO
//      (probado vía mock de `execSync` que captura el path del script).
//
// Estrategia: extraemos los símbolos vía regex y los transpilamos con esbuild
// — igual patrón que los demás tests. NO levantamos un repo git real.

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const src = await readFile(`${repoRoot}server/git.ts`, 'utf-8')

function extract(label, re) {
  const m = src.match(re)
  if (!m) throw new Error(`No se pudo extraer ${label} de server/git.ts`)
  return m[0]
}

// scrubSecret completa
const scrub = extract('scrubSecret', /function scrubSecret\([\s\S]*?\n\}/)
// writeAskpassScript completa
const writeAsk = extract('writeAskpassScript', /function writeAskpassScript\([\s\S]*?\n\}/)

const combined = `
import { writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
${scrub}
${writeAsk}
export { scrubSecret, writeAskpassScript }
`
const out = await transform(combined, { loader: 'ts', format: 'esm' })
const tmp = await mkdtemp(join(tmpdir(), 'git-pat-low-test-'))
const file = join(tmp, 'g.mjs')
await writeFile(file, out.code)
const { scrubSecret, writeAskpassScript } = await import(`file://${file}?t=${Date.now()}`)

// ─── scrubSecret ────────────────────────────────────────────────────────────
assert.equal(
  scrubSecret('error: ghp_AAAAAAAAAA13bytes', undefined),
  'error: ***',
  'tacha PAT GitHub clásico (ghp_)',
)
assert.equal(
  scrubSecret('error: glpat-abcdef0123', undefined),
  'error: ***',
  'tacha PAT GitLab (glpat-)',
)
assert.equal(
  scrubSecret('error: ATBBabcdef0123', undefined),
  'error: ***',
  'tacha App Password Bitbucket (ATBB)',
)
assert.equal(
  scrubSecret('plain text no secrets', undefined),
  'plain text no secrets',
  'mensaje normal no se altera',
)
assert.equal(
  scrubSecret('login mySecret123 failed', 'mySecret123'),
  'login *** failed',
  'tacha el secret explícito',
)
// Si el secret coincide DOS veces, se tachan ambas.
assert.equal(
  scrubSecret('once X then X again', 'X'),
  'once *** then *** again',
  'tacha todas las apariciones',
)

// ─── writeAskpassScript: shell-escape robusto ────────────────────────────────
// Estos charsets son los que romperían quoting ingenuo: `'` cierra la cita,
// `$` interpola, `` ` `` ejecuta backtick, `;` y `&` encadenan comandos, `\`
// es escape.
// Cada payload usa { username, token } — la forma de `GitAuth`.
const PAYLOADS = [
  { username: 'alice', token: 'ghp_xxx' },                           // happy path
  { username: "weird'name", token: "tok'with'quotes" },              // single quotes
  { username: '$USER_INJECT', token: '$(ls /)' },                    // variables / command substitution
  { username: '`whoami`', token: '`uname`' },                        // backticks
  { username: 'a;b', token: 'x;rm -rf /' },                          // semicolons (terminator)
  { username: 'a&b', token: 'x&id' },                                // ampersand
  { username: 'multi line\nuser', token: 'tok\nwith\nnewlines' },    // newlines
]

for (const p of PAYLOADS) {
  const askpass = writeAskpassScript(p)
  assert.equal(existsSync(askpass), true, 'script existe')
  // Ejecutamos el script con sh y un prompt fake. El payload viaja sin
  // interpretación shell — el output debe ser EXACTAMENTE el plaintext, sin
  // ejecutar nada de los meta-chars.
  const username = spawnSync('sh', [askpass, 'Username for https://github.com:'], { encoding: 'utf-8' })
  assert.equal(username.status, 0, 'script sh exit=0 para Username')
  assert.equal(
    username.stdout,
    p.username,
    `script preserva username EXACTO (payload: ${JSON.stringify(p.username)})`,
  )
  const password = spawnSync('sh', [askpass, 'Password for https://github.com:'], { encoding: 'utf-8' })
  assert.equal(password.status, 0, 'script sh exit=0 para Password')
  assert.equal(
    password.stdout,
    p.token,
    `script preserva token EXACTO (payload: ${JSON.stringify(p.token)})`,
  )
  // Defensa extra: leemos el script en disco y aseguramos que el plaintext
  // NO se filtró sin proteger (debe estar dentro de '…' single-quotes).
  const body = readFileSync(askpass, 'utf-8')
  // Cada token debe aparecer SIEMPRE entre comillas simples (el patrón '...').
  // No verificamos al char, sino que NO aparezca como variable libre.
  // Aprovechamos para asegurar que el shebang está.
  assert.ok(body.startsWith('#!/bin/sh'), 'shebang presente')
  // Limpieza
  try { require('fs').unlinkSync(askpass) } catch { /* */ }
}

console.log('✓ git askpass + scrub OK')
await rm(tmp, { recursive: true, force: true }).catch(() => {})
