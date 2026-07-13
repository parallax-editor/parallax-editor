// ─── useSecrets — bridge tipado al SecretsBus ─────────────────────────────────
//
// Wrapper para guardar/leer secretos (credenciales S3, PAT Git, etc.) desde el
// renderer. Backend en cascada:
//
//   1. **Electron + safeStorage disponible** → `window.parallax.secrets` (IPC al
//      main, que cifra con el keychain del SO). Persiste entre reinicios. Este
//      es el camino "real".
//   2. **Web (yarn editor / dev sin Electron) o safeStorage no disponible** →
//      fallback de SESIÓN: secretos cifrados simétricamente con una clave
//      random en memoria del proceso (sessionStorage para no persistir).
//      Backend `'session'`. Al cerrar la pestaña/proceso se pierden.
//
// El composable NUNCA expone secretos en localStorage ni los manda al server
// salvo cuando explícitamente los va a usar (publish a S3 / push de Git). Los
// callers son `s3Api.publish(...)` y `gitApi.push(...)` — esos hidratan el
// secreto justo antes del fetch.
//
// Convenciones de keys (mismas que el plan + el server):
//   `s3:<workspaceId>`   → JSON { accessKeyId, secretAccessKey }
//   `git:<workspaceId>`  → JSON { username, token, provider }

export type SecretsBackend = 'safeStorage' | 'session' | null

interface NativeSecretsBridge {
  set: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>
  get: (key: string) => Promise<{ ok: boolean; value?: string | null; error?: string }>
  delete: (key: string) => Promise<{ ok: boolean; error?: string }>
  list: () => Promise<{ ok: boolean; keys?: string[] }>
  backend: () => Promise<{ ok: boolean; backend?: SecretsBackend }>
}

function nativeBridge(): NativeSecretsBridge | null {
  const w = globalThis as any
  return (w?.parallax?.secrets as NativeSecretsBridge) || null
}

// ── Fallback de SESIÓN ─────────────────────────────────────────────────────────
// Sin safeStorage no podemos persistir secretos a disco de manera segura. Lo
// menos malo es: cifrar simétricamente con una clave generada EN MEMORIA al
// arrancar la pestaña, y guardar el ciphertext en sessionStorage. Al recargar
// la pestaña se pierde la clave → los secretos quedan inservibles → no hay
// texto plano persistido en ningún momento. El usuario los pide otra vez.
//
// El cifrado simétrico usa WebCrypto AES-GCM. Si WebCrypto no está disponible
// (entorno muy viejo), caemos a "no persistir nada" y el get siempre devuelve
// null (las operaciones que dependen del secreto fallarán con mensaje claro).

const SESSION_KEY_PREFIX = 'parallax-editor:session-secret:'

let _sessionKey: CryptoKey | null = null
let _sessionKeyPromise: Promise<CryptoKey | null> | null = null

async function ensureSessionKey(): Promise<CryptoKey | null> {
  if (_sessionKey) return _sessionKey
  if (_sessionKeyPromise) return _sessionKeyPromise
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  _sessionKeyPromise = (async () => {
    try {
      const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      _sessionKey = key
      return key
    } catch {
      return null
    }
  })()
  return _sessionKeyPromise
}

function toBase64(buf: ArrayBuffer): string {
  // ArrayBuffer → base64 sin pasar por strings binarios (que rompen UTF-8).
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function sessionSet(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const k = await ensureSessionKey()
  if (!k) return { ok: false, error: 'WebCrypto no está disponible en este entorno.' }
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    // Cast a `BufferSource` explícito: las nuevas typings de DOM tightening
    // (lib >= ES2024) marcan `Uint8Array<ArrayBufferLike>` como incompatible
    // con `BufferSource` por la posibilidad teórica de SharedArrayBuffer. Aquí
    // sabemos que es ArrayBuffer normal (lo creamos arriba), pero el TS no
    // puede deducirlo; el cast es seguro y mantiene el código limpio.
    const enc = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      k,
      new TextEncoder().encode(value) as BufferSource,
    )
    const payload = JSON.stringify({ iv: toBase64(iv.buffer as ArrayBuffer), ct: toBase64(enc) })
    sessionStorage.setItem(SESSION_KEY_PREFIX + key, payload)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo cifrar el secreto.' }
  }
}
async function sessionGet(key: string): Promise<{ ok: boolean; value?: string | null; error?: string }> {
  const k = await ensureSessionKey()
  if (!k) return { ok: false, error: 'WebCrypto no está disponible en este entorno.' }
  const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + key)
  if (!raw) return { ok: true, value: null }
  try {
    const { iv, ct } = JSON.parse(raw)
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) as BufferSource },
      k,
      fromBase64(ct) as BufferSource,
    )
    return { ok: true, value: new TextDecoder().decode(dec) }
  } catch {
    // Si el ciphertext fue escrito con OTRA clave de sesión (porque el usuario
    // recargó la pestaña en el medio), el decrypt falla → el secreto se
    // descarta y devolvemos null para forzar al usuario a reingresarlo.
    sessionStorage.removeItem(SESSION_KEY_PREFIX + key)
    return { ok: true, value: null }
  }
}
function sessionDelete(key: string): Promise<{ ok: boolean }> {
  sessionStorage.removeItem(SESSION_KEY_PREFIX + key)
  return Promise.resolve({ ok: true })
}
function sessionList(): Promise<{ ok: boolean; keys: string[] }> {
  const keys: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k && k.startsWith(SESSION_KEY_PREFIX)) keys.push(k.slice(SESSION_KEY_PREFIX.length))
  }
  return Promise.resolve({ ok: true, keys })
}

// ── API pública ────────────────────────────────────────────────────────────────

// Backend resuelto perezosamente y cacheado. Lo expone `useSecrets().backend()`
// — el Doctor screen lo pinta como badge ("Keychain del Mac" / "Sesión efímera").
let _backendCache: SecretsBackend | undefined

async function resolveBackend(): Promise<SecretsBackend> {
  if (_backendCache !== undefined) return _backendCache
  const native = nativeBridge()
  if (native) {
    try {
      const r = await native.backend()
      if (r?.ok && r.backend === 'safeStorage') {
        _backendCache = 'safeStorage'
        return _backendCache
      }
    } catch { /* fallthrough */ }
  }
  // No safeStorage → fallback de sesión si WebCrypto está disponible.
  const subtle = globalThis.crypto?.subtle
  _backendCache = subtle ? 'session' : null
  return _backendCache
}

export interface SecretsApi {
  backend: () => Promise<SecretsBackend>
  set: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>
  get: (key: string) => Promise<{ ok: boolean; value?: string | null; error?: string }>
  delete: (key: string) => Promise<{ ok: boolean; error?: string }>
  list: () => Promise<{ ok: boolean; keys?: string[] }>
  /** Atajo: guarda un objeto JSON serializado bajo `key`. */
  setJson: (key: string, value: unknown) => Promise<{ ok: boolean; error?: string }>
  /** Atajo: lee y deserializa un JSON guardado bajo `key`. null si no existe o si parsea mal. */
  getJson: <T = unknown>(key: string) => Promise<T | null>
}

export function useSecrets(): SecretsApi {
  const native = nativeBridge()
  const backendFn = () => resolveBackend()
  const setFn = async (key: string, value: string) => {
    if (native) return native.set(key, value)
    return sessionSet(key, value)
  }
  const getFn = async (key: string) => {
    if (native) return native.get(key)
    return sessionGet(key)
  }
  const deleteFn = async (key: string) => {
    if (native) return native.delete(key)
    return sessionDelete(key)
  }
  const listFn = async () => {
    if (native) return native.list()
    return sessionList()
  }
  const setJson = (key: string, value: unknown) => setFn(key, JSON.stringify(value))
  const getJson = async <T = unknown>(key: string): Promise<T | null> => {
    const r = await getFn(key)
    if (!r?.ok || !r.value) return null
    try {
      return JSON.parse(r.value) as T
    } catch {
      return null
    }
  }
  return {
    backend: backendFn,
    set: setFn,
    get: getFn,
    delete: deleteFn,
    list: listFn,
    setJson,
    getJson,
  }
}

/** Convención compartida de keys — usar en TODOS los callers para no driftear. */
export const secretKeys = {
  s3: (workspaceId: string) => `s3:${workspaceId}`,
  git: (workspaceId: string) => `git:${workspaceId}`,
}

/**
 * Reset interno del estado del módulo — solo para tests que simulan recarga de
 * pestaña / cambio de entorno. Limpia TODO: cache del backend resuelto, clave
 * AES-GCM en memoria, y la promesa pendiente de derivación. Sin esto un test
 * podría "limpiar el backend" pero seguir usando la misma sessionKey del test
 * anterior y los blobs viejos seguirían descifrando — un footgun silencioso.
 */
export function __resetSecretsStateForTests() {
  _backendCache = undefined
  _sessionKey = null
  _sessionKeyPromise = null
}
// Alias mantenido por compat con tests existentes (no romper invocaciones
// antiguas si las hay). Las nuevas pruebas usan __resetSecretsStateForTests.
export const __resetSecretsBackendCacheForTests = __resetSecretsStateForTests
