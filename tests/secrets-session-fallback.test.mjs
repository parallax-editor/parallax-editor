// Unit test del fallback de sesión de `useSecrets` (cuando no hay Electron /
// safeStorage). Verifica el contrato:
//
//   • set/get/delete/list son round-trippable contra sessionStorage cifrado.
//   • El plaintext NUNCA aparece en sessionStorage (validación crítica para no
//     dejar tokens visibles si alguien inspecciona DevTools).
//   • Una "recarga de pestaña" (clave en memoria cambia) invalida los secretos
//     viejos — la decodificación falla silenciosa y `get` devuelve null.
//
// Estrategia: cargamos el TS del composable vía esbuild en un entorno
// preparado con stubs mínimos de `window`, `sessionStorage`, `crypto.subtle`
// (provistos por Node 20+).

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import assert from 'node:assert/strict'

// ── Stubs globales mínimos para que el composable corra fuera del navegador ──
class SessionStorage {
  constructor() {
    this.store = Object.create(null)
  }
  get length() { return Object.keys(this.store).length }
  key(i) { return Object.keys(this.store)[i] ?? null }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null }
  setItem(k, v) { this.store[k] = String(v) }
  removeItem(k) { delete this.store[k] }
  clear() { this.store = Object.create(null) }
}

const ss = new SessionStorage()
globalThis.sessionStorage = ss
// `globalThis.crypto` ya es webcrypto en Node 20+/26+; es property-readonly en
// Node 26 — solo lo asignamos si no existía (Node viejo). En cualquier caso
// importamos webcrypto explícitamente arriba para asegurar disponibilidad.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
// Sin Electron preload: `window.parallax.secrets` no existe → fallback de sesión.
// `globalThis` actúa como window.
delete globalThis.parallax

// ── Cargamos el TS del composable ───────────────────────────────────────────
const repoRoot = new URL('..', import.meta.url).pathname
const src = await readFile(`${repoRoot}src/composables/useSecrets.ts`, 'utf-8')
const out = await transform(src, { loader: 'ts', format: 'esm' })
const tmp = await mkdtemp(join(tmpdir(), 'secrets-fallback-test-'))
const file = join(tmp, 'useSecrets.mjs')
await writeFile(file, out.code)
const { useSecrets, secretKeys, __resetSecretsStateForTests, __resetSecretsBackendCacheForTests } = await import(`file://${file}?t=${Date.now()}`)
// El alias debe existir para que tests externos viejos no rompan.
assert.equal(typeof __resetSecretsBackendCacheForTests, 'function', 'alias para compat de tests viejos')

// ── Smoke: backend resuelto a 'session' ─────────────────────────────────────
const api = useSecrets()
const backend = await api.backend()
assert.equal(backend, 'session', 'sin Electron → backend session')

// ── set/get round-trip ──────────────────────────────────────────────────────
const KEY = secretKeys.s3('test-workspace')
const PLAINTEXT = JSON.stringify({ accessKeyId: 'AKIA…', secretAccessKey: 'super-secret/value+chars=' })
const r1 = await api.set(KEY, PLAINTEXT)
assert.equal(r1.ok, true, 'set debe responder ok')
const r2 = await api.get(KEY)
assert.equal(r2.ok, true, 'get debe responder ok')
assert.equal(r2.value, PLAINTEXT, 'get debe devolver el mismo plaintext')

// ── CRÍTICO: el plaintext NO debe aparecer en sessionStorage ────────────────
// Esto es la garantía de seguridad: si alguien abre DevTools y mira el storage
// solo ve el ciphertext base64, nunca el access key real.
let foundPlaintext = false
for (let i = 0; i < ss.length; i++) {
  const k = ss.key(i)
  const v = ss.getItem(k)
  if (v && v.includes('AKIA')) { foundPlaintext = true; break }
  if (v && v.includes('super-secret')) { foundPlaintext = true; break }
}
assert.equal(foundPlaintext, false, 'plaintext NO debe estar en sessionStorage')

// ── delete elimina el secreto ───────────────────────────────────────────────
const r3 = await api.delete(KEY)
assert.equal(r3.ok, true, 'delete debe responder ok')
const r4 = await api.get(KEY)
assert.equal(r4.value, null, 'tras delete, get devuelve null')

// ── list devuelve las keys (sin valores) ────────────────────────────────────
await api.set(secretKeys.s3('a'), 'va')
await api.set(secretKeys.git('b'), 'vb')
const r5 = await api.list()
assert.equal(r5.ok, true, 'list debe responder ok')
assert.deepEqual(
  new Set(r5.keys),
  new Set(['s3:a', 'git:b']),
  'list expone exactamente las keys guardadas (sin prefijo interno)',
)

// ── Helpers setJson/getJson ─────────────────────────────────────────────────
const payload = { user: 'alice', token: 'ghp_xxxx' }
await api.setJson(secretKeys.git('repo1'), payload)
const back = await api.getJson(secretKeys.git('repo1'))
assert.deepEqual(back, payload, 'setJson/getJson round-trip preserva el objeto')

const missing = await api.getJson('git:nope')
assert.equal(missing, null, 'getJson sobre key inexistente → null')

// ── Recarga de pestaña (camino A — re-import del módulo) ─────────────────────
// El re-import da un módulo fresco con `let`s nuevos: backend cache, sessionKey
// y promesa, todo virgen. Es el escenario del navegador real al recargar pestaña.
__resetSecretsStateForTests() // limpieza explícita; el re-import también la fuerza por sí solo
const out2 = await transform(src, { loader: 'ts', format: 'esm' })
const file2 = join(tmp, 'useSecrets-2.mjs')
await writeFile(file2, out2.code)
const reloaded = await import(`file://${file2}?t=${Date.now()}-r`)
const api2 = reloaded.useSecrets()

// El sessionStorage sigue intacto del lado anterior. Probamos el get:
const stale = await api2.get(secretKeys.s3('a'))
assert.equal(stale.ok, true, 'get sobre secreto con clave vieja no debe explotar')
assert.equal(stale.value, null, 'get con clave de sesión nueva devuelve null (decrypt falla)')

// El blob inservible debe haberse limpiado para no dejarlo en el storage:
let stillThere = false
for (let i = 0; i < ss.length; i++) {
  if (ss.key(i) === 'parallax-editor:session-secret:s3:a') { stillThere = true; break }
}
assert.equal(stillThere, false, 'el blob de la sesión anterior se descarta tras un decrypt fallido')

// ── Recarga de pestaña (camino B — solo helper, mismo módulo) ────────────────
// Validamos que el helper SOLO (sin re-import) basta para forzar una sessionKey
// fresca. Sin esta garantía, un test que NO re-importa podría seguir leyendo
// secretos del test anterior porque la clave estaba cacheada en el módulo.
__resetSecretsStateForTests()
// Tras el reset, set + get del MISMO módulo debe seguir funcionando — la clave
// se regenera transparentemente.
const r6 = await api.set(secretKeys.s3('post-reset'), 'whatever')
assert.equal(r6.ok, true, 'set tras __resetSecretsStateForTests sigue funcionando con clave nueva')
const r7 = await api.get(secretKeys.s3('post-reset'))
assert.equal(r7.value, 'whatever', 'get tras reset round-tripea con la clave fresca')
// Y un secreto guardado ANTES del reset (que sobrevivió en sessionStorage)
// queda inservible — no se puede decodificar con la clave nueva.
const orphan = await api.get(secretKeys.git('b'))
assert.equal(orphan.value, null, 'secreto pre-reset con clave nueva → null (decrypt falla)')

console.log('✓ secrets session-fallback contract OK')
await rm(tmp, { recursive: true, force: true }).catch(() => {})
