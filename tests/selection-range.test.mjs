// Contrato de `setTreeSelectionRange` — Shift+click en el árbol de capas
// (Bloque C2 del feedback de Daniela).
//
//   • Con un ancla previa y un target del mismo nivel visible, agrega TODOS
//     los hermanos entre ambos al set (union con lo previo).
//   • Sin ancla → single-select del target.
//   • Ancla de otro nivel → single-select (Finder no cruza niveles).
//   • Target no visible (colapsado) → single-select defensivo.
//
// Se extrae la función del store con esbuild + regex — misma técnica que
// tests/editor-helpers.test.mjs.

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const src = await readFile(`${repoRoot}src/stores/editor.ts`, 'utf-8')

function extract(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`could not extract ${name} — layout changed?`)
  return m[0]
}
const isGlobalPathFn = extract('isGlobalPath', /^export function isGlobalPath\([\s\S]*?^}/m)
const isTreeNodePathFn = extract('isTreeNodePath', /^function isTreeNodePath\([\s\S]*?^}/m)
const rangeFn = extract('setTreeSelectionRange', /^export function setTreeSelectionRange\([\s\S]*?^}/m)

// El fragmento usa `state` — reemplazamos por un stub inyectable.
const combined = `
const state = { selectedPath: null, selectedPaths: [] }
const GLOBAL_SITE = '@site', GLOBAL_THEME = '@theme', GLOBAL_RESOURCES = '@resources'
${isGlobalPathFn}
${isTreeNodePathFn.replace('function isTreeNodePath', 'export function isTreeNodePath')}
${rangeFn}
export { state }
`
const out = await transform(combined, { loader: 'ts', format: 'esm' })
const tmp = await mkdtemp(join(tmpdir(), 'sel-range-'))
const file = join(tmp, 'sel.mjs')
await writeFile(file, out.code)
const mod = await import(`file://${file}?t=${Date.now()}`)

const P = (n) => `sections.0.layers.0.elements.${n}`
const ordered = [P(0), P(1), P(2), P(3), P(4)]

// 1) Range sin ancla → single-select
mod.state.selectedPath = null
mod.state.selectedPaths = []
mod.setTreeSelectionRange(P(2), ordered)
assert.equal(mod.state.selectedPath, P(2))
assert.deepEqual(mod.state.selectedPaths, [P(2)])

// 2) Ancla en P(1), Shift-click en P(3) → range [1..3]
mod.state.selectedPath = P(1)
mod.state.selectedPaths = [P(1)]
mod.setTreeSelectionRange(P(3), ordered)
assert.deepEqual(mod.state.selectedPaths, [P(1), P(2), P(3)])
assert.equal(mod.state.selectedPath, P(3))

// 3) Reverse: ancla P(4), Shift-click P(1) → range [1..4]
mod.state.selectedPath = P(4)
mod.state.selectedPaths = [P(4)]
mod.setTreeSelectionRange(P(1), ordered)
assert.deepEqual(
  [...mod.state.selectedPaths].sort(),
  [P(1), P(2), P(3), P(4)].sort(),
)
assert.equal(mod.state.selectedPath, P(1))

// 4) Union: había una selección aislada P(0), range P(2..3) → mantiene P(0)
mod.state.selectedPath = P(2)
mod.state.selectedPaths = [P(0), P(2)]
mod.setTreeSelectionRange(P(3), ordered)
assert.deepEqual(
  [...mod.state.selectedPaths].sort(),
  [P(0), P(2), P(3)].sort(),
  'range hace union con la selección previa',
)

// 5) Ancla de OTRO nivel (una sección) → single-select del target elemento
mod.state.selectedPath = 'sections.0'
mod.state.selectedPaths = ['sections.0']
mod.setTreeSelectionRange(P(2), ordered)
assert.deepEqual(mod.state.selectedPaths, [P(2)], 'cruce de niveles cae a single')
assert.equal(mod.state.selectedPath, P(2))

// 6) Target NO visible (no está en ordered — colapsado) → single-select
mod.state.selectedPath = P(1)
mod.state.selectedPaths = [P(1)]
mod.setTreeSelectionRange('sections.0.layers.0.elements.99', ordered)
assert.deepEqual(mod.state.selectedPaths, ['sections.0.layers.0.elements.99'])

console.log('✓ tree range-select OK')
await rm(tmp, { recursive: true, force: true }).catch(() => {})
