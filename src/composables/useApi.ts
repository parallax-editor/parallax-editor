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
  // `overwrite` (recorte in situ): reemplaza el archivo con ese nombre en vez de
  // deduplicar (`-1`, `-2`). Lo usa el recorte de imagen desde Recursos.
  uploadAsset: (type: string, slug: string, filename: string, dataUrl: string, overwrite = false) =>
    api<{ ok?: boolean; src?: string; filename?: string; bytes?: number; kind?: string; warning?: string; error?: string; commit?: 'ok' | 'skipped'; commitMessage?: string }>(
      `/projects/${type}/${slug}/assets`,
      { method: 'POST', body: JSON.stringify({ filename, dataUrl, overwrite }) },
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
// the engine's EditableProp (src/config.ts) minus the (stripped) Vue
// `component` ref. The new types + metadata are ADDITIVE / backwards-compatible.
export interface EditablePropSchema {
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'select'
    | 'array'
    | 'color'
    | 'image'
    | 'textarea'
    | 'url'
    | 'range'
    | 'date'
  label: string
  /** Help copy → "?" hint icon next to the field. */
  help?: string
  /** Required → visual indicator + empty-validation highlight. */
  required?: boolean
  /** Group header the field is rendered under in PROPIEDADES. */
  group?: string
  /** Show the field only when a sibling prop `field` equals `equals`. */
  showIf?: { field: string; equals: unknown }
  options?: string[]
  default?: unknown
  /** type:'range' (and optional on 'number'): bounds + step. */
  min?: number
  max?: number
  step?: number
  /** type:'textarea': visible rows. */
  rows?: number
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
  // Diff completo de un commit (modal "ver qué se hizo commit"). `hash` debe ser
  // hex; el server lo revalida.
  show: (type: string, hash: string) =>
    api<{ ok: boolean; diff?: string; error?: string }>(
      `/git/${type}/show/${encodeURIComponent(hash)}`,
    ),
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
  // Traer cambios del remoto (menú Git → "Traer cambios"). `force` (tras confirm
  // explícito) descarta los cambios locales (reset --hard) antes del pull.
  pull: (type: string, force = false) =>
    api<{ ok: boolean; result?: string; error?: string; needsForce?: boolean }>(
      `/git/${type}/pull`,
      { method: 'POST', body: JSON.stringify({ force }) },
    ),
  // Snapshot revert (Phase 6): bring the workspace's content for ONE slug to
  // the state it had at <hash>. NOT a git revert: the files end up in the
  // working tree; the user reviews and commits with their own message via the
  // normal save flow. Safe by design — no commit, no push.
  restoreSnapshot: (type: string, hash: string, slug: string) =>
    api<{ ok: boolean; error?: string; restored?: number; removed?: number }>(
      `/git/${type}/restore-snapshot`,
      { method: 'POST', body: JSON.stringify({ hash, slug }) },
    ),
}

// ─── Workspaces (Fase 2) + S3 (Fase 3) ──────────────────────────────────────
export interface WorkspaceS3 {
  enabled: boolean
  bucket: string
  prefix: string
  region: string
  /** Regenerar+subir el manifest del catálogo al publicar (solo portafolio). */
  publishManifest?: boolean
}
export interface Workspace {
  id: string
  name: string
  /** Absolute path to the workspace folder on this machine. */
  repoPath: string
  gitRemote?: string
  /** Content root RELATIVE to repoPath ('content' | 'content/portafolio'). */
  contentRoot: string
  s3?: WorkspaceS3
  /**
   * ¿El workspace usa git? Default true (seeds eventos/site + back-compat).
   * Si es false: la carpeta NO necesita ser repo git, Guardar solo escribe en
   * disco (sin commit) y Publicar sube SOLO a S3 (sin push) — o se deshabilita
   * si no hay S3. El editor nunca ejecuta git en un workspace con useGit=false.
   */
  useGit?: boolean
}

export const workspaceApi = {
  // Host-resolved seed defaults (absolute repoPaths). Used to seed localStorage
  // on first run so the two built-in projects keep working unchanged.
  defaults: () =>
    api<{ ok: boolean; workspaces: Workspace[] }>('/workspaces/defaults'),
  // Send the ACTIVE workspace config so the host validates + caches it. All
  // subsequent :ws routes resolve repoPath/contentRoot from this.
  activate: (ws: Workspace) =>
    api<{ ok: boolean; workspace?: Workspace; error?: string }>('/workspace/activate', {
      method: 'POST',
      body: JSON.stringify(ws),
    }),
  // List the sites (slugs) under a workspace's contentRoot.
  projects: (id: string) =>
    api<{ ok?: boolean; projects?: ProjectListItem[]; error?: string }>(
      `/workspaces/${encodeURIComponent(id)}/projects`,
    ),
  // Open a native folder picker. In the packaged Electron app this goes through
  // the main process' dialog.showOpenDialog (also grants TCC access to the
  // chosen folder); in the plain browser (`yarn editor`) it falls back to the
  // server-side osascript route. canceled:true on Cancel.
  pickFolder: async (): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
    const el = (globalThis as any).electronAPI
    if (el?.pickFolder) return el.pickFolder()
    return api<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>('/fs/pick-folder', {
      method: 'POST',
    })
  },
  // Clone a GitHub repo to a local absolute path (host git/ssh).
  clone: (gitUrl: string, localPath: string) =>
    api<{ ok: boolean; path?: string; error?: string }>('/workspace/clone', {
      method: 'POST',
      body: JSON.stringify({ gitUrl, localPath }),
    }),
  // Is the host's global git user.name/email set? Drives the setup banner.
  gitConfigStatus: () =>
    api<{ configured: boolean; name: string; email: string }>('/git/config-status'),
}

export interface Diagnostics {
  git: { configured: boolean; name: string; email: string }
  claude: { available: boolean }
  aws: { configured: boolean; source: string | null }
  bins: { git: string | null; claude: string | null }
}
export const diagnosticsApi = {
  // Environment health (git/claude/aws + resolved binary paths). Drives DoctorView.
  get: () => api<Diagnostics>('/diagnostics'),
}

export const s3Api = {
  buckets: () => api<{ ok: boolean; buckets?: string[]; error?: string }>('/s3/buckets'),
  createBucket: (name: string, region: string) =>
    api<{ ok: boolean; bucket?: string; error?: string }>('/s3/bucket', {
      method: 'POST',
      body: JSON.stringify({ name, region }),
    }),
}

export interface DeploySidecar {
  deployed: boolean
  lastDeployedAt: string
  bucket: string
  prefix: string
  region: string
}
export const publishApi = {
  // Publish = push + (S3 sync if enabled) + .deploy.json sidecar commit/push.
  run: (workspaceId: string, slug: string) =>
    api<{ ok: boolean; pushed?: boolean; s3?: any; deployedAt?: string; warning?: string; manifest?: number; error?: string }>(
      `/publish/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}`,
      { method: 'POST' },
    ),
  // Read the .deploy.json sidecar so the panel shows the S3 status badge.
  status: (workspaceId: string, slug: string) =>
    api<{ ok?: boolean; deploy?: DeploySidecar | null; error?: string }>(
      `/publish/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}/status`,
    ),
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
  // `type` (optional) is the workspace id; the server uses it to inject that
  // site's custom-component catalog into Claude's system prompt (the schema
  // contract is always injected from the engine).
  run: (prompt: string, cwd: string, runId?: string, slug?: string, images?: string[], type?: string) =>
    api<{ output: string; error?: string; canceled?: boolean; timedOut?: boolean; changed?: boolean }>('/claude', {
      method: 'POST',
      body: JSON.stringify({ prompt, cwd, runId, slug, images, type }),
    }),
  cancel: (runId: string) =>
    api<{ ok: boolean }>('/claude/cancel', {
      method: 'POST',
      body: JSON.stringify({ runId }),
    }),
}
