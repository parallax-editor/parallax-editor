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

/**
 * Load workspaces from localStorage. If empty, SEED the two defaults from the
 * host (resolved absolute repoPaths). Also reads the git-config status for the
 * setup banner. Idempotent (safe to call repeatedly).
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
