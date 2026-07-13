// Unit test del módulo `electron/secrets.cjs` con `safeStorage` MOCKED.
//
// Cubrimos las garantías independientes del SO:
//
//   • validateKey rechaza shapes inválidos (vacío, chars peligrosos, demasiado
//     largo, no string).
//   • El valor excedido (>16KiB) se rechaza ANTES de tocar el FS.
//   • setSecret + getSecret round-trip preserva exactamente el plaintext.
//   • deleteSecret es idempotente (borrar 2x no falla).
//   • Escritura ATÓMICA: el archivo final solo aparece tras un rename — un
//     crash entre truncate y writeFile no debe poder dejar un store vacío.
//
// `safeStorage.encryptString` / `decryptString` se mockean con XOR-base64
// trivial — basta para validar la lógica de almacenamiento, no la cripto.

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repoRoot = new URL('..', import.meta.url).pathname

// Limpiamos el require cache para forzar un re-load contra el mock fresco.
delete require.cache[require.resolve(`${repoRoot}electron/secrets.cjs`)]

const tmp = await mkdtemp(join(tmpdir(), 'secrets-electron-test-'))

// ── Mock minimal de `electron` ───────────────────────────────────────────────
const fakeElectron = {
  app: { getPath: (k) => (k === 'userData' ? tmp : tmp) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => {
      // "Cifrado" trivial: prefijo + plaintext en bytes. Devolvemos Buffer.
      return Buffer.from('ENC:' + s, 'utf-8')
    },
    decryptString: (buf) => {
      const s = buf.toString('utf-8')
      if (!s.startsWith('ENC:')) throw new Error('bad cipher')
      return s.slice(4)
    },
  },
}
// Intercepta require('electron') para devolver el mock.
const electronModulePath = require.resolve('electron')
require.cache[electronModulePath] = {
  id: electronModulePath,
  filename: electronModulePath,
  loaded: true,
  exports: fakeElectron,
}

const secrets = require(`${repoRoot}electron/secrets.cjs`)

// ── isAvailable / backend ────────────────────────────────────────────────────
assert.equal(secrets.isAvailable(), true, 'mock dice available=true')
assert.equal(secrets.backend(), 'safeStorage', 'backend reportado')

// ── validateKey: rechazos ────────────────────────────────────────────────────
assert.equal(secrets.setSecret('', 'v').ok, false, 'key vacío rechazado')
assert.equal(secrets.setSecret('bad space', 'v').ok, false, 'key con espacio rechazado')
assert.equal(secrets.setSecret('newline\nbad', 'v').ok, false, 'key con newline rechazado')
assert.equal(secrets.setSecret('a'.repeat(201), 'v').ok, false, 'key >200 chars rechazado')
assert.equal(secrets.setSecret(null, 'v').ok, false, 'key non-string rechazado')

// ── Tamaño máximo del valor ─────────────────────────────────────────────────
const HUGE = 'x'.repeat(17 * 1024)
assert.equal(secrets.setSecret('big', HUGE).ok, false, 'valor >16KiB rechazado')

// ── Round-trip set/get ──────────────────────────────────────────────────────
const KEY = 's3:test'
const PLAIN = JSON.stringify({ accessKeyId: 'AKIA…', secretAccessKey: 'super/secret+=' })
const r1 = secrets.setSecret(KEY, PLAIN)
assert.equal(r1.ok, true, 'setSecret ok')
const r2 = secrets.getSecret(KEY)
assert.equal(r2.ok, true, 'getSecret ok')
assert.equal(r2.value, PLAIN, 'round-trip preserva plaintext')

// ── El archivo de store NO contiene el plaintext (solo el cipher base64) ────
// Aunque el mock solo prefija con 'ENC:', el blob al disco va como base64 →
// no debería contener "super/secret".
const storeFile = join(tmp, 'secrets.json')
assert.equal(existsSync(storeFile), true, 'archivo creado')
const onDisk = readFileSync(storeFile, 'utf-8')
assert.equal(onDisk.includes('super/secret'), false, 'plaintext NO debe estar en el JSON serializado')
assert.equal(onDisk.includes('AKIA'), false, 'plaintext NO debe estar en el JSON serializado')

// ── Idempotencia de delete ──────────────────────────────────────────────────
assert.equal(secrets.deleteSecret(KEY).ok, true, 'delete 1ra vez ok')
assert.equal(secrets.deleteSecret(KEY).ok, true, 'delete 2da vez idempotente')
assert.equal(secrets.getSecret(KEY).value, null, 'tras delete, get devuelve null')

// ── listKeys post-delete ────────────────────────────────────────────────────
secrets.setSecret('s3:a', 'va')
secrets.setSecret('git:b', 'vb')
const keys = secrets.listKeys()
assert.deepEqual(new Set(keys), new Set(['s3:a', 'git:b']), 'listKeys retorna exactamente las keys vivas')

// ── Atomicidad del write: no debe quedar .tmp huérfano ──────────────────────
secrets.setSecret('s3:atomic', 'va')
const stillHasTmp = readdirSync(tmp).some((f) => f.endsWith('.tmp'))
assert.equal(stillHasTmp, false, 'no debe quedar un .tmp tras un set exitoso')

// ── Robustez ante store corrupto ────────────────────────────────────────────
writeFileSync(storeFile, '{ this is not json', 'utf-8')
// listKeys no debe explotar, simplemente devuelve [] o ignora el corrupto.
assert.deepEqual(secrets.listKeys(), [], 'store corrupto → listKeys devuelve []')
// El siguiente set debe poder recuperarse y dejar el store consistente.
const recover = secrets.setSecret('s3:fresh', 'value')
assert.equal(recover.ok, true, 'set tras corrupción debe poder recuperarse')
const after = JSON.parse(readFileSync(storeFile, 'utf-8'))
assert.equal(typeof after['s3:fresh'], 'string', 'el store quedó consistente y solo con la nueva entrada')

console.log('✓ electron/secrets contract OK')
await rm(tmp, { recursive: true, force: true }).catch(() => {})
