// ─── Host-side workspace registry ──────────────────────────────────────────────
//
// A workspace is an absolute git repo path + a content root (relative, e.g.
// `content` or `content/portafolio`) + optional S3 config.
//
// CANONICAL SOURCE OF TRUTH = the CLIENT (localStorage). The host does NOT
// persist workspaces to disk; instead the client POSTs the active workspace's
// config to /api/workspace/activate, and the host VALIDATES + CACHES it here in
// memory (a Map keyed by workspace id). Every request takes a workspace id and
// resolves repoPath/contentRoot through this cache.
//
// The editor ships with NO default workspaces: a fresh install starts empty and
// the user adds workspaces from the UI.

import { statSync, accessSync, existsSync, mkdirSync, constants } from 'fs'
import { resolve, isAbsolute } from 'path'

// Preset que describe el "patrón" del workspace. Mapea 1:1 con los presets del
// módulo Nuxt del engine (`@parallax-editor/parallax-engine/nuxt`):
//
//   - `linked-home`  → portafolio público. El slug `home` se renderiza en `/`,
//                      los demás son sub-sitios enlazables via link.site.
//                      Catálogo público → `s3.publishManifest` default true.
//   - `multi-tenant` → invitaciones / eventos por URL directa. Cada slug es un
//                      sitio aislado. Sin catálogo → publishManifest default
//                      false; se exige og:image para WhatsApp.
//
// Default es `multi-tenant` por back-compat: los workspaces existentes en
// localStorage no pasan a tener un `home` pineado de la nada.
export type WorkspacePreset = 'linked-home' | 'multi-tenant'

// S3 publish target for a workspace (Fase 3). All optional / additive.
export interface WorkspaceS3 {
  enabled: boolean
  bucket: string
  prefix: string
  region: string
  /**
   * If true, publishing a slug also regenerates and uploads
   * `<contentRoot>/manifest.json` (the catalog list) to S3, so a new world
   * appears in the public site's catalog WITHOUT a rebuild. Only enable for
   * "public catalog" workspaces — keep off for private/per-URL workspaces
   * whose slugs must not be enumerated publicly.
   *
   * El default DERIVADO del preset se calcula en `presetPublishManifestDefault()`
   * abajo, pero solo se aplica cuando el cliente NO ha marcado este campo
   * explícitamente (ver `publishManifestUserSet`).
   */
  publishManifest?: boolean
  /**
   * Marca si el usuario tocó explícitamente `publishManifest` desde la UI.
   * Cuando es true, respetamos su valor; cuando es false/undefined, aplicamos
   * el default del preset. Lo necesitamos porque sin él no podemos distinguir
   * "el usuario quiere off" de "nunca lo tocó".
   */
  publishManifestUserSet?: boolean
  /**
   * Modo de autenticación con S3:
   *   - 'system'   → la SDK usa la cadena por defecto (~/.aws, env, SSO). Es el
   *                  comportamiento histórico y queda como default por back-compat.
   *   - 'explicit' → el cliente manda accessKeyId/secretAccessKey por request
   *                  (resueltos en runtime desde el SecretsBus / Keychain del SO).
   *                  Las credenciales NUNCA se guardan en este objeto ni en el
   *                  cache del host — solo viajan dentro de un request HTTP local.
   */
  credentialsMode?: 'system' | 'explicit'
}

/**
 * Forma del par de credenciales que el cliente puede mandar por request al
 * publicar a S3 cuando `credentialsMode === 'explicit'`. Compartido entre
 * `s3.ts`, `publish.ts` y la API. NO se persiste en ningún workspace cache.
 */
export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Configuración de autenticación Git por workspace (Fase 4). Mismo contrato que
 * S3:
 *   - 'system' → el editor usa la auth del sistema (SSH key, osxkeychain,
 *                credential helper que el usuario ya configuró). Default y
 *                comportamiento histórico.
 *   - 'pat'    → el editor inyecta un Personal Access Token via GIT_ASKPASS
 *                solo durante el push. El token vive en el SecretsBus
 *                (Keychain), nunca aquí.
 * El `provider` es informativo (drive del help modal con instrucciones por
 * plataforma); el token funciona igual con cualquier host HTTPS.
 */
export interface WorkspaceGit {
  authMode?: 'system' | 'pat'
  provider?: 'github' | 'gitlab' | 'bitbucket'
}

/**
 * Forma del PAT que el cliente puede mandar por request al hacer push cuando
 * `git.authMode === 'pat'`. NUNCA se persiste en el workspace cache; viaja
 * solo en el body del request HTTP local.
 */
export interface GitCredentials {
  username: string
  token: string
}

// One workspace as sent by the client. `id` is a stable client-generated key.
export interface Workspace {
  id: string
  name: string
  /** Absolute path to the git repo on this machine. */
  repoPath: string
  /** Optional git remote URL (informational; clone uses it). */
  gitRemote?: string
  /** Content root RELATIVE to repoPath, e.g. 'content' | 'content/portafolio'. */
  contentRoot: string
  s3?: WorkspaceS3
  /**
   * Does the workspace use git? Default true. If false: the folder does NOT
   * need to be a git repo, Save only writes to disk (no commit), and Publish
   * uploads to S3 only (no push) — or is disabled if S3 isn't configured.
   */
  useGit?: boolean
  /**
   * Patrón del workspace. Drives "home pineado" en el selector, copy ("evento"
   * vs "sitio"), defaults de S3.publishManifest, y el warning de og:image al
   * publicar en multi-tenant. Default: `multi-tenant` (back-compat con
   * workspaces existentes en localStorage que no traen este campo).
   */
  preset?: WorkspacePreset
  /** Configuración de Git por workspace (Fase 4). Opcional / back-compat. */
  git?: WorkspaceGit
}

/** Default de `publishManifest` cuando el usuario no lo tocó explícitamente. */
export function presetPublishManifestDefault(preset: WorkspacePreset | undefined): boolean {
  return preset === 'linked-home'
}

// In-memory cache of workspaces the client has activated this process.
const activated = new Map<string, Workspace>()

/**
 * The editor ships with no default workspaces. The client seeds an empty list;
 * the user adds workspaces from the UI. Kept as an exported function so the
 * `/api/workspaces/defaults` endpoint can remain stable.
 */
export function defaultWorkspaces(): Workspace[] {
  return []
}

export interface ActivateResult {
  ok: boolean
  /** Spanish error explaining why the workspace was rejected (UI surfaces it). */
  error?: string
  workspace?: Workspace
}

/**
 * Normalize + VALIDATE a workspace config sent by the client, then CACHE it.
 * Validation (all hard requirements):
 *  - repoPath is an absolute path that exists and is a directory,
 *  - it is a git repo (has a `.git` entry),
 *  - the contentRoot exists inside it.
 * On any failure returns { ok:false, error } and does NOT cache.
 */
export function activateWorkspace(raw: any): ActivateResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Configuración de workspace inválida.' }
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return { ok: false, error: 'Falta el id del workspace.' }
  const repoPath = typeof raw.repoPath === 'string' ? raw.repoPath : ''
  if (!repoPath || !isAbsolute(repoPath)) {
    return { ok: false, error: 'La carpeta del repositorio debe ser una ruta absoluta.' }
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    return { ok: false, error: `La carpeta no existe: ${repoPath}` }
  }
  // git opcional: por defecto true (seeds + back-compat). Solo exigimos `.git`
  // cuando el workspace usa git; un workspace "solo disco / S3" puede ser
  // cualquier carpeta.
  const useGit = raw.useGit !== false
  if (useGit && !existsSync(resolve(repoPath, '.git'))) {
    return {
      ok: false,
      error: 'La carpeta no es un repositorio git (falta .git). Si no quieres usar git, desactiva "Usar control de versiones (git)" en la configuración del workspace.',
    }
  }
  const contentRoot = typeof raw.contentRoot === 'string' && raw.contentRoot.trim()
    ? raw.contentRoot.trim().replace(/^\/+|\/+$/g, '')
    : 'content'
  // Containment + existence: contentRoot must resolve INSIDE repoPath and exist.
  if (contentRoot.split(/[\\/]/).some((seg: string) => seg === '..')) {
    return { ok: false, error: 'El contentRoot no puede salir del repositorio.' }
  }
  const contentAbs = resolve(repoPath, contentRoot)
  if (!contentAbs.startsWith(repoPath)) {
    return { ok: false, error: 'El contentRoot debe estar dentro del repositorio.' }
  }
  // Si el contentRoot no existe (p.ej. un workspace solo-disco recién creado en
  // una carpeta vacía), lo creamos. El guard de contención de arriba garantiza
  // que resuelve DENTRO de repoPath, así que el mkdir nunca escapa del repo.
  if (!existsSync(contentAbs)) {
    try {
      mkdirSync(contentAbs, { recursive: true })
    } catch (e: any) {
      return { ok: false, error: `No se pudo crear la carpeta de contenido (${contentRoot}): ${e?.message || ''}` }
    }
  }

  // Preset: enum validado; cualquier valor desconocido cae a 'multi-tenant'
  // (back-compat con workspaces existentes en localStorage que no traen este
  // campo y con clientes viejos).
  const preset: WorkspacePreset =
    raw.preset === 'linked-home' ? 'linked-home' : 'multi-tenant'

  let s3: WorkspaceS3 | undefined
  if (raw.s3 && typeof raw.s3 === 'object') {
    // publishManifest: prioridad de fuentes para evitar pisar la elección del
    // usuario en un upgrade silencioso:
    //   1. Si el cliente marca `publishManifestUserSet:true` → su `publishManifest`
    //      es la fuente de verdad (incluso si va contra el default del preset).
    //   2. BACK-COMPAT: si el flag no viene PERO `publishManifest` está
    //      explícitamente seteado como boolean en el localStorage de un cliente
    //      legacy (pre-feature), tratamos eso como intención del usuario para
    //      NO pisar su elección. El upgrade promueve el flag a true.
    //   3. Si no hay nada del usuario, aplicamos el default DERIVADO del preset.
    const userSet =
      raw.s3.publishManifestUserSet === true ||
      typeof raw.s3.publishManifest === 'boolean'
    const publishManifest = userSet
      ? raw.s3.publishManifest === true
      : presetPublishManifestDefault(preset)
    // credentialsMode: enum 'system'|'explicit'; cualquier otra cosa o ausencia
    // cae a 'system' (back-compat).
    const credentialsMode: 'system' | 'explicit' =
      raw.s3.credentialsMode === 'explicit' ? 'explicit' : 'system'
    s3 = {
      enabled: raw.s3.enabled === true,
      bucket: typeof raw.s3.bucket === 'string' ? raw.s3.bucket : '',
      prefix: typeof raw.s3.prefix === 'string' ? raw.s3.prefix.replace(/^\/+|\/+$/g, '') : '',
      region: typeof raw.s3.region === 'string' && raw.s3.region ? raw.s3.region : 'us-east-1',
      publishManifest,
      publishManifestUserSet: userSet,
      credentialsMode,
    }
  }

  // git.authMode / provider: validados y cacheados. El token NO viene aquí —
  // viaja por request en el body cuando aplica. Cualquier intento de colarlo
  // a través del cache se descarta silenciosamente.
  let gitCfg: WorkspaceGit | undefined
  if (raw.git && typeof raw.git === 'object') {
    const authMode: 'system' | 'pat' = raw.git.authMode === 'pat' ? 'pat' : 'system'
    const provider =
      raw.git.provider === 'github' || raw.git.provider === 'gitlab' || raw.git.provider === 'bitbucket'
        ? raw.git.provider
        : undefined
    gitCfg = { authMode, provider }
  }

  const ws: Workspace = {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    repoPath,
    gitRemote: typeof raw.gitRemote === 'string' ? raw.gitRemote : undefined,
    contentRoot,
    useGit,
    s3,
    preset,
    git: gitCfg,
  }
  activated.set(id, ws)
  return { ok: true, workspace: ws }
}

/**
 * Resolve a workspace by id from the activated cache. Returns null for an
 * unknown id (the client must POST /api/workspace/activate first).
 */
export function resolveWorkspace(id: string): Workspace | null {
  if (!id) return null
  return activated.get(id) || null
}

/** Absolute repo path for a workspace id, or '' if unknown. */
export function workspaceRepoPath(id: string): string {
  return resolveWorkspace(id)?.repoPath || ''
}

/**
 * Absolute content directory for a workspace id (repoPath/contentRoot), or ''.
 * Replaces the old contentDir(type).
 */
export function workspaceContentDir(id: string): string {
  const ws = resolveWorkspace(id)
  if (!ws) return ''
  return resolve(ws.repoPath, ws.contentRoot)
}

/** contentRoot (relative) for a workspace id, or '' if unknown. */
export function workspaceContentRoot(id: string): string {
  return resolveWorkspace(id)?.contentRoot || ''
}

/** Is the given path writable (parent of a clone target)? */
export function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}
