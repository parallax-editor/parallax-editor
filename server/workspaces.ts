// ─── Host-side workspace registry (Fase 2) ─────────────────────────────────────
//
// The editor used to HARDCODE two project "types" (eventos / site) that each
// mapped to a fixed sibling repo + content root (server/projects.ts → REPO_MAP
// / contentDir). Fase 2 de-hardcodes that into WORKSPACES: a workspace is an
// absolute git repo path + a content root (relative, e.g. `content` or
// `content/portafolio`) + optional S3 config.
//
// CANONICAL SOURCE OF TRUTH = the CLIENT (localStorage). The host does NOT
// persist workspaces to disk; instead the client POSTs the active workspace's
// config to /api/workspace/activate, and the host VALIDATES + CACHES it here in
// memory (a Map keyed by workspace id). Every request that used to take a
// `:type` now takes a workspace id and resolves repoPath/contentRoot through
// this cache.
//
// Backwards compatibility: the client seeds two default workspaces with ids
// `eventos` and `site` whose repoPath/contentRoot match the OLD hardcoded
// mapping, so the existing edit flow is byte-for-byte unchanged. The seeded ids
// being the same strings the old routes used means even a workspace that was
// never explicitly activated can fall back to the legacy resolution (see
// resolveWorkspace below).

import { existsSync, statSync, accessSync, constants } from 'fs'
import { resolve, isAbsolute } from 'path'

const BASE = process.cwd()

// S3 publish target for a workspace (Fase 3). All optional / additive.
export interface WorkspaceS3 {
  enabled: boolean
  bucket: string
  prefix: string
  region: string
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
}

// ── Legacy default workspaces (back-compat) ──────────────────────────────────
// The two seeded workspaces resolve to the same repos/roots the hardcoded
// REPO_MAP/contentDir used. Kept here so a request that arrives BEFORE the
// client activated anything (or for a stale-but-known id) still resolves.
const LEGACY_WORKSPACES: Record<string, Workspace> = {
  eventos: {
    id: 'eventos',
    name: 'Eventos',
    repoPath: resolve(BASE, '..', 'daniela-reyes-eventos'),
    contentRoot: 'content',
    s3: { enabled: true, bucket: 'daniela-reyes-eventos', prefix: '', region: 'us-east-1' },
  },
  site: {
    id: 'site',
    name: 'Portafolio',
    repoPath: resolve(BASE, '..', 'daniela-reyes-site'),
    contentRoot: 'content/portafolio',
    s3: { enabled: true, bucket: 'daniela-reyes-site', prefix: '', region: 'us-east-1' },
  },
}

// In-memory cache of workspaces the client has activated this process.
const activated = new Map<string, Workspace>()

/**
 * The two seed workspaces with ABSOLUTE repoPaths resolved on the host (the
 * client can't resolve absolute fs paths). The client uses these to SEED its
 * localStorage on first run so the existing edit flow works untouched. Only
 * the ones whose repo actually exists on disk are returned (a clean machine
 * missing a sibling repo simply won't seed that one).
 */
export function defaultWorkspaces(): Workspace[] {
  return Object.values(LEGACY_WORKSPACES).filter((w) => existsSync(w.repoPath))
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
  if (!existsSync(resolve(repoPath, '.git'))) {
    return { ok: false, error: 'La carpeta no es un repositorio git (falta .git).' }
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
  if (!existsSync(contentAbs)) {
    return { ok: false, error: `El contentRoot no existe: ${contentRoot}` }
  }

  let s3: WorkspaceS3 | undefined
  if (raw.s3 && typeof raw.s3 === 'object') {
    s3 = {
      enabled: raw.s3.enabled === true,
      bucket: typeof raw.s3.bucket === 'string' ? raw.s3.bucket : '',
      prefix: typeof raw.s3.prefix === 'string' ? raw.s3.prefix.replace(/^\/+|\/+$/g, '') : '',
      region: typeof raw.s3.region === 'string' && raw.s3.region ? raw.s3.region : 'us-east-1',
    }
  }

  const ws: Workspace = {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    repoPath,
    gitRemote: typeof raw.gitRemote === 'string' ? raw.gitRemote : undefined,
    contentRoot,
    s3,
  }
  activated.set(id, ws)
  return { ok: true, workspace: ws }
}

/**
 * Resolve a workspace by id from the activated cache, falling back to a legacy
 * default workspace (eventos/site) so the existing flow keeps working even if
 * the client hasn't POSTed an activation yet. Returns null for an unknown id.
 */
export function resolveWorkspace(id: string): Workspace | null {
  if (!id) return null
  return activated.get(id) || LEGACY_WORKSPACES[id] || null
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
