// Contrato de `moveNodes` — drag multi-selección entre capas (Bloque C3).
//
//   • Move batch dentro del mismo array preserva orden y hace splice OK.
//   • Move batch cross-parent junta los nodos en un solo destino.
//   • Sin sources → null.
//   • sources con niveles mezclados → aborta (return null).
//   • Un solo source → delega a moveNode (path equivalente).
//   • Selección resultante apunta al primer nodo movido.

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const src = await readFile(`${repoRoot}src/stores/editor.ts`, 'utf-8')

function pick(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`no se pudo extraer ${name}`)
  return m[0]
}
const levelFn = pick('levelOfArrayPath', /^function levelOfArrayPath\([\s\S]*?^}/m)
const moveNodesFn = pick('moveNodes', /^export function moveNodes\([\s\S]*?^}/m)

// Stubs mínimos del "state + helpers" que moveNodes toca. NO importamos
// editor.ts entero porque arrastra Vue/reactivity — el objetivo es probar la
// mecánica pura de indices/splice/undo/selection.
const combined = `
const undoLog = []
export const state = {
  site: { sections: [] },
  selectedPath: null,
  selectedPaths: [],
  lockedIds: [],
}
export function getAtPath(path) {
  if (!path) return null
  const parts = path.split('.')
  let cur = state.site
  for (const p of parts) {
    if (cur == null) return null
    cur = cur[p]
  }
  return cur
}
export function pushUndo() { undoLog.push({}) }
export function markDirty() {}
export function flashPasteHint() {}
${levelFn}
export function moveNode() { return null } // stub: moveNodes de 1 elemento delega aquí
${moveNodesFn}
export function undoCount() { return undoLog.length }
`
const out = await transform(combined, { loader: 'ts', format: 'esm' })
const tmp = await mkdtemp(join(tmpdir(), 'move-nodes-'))
const file = join(tmp, 'mn.mjs')
await writeFile(file, out.code)
const mod = await import(`file://${file}?t=${Date.now()}`)

function makeSite() {
  return {
    sections: [
      { layers: [{ elements: [
        { id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' },
      ] }] },
      { layers: [{ elements: [
        { id: 'X' }, { id: 'Y' },
      ] }] },
    ],
  }
}

// 1) Multi-move dentro del mismo array: B y D del layer 0.0 → al final del mismo
mod.state.site = makeSite()
const dstA = 'sections.0.layers.0.elements'
const r1 = mod.moveNodes(
  ['sections.0.layers.0.elements.1', 'sections.0.layers.0.elements.3'],
  dstA,
  4,
)
const arr1 = mod.getAtPath(dstA)
assert.deepEqual(arr1.map((n) => n.id), ['A', 'C', 'B', 'D'], 'orden final same-array')
assert.equal(mod.state.selectedPaths.length, 2, 'primary + set siguen al grupo')

// 2) Cross-parent multi-move: A y X del section.0 y section.1 al layer 0 del section 1
mod.state.site = makeSite()
const dstB = 'sections.1.layers.0.elements'
mod.moveNodes(
  ['sections.0.layers.0.elements.0', 'sections.1.layers.0.elements.0'],
  dstB,
  2,
)
const arr0 = mod.getAtPath('sections.0.layers.0.elements')
const arr2 = mod.getAtPath(dstB)
// A se removió de section.0; X se removió y reinsertó en section.1
assert.deepEqual(arr0.map((n) => n.id), ['B', 'C', 'D'])
assert.deepEqual(arr2.map((n) => n.id), ['Y', 'A', 'X'], 'A y X insertados en orden')

// 3) sources vacío → null
mod.state.site = makeSite()
assert.equal(mod.moveNodes([], dstA, 0), null)

// 4) sources con niveles mezclados (una section + un element) → null, nada cambia
mod.state.site = makeSite()
const before = JSON.stringify(mod.state.site)
const r4 = mod.moveNodes(
  ['sections.0', 'sections.0.layers.0.elements.1'],
  dstA,
  0,
)
assert.equal(r4, null, 'niveles mezclados abortan')
assert.equal(JSON.stringify(mod.state.site), before, 'sin efectos colaterales')

// 5) Un solo source delega a moveNode (que devuelve null en el stub) — no crash
mod.state.site = makeSite()
mod.moveNodes(['sections.0.layers.0.elements.0'], dstA, 0)

// 6) Un solo pushUndo por batch: prep un batch de 2 y ver que undoLog crece 1
mod.state.site = makeSite()
const before6 = mod.undoCount()
mod.moveNodes(
  ['sections.0.layers.0.elements.0', 'sections.0.layers.0.elements.1'],
  dstA,
  4,
)
assert.equal(mod.undoCount() - before6, 1, 'un solo pushUndo por batch')

console.log('✓ moveNodes multi-drag OK')
await rm(tmp, { recursive: true, force: true }).catch(() => {})
