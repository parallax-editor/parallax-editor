// Unit test for the pure id-derivation helpers added in 56d618f to
// src/stores/editor.ts: idFromAssetSrc, nextCopyId, renameWithCopySuffix
// (and sanitizeId which they both rely on).
//
// Why this exists: the e2e browser harness can't run from this sandboxed
// session (Chrome SIGABRTs on launch); these helpers are pure (strings in,
// strings out — no Vue, no store) so we can exercise them directly.
//
// Strategy: extract just the helper function source from editor.ts via
// regex (so the test fails if the source layout drifts), transpile with
// esbuild.transform (no bundle, no import resolution), and import the
// resulting module. This runs the ACTUAL production code — not a copy.

import { transform } from 'esbuild'
import { readFile, writeFile, rm } from 'node:fs/promises'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const editorPath = `${repoRoot}src/stores/editor.ts`
const src = await readFile(editorPath, 'utf8')

function extract(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`could not extract ${name} from editor.ts — has the source layout changed?`)
  return m[0]
}
const sanitizeId = extract('sanitizeId', /export function sanitizeId\([\s\S]*?^}/m)
const idFromAssetSrc = extract('idFromAssetSrc', /^function idFromAssetSrc\([\s\S]*?^}/m)
const copyRe = extract('COPY_SUFFIX_PLAIN_RE', /const COPY_SUFFIX_PLAIN_RE = [^\n]+\n/)
const nextCopyId = extract('nextCopyId', /^function nextCopyId\([\s\S]*?^}/m)
const renameWithCopySuffix = extract('renameWithCopySuffix', /^function renameWithCopySuffix\([\s\S]*?^}/m)

const combined = `
${sanitizeId.replace('export function', 'function')}
${idFromAssetSrc}
${copyRe}
${nextCopyId}
${renameWithCopySuffix}
export { sanitizeId, idFromAssetSrc, nextCopyId, renameWithCopySuffix }
`
const out = await transform(combined, { loader: 'ts', format: 'esm' })
const tmpFile = `${repoRoot}tests/_helpers-tmp.mjs`
await writeFile(tmpFile, out.code)

let pass = false
try {
  const mod = await import(`./_helpers-tmp.mjs?${Date.now()}`)
  const { idFromAssetSrc: idFn, nextCopyId: nextFn, renameWithCopySuffix: renameFn } = mod

  // idFromAssetSrc: filename → kebab id
  assert.equal(idFn('images/foto-boda.png'), 'foto-boda', 'simple png path')
  assert.equal(idFn('video/Intro Final.mp4'), 'intro-final', 'spaces → kebab, lowercased')
  assert.equal(idFn('audio/canción.mp3'), 'cancion', 'accents stripped')
  assert.equal(idFn('Foo.PNG'), 'foo', 'no dir, ext stripped, lowercased')
  assert.equal(idFn('images/sub/dir/file.svg'), 'file', 'deep path → basename only')
  assert.equal(idFn(''), '', 'empty input → empty (caller falls back to random id)')

  // nextCopyId: append -copy, dedupe, strip prior -copy[-N]
  assert.equal(nextFn('foto', new Set()), 'foto-copy', 'first copy gets -copy')
  assert.equal(nextFn('foto', new Set(['foto-copy'])), 'foto-copy-2', 'collision → -2')
  assert.equal(nextFn('foto', new Set(['foto-copy', 'foto-copy-2'])), 'foto-copy-3', 'second collision → -3')
  assert.equal(nextFn('foto-copy', new Set(['foto-copy'])), 'foto-copy-2',
    'copy of a copy strips existing -copy first (no foto-copy-copy)')
  assert.equal(nextFn('foto-copy-3', new Set(['foto-copy-3'])), 'foto-copy',
    'copy of foto-copy-3 strips and restarts at -copy')

  // renameWithCopySuffix: recursive section/layer/element rename
  const section = {
    id: 'seccion-hero',
    layers: [
      { id: 'capa-frente', elements: [{ id: 'titulo' }, { id: 'sub' }] },
      { id: 'capa-fondo', elements: [{ id: 'imagen' }] },
    ],
  }
  renameFn(section, new Set())
  assert.equal(section.id, 'seccion-hero-copy')
  assert.equal(section.layers[0].id, 'capa-frente-copy')
  assert.equal(section.layers[0].elements[0].id, 'titulo-copy')
  assert.equal(section.layers[0].elements[1].id, 'sub-copy')
  assert.equal(section.layers[1].id, 'capa-fondo-copy')
  assert.equal(section.layers[1].elements[0].id, 'imagen-copy')

  // Empty branches still safe (no .layers, no .elements).
  const el = { id: 'lone' }
  renameFn(el, new Set())
  assert.equal(el.id, 'lone-copy')

  // Cross-collision across siblings (taken accumulates).
  const taken = new Set(['x-copy'])
  const a = { id: 'x' }
  const b = { id: 'x' }
  renameFn(a, taken)
  renameFn(b, taken)
  assert.equal(a.id, 'x-copy-2')
  assert.equal(b.id, 'x-copy-3')

  pass = true
  console.log('✓ editor-helpers test passed — idFromAssetSrc, nextCopyId, renameWithCopySuffix')
} finally {
  await rm(tmpFile, { force: true })
  if (!pass) process.exit(1)
}
