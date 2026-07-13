// ─── SecretsBus — main-process bridge a OS Keychain via safeStorage (FASE 2) ─
//
// Centraliza el manejo de secretos del editor (credenciales S3, PAT de Git…)
// para que NUNCA toquen localStorage, ni el bundle del renderer, ni los archivos
// de workspace en disco. Cada secreto vive cifrado en `userData/secrets.json`
// usando Electron `safeStorage`, que delega en el storage del SO:
//   • macOS   → Keychain del usuario
//   • Windows → DPAPI
//   • Linux   → libsecret (gnome-keyring, kwallet…), si está disponible
//
// Limitaciones conocidas:
//   • Linux sin libsecret: safeStorage.isEncryptionAvailable() devuelve false →
//     marcamos `available:false` y el wrapper del renderer cae al fallback de
//     sesión (sessionStorage cifrado con clave en memoria). NUNCA persistimos
//     texto plano de un secreto.
//   • Web (`yarn editor` sin Electron): este módulo no se carga; el renderer
//     detecta la ausencia y opera 100% en fallback de sesión.
//
// Convención de keys (alineada con el plan de la fase):
//   `s3:<workspaceId>`  → JSON { accessKeyId, secretAccessKey }
//   `git:<workspaceId>` → JSON { username, token, provider }
//
// Tamaño máximo por secreto: 16 KiB en texto plano. Es ÷ orden de magnitud de
// lo que cabe un PAT o un access key (~64 chars). Cualquier valor mayor se
// rechaza para no usar el keychain como dump genérico.

const { safeStorage, app } = require('electron')
const fs = require('fs')
const path = require('path')

const MAX_PLAINTEXT_BYTES = 16 * 1024

// La ruta del store SE RESUELVE PEREZOSAMENTE — app.getPath('userData') no es
// válido antes de `app.whenReady()`, y este módulo se require()a en el top de
// main.cjs (antes de whenReady). Resolverlo on-demand evita un crash al boot.
let _storePath = null
function storePath() {
  if (_storePath) return _storePath
  const userData = app.getPath('userData')
  _storePath = path.join(userData, 'secrets.json')
  return _storePath
}

/**
 * Lee el archivo de secretos del disco. Si no existe, devuelve {}. NUNCA
 * descifra aquí — los valores quedan como string base64; los descifra
 * `getSecret` justo a tiempo y devuelve el plaintext.
 *
 * Manejo de corrupción: si el JSON está dañado, devolvemos {} (no se puede
 * hacer mejor sin romper el flujo del usuario). Quien quiera diagnosticar
 * tiene `listKeys` que en ese caso reportará vacío.
 */
function readStore() {
  const file = storePath()
  if (!fs.existsSync(file)) return {}
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Escribe el store de forma ATÓMICA: write a `.tmp` + rename. Sin la
 * atomicidad, un crash entre el truncate y la escritura podría dejar el archivo
 * vacío y borrar todos los secretos del usuario.
 *
 * Permisos: en POSIX hacemos chmod 0o600 (rw solo para el dueño). En Windows
 * el ACL hereda del directorio de usuario que ya es privado.
 */
function writeStore(store) {
  const file = storePath()
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
  // En POSIX el rename es atómico dentro del mismo filesystem; en Windows
  // fs.renameSync se documenta como "atomic where supported". Aceptable.
  fs.renameSync(tmp, file)
  // chmod después del rename porque `mode` del writeFileSync solo aplica al
  // crear el .tmp; el rename preserva permisos en POSIX. En Windows es no-op.
  try { fs.chmodSync(file, 0o600) } catch { /* Windows / FS sin POSIX perms */ }
}

/**
 * ¿safeStorage del SO puede cifrar/descifrar ahora? En macOS y Windows
 * típicamente sí; en Linux depende de libsecret. Lo cacheamos para no llamar
 * el bridge nativo en cada call.
 */
let _availCache = null
function isAvailable() {
  if (_availCache != null) return _availCache
  try {
    _availCache = !!safeStorage.isEncryptionAvailable()
  } catch {
    _availCache = false
  }
  return _availCache
}

function validateKey(key) {
  if (typeof key !== 'string' || !key) return 'Falta el key del secreto.'
  // Keys razonables: namespace:id estilo `s3:my-workspace`. Sin nulls/newlines.
  if (!/^[\w.:\-]+$/.test(key)) return 'El key contiene caracteres inválidos.'
  if (key.length > 200) return 'El key es demasiado largo.'
  return null
}

/** Guarda un secreto. Devuelve `{ ok, error? }`. */
function setSecret(key, value) {
  const kerr = validateKey(key)
  if (kerr) return { ok: false, error: kerr }
  if (typeof value !== 'string') {
    return { ok: false, error: 'El valor debe ser string.' }
  }
  if (Buffer.byteLength(value, 'utf-8') > MAX_PLAINTEXT_BYTES) {
    return { ok: false, error: 'El secreto excede el tamaño máximo permitido.' }
  }
  if (!isAvailable()) {
    return { ok: false, error: 'El cifrado del sistema no está disponible.' }
  }
  try {
    const cipher = safeStorage.encryptString(value)
    const store = readStore()
    store[key] = cipher.toString('base64')
    writeStore(store)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** Lee un secreto. Devuelve `{ ok, value? }`. Si no existe → `{ ok:true, value:null }`. */
function getSecret(key) {
  const kerr = validateKey(key)
  if (kerr) return { ok: false, error: kerr }
  if (!isAvailable()) {
    return { ok: false, error: 'El cifrado del sistema no está disponible.' }
  }
  try {
    const store = readStore()
    const blob = store[key]
    if (!blob || typeof blob !== 'string') return { ok: true, value: null }
    const buf = Buffer.from(blob, 'base64')
    const value = safeStorage.decryptString(buf)
    return { ok: true, value }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** Borra un secreto. Devuelve `{ ok }`. Idempotente (no error si no existía). */
function deleteSecret(key) {
  const kerr = validateKey(key)
  if (kerr) return { ok: false, error: kerr }
  try {
    const store = readStore()
    if (key in store) {
      delete store[key]
      writeStore(store)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * Devuelve SOLO las keys (no los valores) — para diagnóstico (mostrar cuántos
 * secretos hay guardados / qué workspaces tienen creds, sin exponer nada).
 * Si la lectura del store falla, devuelve `[]`.
 */
function listKeys() {
  try {
    return Object.keys(readStore())
  } catch {
    return []
  }
}

module.exports = {
  isAvailable,
  setSecret,
  getSecret,
  deleteSecret,
  listKeys,
  // Backend que se está usando: 'safeStorage' cuando el OS responde,
  // `null` cuando no hay cifrado disponible. El renderer lo expone en el
  // Doctor screen para que el usuario sepa dónde quedan sus secretos.
  backend: () => (isAvailable() ? 'safeStorage' : null),
}
