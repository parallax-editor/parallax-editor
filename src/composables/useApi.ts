const BASE = ''

// Asset kinds the upload endpoint accepts. Mirrors server `AssetKind`
// (server/projects.ts). 'font' (TASK #73) → content/<...>/fonts/, stored in
// site.json as meta.fonts[].url = "fonts/<file>".
export type UploadKind = 'image' | 'video' | 'audio' | 'font'

export async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  return res.json()
}

// One row in the project list (GET /api/projects). `updatedAt` is the
// site.json file mtime in ms — ProjectSelector sorts by it (most recent first).
export interface ProjectListItem {
  slug: string
  title: string
  updatedAt: number
}

export const projectsApi = {
  list: () => api<{ eventos: ProjectListItem[]; site: ProjectListItem[] }>('/projects'),
  get: (type: string, slug: string) => api(`/projects/${type}/${slug}`),
  save: (type: string, slug: string, data: any) =>
    api(`/projects/${type}/${slug}`, { method: 'PUT', body: JSON.stringify(data) }),
  // TASK 2: `name` is the FREE-FORM title the human typed. The server derives
  // the slug with the shared slugify() (preview === created folder) and
  // returns the FINAL slug (possibly auto-incremented on collision).
  create: (type: string, name: string) =>
    api<{ ok?: boolean; slug?: string; error?: string }>(
      `/projects/${type}`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  // `newSlug` (optional) is the name the user typed in the Spanish prompt.
  // Omitted/blank → server auto-names + auto-increments on collision.
  duplicate: (type: string, slug: string, newSlug?: string) =>
    api<{ ok?: boolean; slug?: string; error?: string }>(
      `/projects/${type}/${slug}/duplicate`,
      { method: 'POST', body: JSON.stringify(newSlug ? { newSlug } : {}) },
    ),
  delete: (type: string, slug: string) =>
    api(`/projects/${type}/${slug}`, { method: 'DELETE' }),
  // Upload an image / video / audio / font (picked from anywhere / drag&drop)
  // into the project's content dir (images/ | video/ | audio/ | fonts/, routed
  // server-side by mime, with a filename-extension fallback for fonts whose
  // mime is often a generic application/octet-stream).
  // dataUrl = FileReader.readAsDataURL result.
  // Returns { ok, src, filename, bytes, kind, warning? } — src is
  // "<subdir>/<file>" (e.g. "images/foo.png", "video/clip.mp4", "fonts/x.woff2").
  uploadAsset: (type: string, slug: string, filename: string, dataUrl: string) =>
    api<{ ok?: boolean; src?: string; filename?: string; bytes?: number; kind?: string; warning?: string; error?: string; commit?: 'ok' | 'skipped'; commitMessage?: string }>(
      `/projects/${type}/${slug}/assets`,
      { method: 'POST', body: JSON.stringify({ filename, dataUrl }) },
    ),
  // List every asset that physically exists for the project, grouped by kind
  // (image | video | audio | font). Single source of truth for the "Recursos"
  // browser AND the image/font autocomplete. Each entry: { name, kind, src,
  // bytes } where `src` is the SAME relative string stored in site.json
  // ("images/x.jpg", "fonts/x.woff2", …).
  listAssets: (type: string, slug: string) =>
    api<{ ok?: boolean; assets?: Record<ProjectAssetKind, ProjectAsset[]>; error?: string }>(
      `/projects/${type}/${slug}/assets`,
    ),
  // Delete ONE asset file. `kind` ∈ image|video|audio|font, `file` is the
  // basename. Server hard-sanitizes & keeps it inside the project; 404 if
  // missing. Returns { ok } or { error }.
  deleteAsset: (type: string, slug: string, kind: ProjectAssetKind, file: string) =>
    api<{ ok?: boolean; error?: string; commit?: 'ok' | 'skipped'; commitMessage?: string; warning?: string }>(
      `/projects/${type}/${slug}/assets/${kind}/${encodeURIComponent(file)}`,
      { method: 'DELETE' },
    ),
}

// One asset on disk as returned by GET /api/projects/:type/:slug/assets.
export type ProjectAssetKind = 'image' | 'video' | 'audio' | 'font'
export interface ProjectAsset {
  name: string
  kind: ProjectAssetKind
  /** Relative src exactly as stored in site.json ("<subdir>/<file>"). */
  src: string
  bytes: number
}

// One editable-prop schema entry as served by /api/components/:type. Mirrors
// the engine's EditableProp minus the (stripped) Vue `component` ref.
export interface EditablePropSchema {
  type: 'string' | 'number' | 'boolean' | 'select' | 'array' | 'color' | 'image'
  label: string
  options?: string[]
  default?: unknown
  itemSchema?: Record<string, EditablePropSchema>
}
export interface ComponentRegistration {
  name: string
  label: string
  description?: string
  editableProps: Record<string, EditablePropSchema>
}
export interface ComponentRegistry {
  components: Record<string, ComponentRegistration>
  error?: string
}

export const componentsApi = {
  // Discover the neighbor repo's registered custom components (serializable
  // registry only — the canvas imports the real SFCs separately). Never
  // rejects on a server-reported config error: returns {components:{},error}.
  list: (type: string) => api<ComponentRegistry>(`/components/${type}`),
}

// One commit row in the Publicar status (pending + origin/main listings).
export interface GitStatusCommit {
  hash: string
  message: string
  date: string
}
export interface GitStatus {
  ahead: number
  pending: GitStatusCommit[]
  originRecent: GitStatusCommit[]
}

export const gitApi = {
  log: (type: string) => api(`/git/${type}/log`),
  // Publicar status: ahead-count + pending-to-push commits + last 5 on
  // origin/main. Best-effort server-side (no upstream / offline → empty/0).
  status: (type: string) => api<GitStatus>(`/git/${type}/status`),
  // SECURITY: the save commit MUST be scoped to the active site's content dir.
  // The `slug` is sent so the server stages ONLY content/<slug> (eventos) or
  // content/portafolio/<slug> (site) — never a repo-wide `git add -A`.
  commit: (type: string, message: string, slug: string) =>
    api(`/git/${type}/commit`, { method: 'POST', body: JSON.stringify({ message, slug }) }),
  push: (type: string) =>
    api(`/git/${type}/push`, { method: 'POST' }),
}

export const claudeApi = {
  // Is the `claude` CLI installed/usable on this machine? The toolbar disables
  // the "Claude" button (with a Spanish tooltip) when this is false.
  status: () => api<{ available: boolean }>('/claude/status'),
  // `runId` (optional) lets the caller cancel this run via cancel(runId).
  // The server keys the spawned child by runId and kills it on cancel,
  // resolving this same call with { canceled:true } (no hang).
  // `slug` (optional) keys a CONTINUOUS Claude session for that site so
  // iterative prompts on the same site remember prior turns (TASK 1).
  // `images` (optional, TASK 3 / #67) are data URLs; the server decodes them
  // and delivers them to claude via the stream-json stdin mechanism (still
  // carrying the per-slug session flags) — no file paths are referenced.
  run: (prompt: string, cwd: string, runId?: string, slug?: string, images?: string[]) =>
    api<{ output: string; error?: string; canceled?: boolean }>('/claude', {
      method: 'POST',
      body: JSON.stringify({ prompt, cwd, runId, slug, images }),
    }),
  cancel: (runId: string) =>
    api<{ ok: boolean }>('/claude/cancel', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    }),
}
