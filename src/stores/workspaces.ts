import { reactive, computed } from 'vue'
import { workspaceApi, type Workspace } from '../composables/useApi'

export type { Workspace }

// ─── Workspaces store (Fase 2) ──────────────────────────────────────────────────
//
// localStorage is the CANONICAL client source of truth:
//   parallax-editor:workspaces        → Workspace[] (the whole list)
//   parallax-editor:active-workspace  → the active workspace id
//
// On boot, if there are NO workspaces yet, we SEED two defaults (Eventos /
// Portafolio) fetched from the host (which resolves their absolute repoPaths)
// so the existing edit flow keeps working byte-for-byte. The active workspace
// is then ACTIVATED on the host (POST /api/workspace/activate) so the server's
// :ws routes resolve to the right repo + contentRoot.

const WORKSPACES_KEY = 'parallax-editor:workspaces'
const ACTIVE_KEY = 'parallax-editor:active-workspace'
const SEED_VERSION_KEY = 'parallax-editor:seed-version'

// Bump this whenever the SEEDED defaults change so an existing localStorage gets
// reconciled ONCE per version (see reconcileSeedDefaults). v2: split the two
// seeds onto their correct buckets (eventos → daniela-reyes-eventos, portafolio
// → daniela-reyes-site + publishManifest) after some installs ended up with
// both seeds pointing at the same bucket. v3: el sitio se simplificó a
// estructura PLANA → el workspace 'site' pasa de contentRoot 'content/portafolio'
// a 'content' y publishManifest false (ya no hay catálogo).
const SEED_VERSION = 3

interface WorkspacesState {
  list: Workspace[]
  activeId: string | null
  loaded: boolean
  // Host git configured? Drives the "configura git" banner.
  gitConfigured: boolean | null
}

export const wsState = reactive<WorkspacesState>({
  list: [],
  activeId: null,
  loaded: false,
  gitConfigured: null,
})

export const activeWorkspace = computed<Workspace | null>(() =>
  wsState.list.find((w) => w.id === wsState.activeId) || null,
)

function readList(): Workspace[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist() {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(wsState.list))
    if (wsState.activeId) localStorage.setItem(ACTIVE_KEY, wsState.activeId)
  } catch {
    /* quota / unavailable — non-fatal */
  }
}

function readSeedVersion(): number {
  try {
    const raw = localStorage.getItem(SEED_VERSION_KEY)
    const n = raw ? parseInt(raw, 10) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * One-shot reconciliation of the SEEDED workspaces against the host defaults
 * (Arreglo 3). The seed only ran with an EMPTY list, so an install whose
 * localStorage was created before a seed change (e.g. both seeds pointing at the
 * same bucket) never self-corrected. Here, if the stored seed version is behind
 * the current SEED_VERSION, we fetch GET /api/workspaces/defaults and, ONLY for
 * the workspaces whose id exists in defaults (the seeded 'eventos'/'site'),
 * overwrite their CANONICAL fields (repoPath, contentRoot, s3.bucket/region/
 * publishManifest) to match the default. User-created workspaces (ids not in
 * defaults) are NEVER touched, nothing is deleted, and the seed version is then
 * persisted so this runs at most once per version bump. Mutates `list` in place
 * and returns it.
 */
async function reconcileSeedDefaults(list: Workspace[]): Promise<Workspace[]> {
  if (!list.length) return list
  if (readSeedVersion() >= SEED_VERSION) return list
  let defaults: Workspace[] = []
  try {
    const r = await workspaceApi.defaults()
    if (r?.ok && Array.isArray(r.workspaces)) defaults = r.workspaces
  } catch {
    // Host unreachable — DON'T bump the version, so we retry the reconcile on a
    // later load once the host is up.
    return list
  }
  const byId = new Map(defaults.map((d) => [d.id, d]))
  const fixed: string[] = []
  for (const w of list) {
    const def = byId.get(w.id)
    if (!def) continue // user-created workspace → never touch.
    const before = JSON.stringify({ repoPath: w.repoPath, contentRoot: w.contentRoot, s3: w.s3 })
    // Overwrite ONLY the canonical fields to the seed's values. Keep the user's
    // chosen name and any gitRemote untouched.
    w.repoPath = def.repoPath
    w.contentRoot = def.contentRoot
    if (def.s3) {
      w.s3 = {
        // Preserve the user's enabled toggle if they had one; otherwise default.
        enabled: w.s3?.enabled ?? def.s3.enabled,
        bucket: def.s3.bucket,
        prefix: w.s3?.prefix ?? def.s3.prefix,
        region: def.s3.region,
        publishManifest: def.s3.publishManifest,
      }
    }
    const after = JSON.stringify({ repoPath: w.repoPath, contentRoot: w.contentRoot, s3: w.s3 })
    if (before !== after) fixed.push(w.id)
  }
  try {
    localStorage.setItem(SEED_VERSION_KEY, String(SEED_VERSION))
  } catch {
    /* quota / unavailable — non-fatal */
  }
  if (fixed.length) {
    // eslint-disable-next-line no-console
    console.log(
      `[workspaces] Reconciliación de seed v${SEED_VERSION}: se corrigieron los workspaces sembrados [${fixed.join(', ')}] a su configuración canónica (repoPath/contentRoot/bucket/region/publishManifest).`,
    )
  }
  return list
}

/**
 * Load workspaces from localStorage. If empty, SEED the two defaults from the
 * host (resolved absolute repoPaths). Otherwise run a one-shot reconciliation of
 * the seeded workspaces against the host defaults (Arreglo 3). Also reads the
 * git-config status for the setup banner. Idempotent (safe to call repeatedly).
 */
export async function loadWorkspaces(): Promise<void> {
  let list = readList()
  if (!list.length) {
    try {
      const r = await workspaceApi.defaults()
      if (r?.ok && Array.isArray(r.workspaces)) list = r.workspaces
    } catch {
      /* host unreachable — leave empty; UI shows "crea un workspace" */
    }
    // A fresh seed is already canonical → mark the seed version so the
    // reconcile path never runs for a just-seeded install.
    try { localStorage.setItem(SEED_VERSION_KEY, String(SEED_VERSION)) } catch { /* non-fatal */ }
  } else {
    list = await reconcileSeedDefaults(list)
  }
  wsState.list = list
  const savedActive = (() => {
    try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
  })()
  wsState.activeId =
    (savedActive && list.some((w) => w.id === savedActive) ? savedActive : null) ||
    (list[0]?.id ?? null)
  wsState.loaded = true
  persist()
  // git config status (best-effort).
  try {
    const g = await workspaceApi.gitConfigStatus()
    wsState.gitConfigured = !!g?.configured
  } catch {
    wsState.gitConfigured = null
  }
}

/**
 * Make a workspace active (locally) and activate it on the HOST so the server
 * resolves :ws routes to its repo + contentRoot. Returns the host result.
 */
export async function selectWorkspace(id: string) {
  const ws = wsState.list.find((w) => w.id === id)
  if (!ws) return { ok: false, error: 'Workspace no encontrado.' }
  wsState.activeId = id
  persist()
  return activateActiveWorkspace()
}

/** Re-send the ACTIVE workspace config to the host (validate + cache). */
export async function activateActiveWorkspace() {
  const ws = activeWorkspace.value
  if (!ws) return { ok: false, error: 'No hay workspace activo.' }
  try {
    return await workspaceApi.activate(ws)
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo activar el workspace.' }
  }
}

/** Generate a stable kebab-ish id from a name, unique within the list. */
export function makeWorkspaceId(name: string): string {
  const base =
    (name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  let id = base
  let n = 2
  while (wsState.list.some((w) => w.id === id)) {
    id = `${base}-${n}`
    n++
  }
  return id
}

/** Add a new workspace and persist. Does NOT activate it. Returns the id. */
export function addWorkspace(ws: Omit<Workspace, 'id'> & { id?: string }): string {
  const id = ws.id && !wsState.list.some((w) => w.id === ws.id) ? ws.id : makeWorkspaceId(ws.name)
  wsState.list.push({ ...ws, id })
  persist()
  return id
}

/** Update an existing workspace in place and persist. */
export function updateWorkspace(id: string, patch: Partial<Workspace>) {
  const i = wsState.list.findIndex((w) => w.id === id)
  if (i < 0) return
  wsState.list[i] = { ...wsState.list[i], ...patch, id }
  persist()
  // If we edited the active workspace, re-activate so the host picks up changes.
  if (id === wsState.activeId) void activateActiveWorkspace()
}

/** Remove a workspace. If it was active, fall back to the first remaining. */
export function removeWorkspace(id: string) {
  wsState.list = wsState.list.filter((w) => w.id !== id)
  if (wsState.activeId === id) {
    wsState.activeId = wsState.list[0]?.id ?? null
  }
  persist()
}
