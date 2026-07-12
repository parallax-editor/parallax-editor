import type { IncomingMessage, ServerResponse } from 'http'
import type { Server as HttpServer } from 'http'
import { createReadStream, existsSync } from 'fs'
import { extname } from 'path'
import { listProjects, readProject, writeProject, createProject, duplicateProject, getRepoPath, getContentRelPath, getAssetPath, saveProjectAsset, assetKindFromMime, listProjectAssets, deleteProjectAsset, contentSignature } from './projects'
import { gitLog, gitShow, gitCommit, gitPush, gitPull, gitPendingCommits, gitOriginRecent, gitAheadCount, gitConfigStatus, gitClone, gitRestoreSnapshot, validatePat, getRemoteUrl } from './git'
import { runClaude, cancelClaude, isClaudeAvailable } from './claude'
import { setupWatcher, addWatchPath } from './watcher'
import { loadComponentRegistry, formatComponentCatalogForPrompt } from './components'
import { bundleWorkspaceComponent } from './sfcBundler'
import { getDiagnostics } from './diagnostics'
import { activateWorkspace, resolveWorkspace, defaultWorkspaces } from './workspaces'
import { pickFolder } from './fs'
import { listBuckets, createBucket, headBucket, readDeploySidecar } from './s3'
import { publishWorkspaceSlug, deleteWorkspaceSlug } from './publish'
import { writeCatalogManifestFile } from './catalog'
import type { S3Credentials, GitCredentials } from './workspaces'

/**
 * Extrae y valida un par de credenciales S3 del body de un request HTTP local.
 * Devuelve undefined cuando no vienen (camino feliz para `credentialsMode:'system'`).
 * Cualquier shape inválido lo trata como AUSENCIA — preferimos un publish que
 * falle por "no hay creds" a uno que rompa por interpretar mal el body.
 *
 * Estas creds NUNCA se guardan: viven solo durante este request y se descartan
 * con el response. El cliente las re-envía cada vez (las saca de su SecretsBus).
 */
function parseS3Credentials(body: any): S3Credentials | undefined {
  if (!body || typeof body !== 'object') return undefined
  const raw = (body as any).credentials
  if (!raw || typeof raw !== 'object') return undefined
  const accessKeyId = typeof raw.accessKeyId === 'string' ? raw.accessKeyId.trim() : ''
  const secretAccessKey = typeof raw.secretAccessKey === 'string' ? raw.secretAccessKey.trim() : ''
  if (!accessKeyId || !secretAccessKey) return undefined
  // Defensa muy básica de tamaño — un AKIA real son ~20 chars, una secret ~40.
  // Si llega algo descomunal preferimos no propagarlo al SDK.
  if (accessKeyId.length > 256 || secretAccessKey.length > 256) return undefined
  return { accessKeyId, secretAccessKey }
}

/** Análogo a `parseS3Credentials` para el PAT de Git (Fase 4). */
function parseGitCredentials(body: any): GitCredentials | undefined {
  if (!body || typeof body !== 'object') return undefined
  const raw = (body as any).gitAuth
  if (!raw || typeof raw !== 'object') return undefined
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (!username || !token) return undefined
  // PATs típicos: 40 chars (GitHub classic) o ~100 (fine-grained). Damos margen
  // amplio. Por defensa contra payloads enormes, cortamos en 1024.
  if (username.length > 256 || token.length > 1024) return undefined
  return { username, token }
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  // video
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.ogv': 'video/ogg',
  // audio
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  // fonts
  '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => { try { res(JSON.parse(body)) } catch { res({}) } })
    req.on('error', rej)
  })
}

// Larger raw-body collector for image uploads (base64 JSON). Uses the raw
// connect/Vite request stream — the project has no express/multer. Caps the
// buffer at 25MB so a runaway upload can't exhaust memory; the 5MB "warn"
// threshold (per project plan) is enforced softly in the handler.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
function parseJsonBodyLarge(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true
        rej(new Error('Archivo demasiado grande (máx 25MB)'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      try { res(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
      catch { rej(new Error('Cuerpo JSON inválido')) }
    })
    req.on('error', rej)
  })
}

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ── Catalog manifest as a repo file (Arreglo 4) ───────────────────────────────
// When a workspace keeps a catalog manifest (ws.s3.publishManifest), the editor
// maintains `<repoPath>/<contentRoot>/manifest.json` as a REAL versioned file.
// Regenerate it on create / save / delete / publish. Returns the repo-relative
// manifest path (e.g. `content/portafolio/manifest.json`) so the SAVE commit can
// include EXACTLY that one extra file in its scoped commit — or '' if the
// workspace doesn't keep a manifest / the write failed (best-effort, never
// blocks the operation). The slug subdir is NEVER widened by this.
function regenManifestIfEnabled(wsId: string): string {
  const ws = resolveWorkspace(wsId)
  if (!ws || !ws.s3?.publishManifest) return ''
  const r = writeCatalogManifestFile(ws)
  return r.ok && r.relPath ? r.relPath : ''
}

// FASE 1: `createHandler` no longer needs a ViteDevServer. The only Vite
// dependency was `server.ssrLoadModule` (to load parallax.config.ts), now
// replaced by an esbuild-based loader (server/configLoader.ts). The handler
// optionally takes the HTTP server it's mounted on so the file watcher can ride
// its `upgrade` event for the /__ws WebSocket — works identically whether that
// server is Vite's dev server (DEV) or the standalone Node server (PROD).
export interface CreateHandlerOptions {
  httpServer?: HttpServer | null
}

export function createHandler(opts: CreateHandlerOptions = {}) {
  // Setup file watcher on the host HTTP server (path /__ws, no extra port).
  // We start with NO watched paths; each workspace the client activates extends
  // the watch set at runtime via `addWatchPath` (see the activation route below).
  const httpServer = opts.httpServer ?? null
  if (httpServer) {
    setupWatcher(httpServer, [])
  } else {
    console.warn('[editor-watcher] No HTTP server available — file watcher disabled')
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url || ''
    // Pathname-only view of req.url so endpoint regexes anchored at `$`
    // still match when a query string is present (e.g. /api/git/X/status?slug=Y).
    // Without this, /^…\/status$/ silently rejected scoped requests and the
    // GitPanel went empty. Kept `url` intact for legacy literal-equals checks.
    const pathname = url.split('?')[0]
    const method = req.method || 'GET'

    try {
      // ─── Workspace seed defaults ────────────
      // Endpoint kept stable; the editor ships with no defaults (empty list).
      // The user adds workspaces from the UI.
      if (url === '/api/workspaces/defaults' && method === 'GET') {
        return json(res, { ok: true, workspaces: defaultWorkspaces() })
      }

      // ─── Workspace activation (Fase 2) ───────────────
      // The client (localStorage = canonical) POSTs the ACTIVE workspace config
      // here. The host validates (path exists, is a git repo, contentRoot
      // exists) and caches it; all `:ws` routes then resolve repoPath +
      // contentRoot from this cache. Also wires the file-watcher to the repo.
      if (url === '/api/workspace/activate' && method === 'POST') {
        const body = await parseBody(req)
        const result = activateWorkspace(body)
        if (result.ok && result.workspace) {
          addWatchPath(result.workspace.repoPath)
          return json(res, { ok: true, workspace: result.workspace })
        }
        return json(res, { ok: false, error: result.error }, 400)
      }

      // ─── Workspace publish readiness (nueva pantalla settings) ────────
      // GET /api/workspaces/:id/status → resumen del estado que el server ve
      // (S3 auth mode + Git auth mode + Git remote HTTPS). El CLIENTE completa
      // con "hay secreto guardado en el keychain?" antes de decidir si el
      // botón Publicar del toolbar va habilitado. Un endpoint separado (en
      // vez de meter esto en /activate) mantiene ambos flujos independientes:
      // /activate cachea la config y arma el watcher; /status es idempotente,
      // solo lee, y no toca ni el cache ni el filesystem del usuario.
      const wsStatusMatch = url.match(/^\/api\/workspaces\/([^/]+)\/status$/)
      if (wsStatusMatch && method === 'GET') {
        const wsId = wsStatusMatch[1]
        const ws = resolveWorkspace(wsId)
        if (!ws) return json(res, { ok: false, error: 'Workspace desconocido' }, 404)
        const s3Mode = ws.s3?.credentialsMode || 'system'
        const s3Enabled = !!ws.s3?.enabled
        const s3Bucket = ws.s3?.bucket || ''
        const useGit = ws.useGit !== false
        const gitMode = ws.git?.authMode || 'system'
        // ¿El remoto del repo es HTTPS? Lo miramos con getRemoteUrl para que
        // la UI pueda advertir "SSH + PAT no combinan" sin esperar al push.
        let gitRemoteUrl: string | null = null
        let gitRemoteIsHttps = false
        if (useGit) {
          try {
            gitRemoteUrl = getRemoteUrl(ws.repoPath)
            gitRemoteIsHttps = !!(gitRemoteUrl && /^https?:\/\//i.test(gitRemoteUrl))
          } catch { /* sin remoto → null, no crash */ }
        }
        return json(res, {
          ok: true,
          workspace: {
            id: ws.id,
            name: ws.name,
            preset: ws.preset || 'multi-tenant',
            useGit,
          },
          s3: {
            enabled: s3Enabled,
            bucket: s3Bucket,
            region: ws.s3?.region || 'us-east-1',
            credentialsMode: s3Mode,
            publishManifest: !!ws.s3?.publishManifest,
          },
          git: {
            useGit,
            authMode: gitMode,
            remoteUrl: gitRemoteUrl,
            remoteIsHttps: gitRemoteIsHttps,
            provider: ws.git?.provider || null,
          },
        })
      }

      // ─── Folder picker (macOS Finder) ────────────────
      // POST /api/fs/pick-folder → osascript `choose folder`, returns the POSIX
      // absolute path. Cancel → { ok:true, canceled:true }.
      if (url === '/api/fs/pick-folder' && method === 'POST') {
        const r = await pickFolder()
        return json(res, r)
      }

      // ─── Clone a repo (host git/ssh) ─────────────────
      // POST /api/workspace/clone { gitUrl, localPath } → git clone using the
      // host's authenticated git. Returns the cloned absolute path.
      if (url === '/api/workspace/clone' && method === 'POST') {
        const { gitUrl, localPath } = await parseBody(req)
        const r = await gitClone(String(gitUrl || ''), String(localPath || ''))
        return json(res, r, r.ok ? 200 : 400)
      }

      // ─── Git global config status ────────────────────
      // GET /api/git/config-status → { configured, name, email }. Drives the
      // "configura git" banner in the workspace selector.
      if (url === '/api/git/config-status' && method === 'GET') {
        return json(res, gitConfigStatus())
      }

      // ─── Diagnóstico de entorno (Fase 4 — pantalla doctor) ───
      // GET /api/diagnostics → estado de git / claude / aws + dónde resolvió
      // cada binario. Lo consume DoctorView (primer arranque / menú Ayuda).
      if (url === '/api/diagnostics' && method === 'GET') {
        return json(res, getDiagnostics())
      }

      // ─── S3 buckets (Fase 3) ─────────────────────────
      // listBuckets se mantiene como GET (la mayoría de los usos vienen del
      // combobox del modal y usan la cadena del sistema). Para listar con creds
      // explícitas usamos POST /api/s3/buckets/explicit (body { region,
      // credentials }) — endpoint separado para no forzar a TODO el flow a
      // pasar por POST.
      if (url === '/api/s3/buckets' && method === 'GET') {
        return json(res, await listBuckets())
      }
      if (url === '/api/s3/buckets/explicit' && method === 'POST') {
        const body = await parseBody(req)
        const region = String(body?.region || 'us-east-1')
        return json(res, await listBuckets(region, parseS3Credentials(body)))
      }
      if (url === '/api/s3/bucket' && method === 'POST') {
        // Intencionalmente sin gate por workspace `credentialsMode`: este
        // endpoint se usa desde el modal MIENTRAS el usuario está configurando
        // el workspace — todavía no hay un workspace activo en modo 'explicit'
        // contra el cual contrastar. Si el cliente manda creds, las usamos;
        // si no, la cadena del sistema. La asimetría con publish/delete es
        // por construcción.
        const body = await parseBody(req)
        return json(
          res,
          await createBucket(
            String(body?.name || ''),
            String(body?.region || 'us-east-1'),
            parseS3Credentials(body),
          ),
        )
      }
      // POST /api/s3/head-bucket { bucket, region, credentials? } → smoke test
      // del bucket + creds. Lo usa el botón "Verificar" del modal del workspace
      // para fallar antes de Publicar si las credenciales explícitas no sirven.
      if (url === '/api/s3/head-bucket' && method === 'POST') {
        const body = await parseBody(req)
        return json(
          res,
          await headBucket(
            String(body?.bucket || ''),
            String(body?.region || 'us-east-1'),
            parseS3Credentials(body),
          ),
        )
      }

      // ─── Asset serving ───────────────────────────────
      // El query string (p.ej. el cache-bust `?v=N` que el preview añade para
      // refrescar imágenes borradas/reemplazadas) NO es parte de la ruta del
      // archivo — quítalo antes de resolver el asset, si no `foo.jpg?v=0` se
      // busca como nombre literal y da 404.
      const assetMatch = url.split('?')[0].match(/^\/content\/([^/]+)\/([^/]+)\/(.+)$/)
      if (assetMatch && method === 'GET') {
        const [, type, slug, assetPath] = assetMatch
        // Defensa de traversal (ahora entra cualquier workspace id): el assetPath
        // nunca debe salir de la carpeta del proyecto.
        if (assetPath.includes('..')) { return json(res, { error: 'Not found' }, 404) }
        const filePath = getAssetPath(type, slug, assetPath)
        if (existsSync(filePath)) {
          const ext = extname(filePath).toLowerCase()
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
          createReadStream(filePath).pipe(res)
        } else {
          json(res, { error: 'Not found' }, 404)
        }
        return
      }

      // ─── Custom-component discovery (parallax.config.ts) ─────────────
      // GET /api/components/:type → JSON registry of the neighbor repo's
      // registered custom components (names + labels + editableProps), with
      // the live Vue `component` refs stripped (not serializable). eventos has
      // no config → {} (built-ins only). A broken config → {} + error (never
      // 500s; the editor degrades gracefully). Server changes auto-apply via
      // the #33 Vite plugin — no manual restart.
      const compMatch = url.match(/^\/api\/components\/([^/]+)$/)
      if (compMatch && method === 'GET') {
        const registry = await loadComponentRegistry(compMatch[1])
        return json(res, registry)
      }

      // GET /api/workspaces/:id/components/:name.js — server-bundled
      // workspace SFC (CustomComponentHost.vue imports it dynamically). The
      // bundle treats `vue` as external so the runtime shares the editor's
      // Vue instance. mtime is included in the ETag so the file watcher can
      // invalidate via cache busting on the client side.
      const sfcMatch = url.match(/^\/api\/workspaces\/([^/]+)\/components\/([A-Za-z][A-Za-z0-9_-]*)\.js(?:\?.*)?$/)
      if (sfcMatch && method === 'GET') {
        const [, wsId, name] = sfcMatch
        const result = await bundleWorkspaceComponent(wsId, name)
        if (!result.ok) {
          return json(res, { error: result.error }, result.status || 500)
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        // Short cache + mtime-based ETag: a fresh ?v=<mtime> from the client
        // is a cache miss; same v is a 200 from the in-memory cache.
        res.setHeader('Cache-Control', 'public, max-age=60')
        res.setHeader('ETag', `"${result.mtimeMs}"`)
        res.end(result.body)
        return
      }

      // ─── Projects ────────────────────────────────────
      // Legacy combined listing (kept for back-compat): the two seeded default
      // workspaces. New per-workspace listing is GET /api/workspaces/:id/projects.
      if (url === '/api/projects' && method === 'GET') {
        return json(res, { eventos: listProjects('eventos'), site: listProjects('site') })
      }

      // Per-workspace project listing (Fase 2). Resolves the workspace by id
      // and lists the sites (slugs) under its contentRoot. Unknown id → 404.
      const wlmatch = url.match(/^\/api\/workspaces\/([^/]+)\/projects$/)
      if (wlmatch && method === 'GET') {
        const ws = resolveWorkspace(wlmatch[1])
        if (!ws) return json(res, { error: 'Workspace desconocido' }, 404)
        return json(res, { ok: true, projects: listProjects(ws.id) })
      }

      const pmatch = url.match(/^\/api\/projects\/([^/]+)\/([^/]+)$/)
      if (pmatch) {
        const [, type, slug] = pmatch
        if (method === 'GET') {
          const data = readProject(type, slug)
          return data ? json(res, data) : json(res, { error: 'Not found' }, 404)
        }
        if (method === 'PUT') {
          writeProject(type, slug, await parseBody(req))
          return json(res, { ok: true })
        }
        if (method === 'DELETE') {
          // Eliminar = inverso de publicar: borra la carpeta local, commitea+
          // pushea la eliminación (acotada), borra los objetos del slug en S3
          // (si está habilitado) y resube el manifest. Antes solo borraba local
          // → el sitio publicado quedaba vivo en S3.
          //
          // Fase 3: aceptamos `credentials` en el body (back-compat: si no
          // viene, S3 usa la cadena del sistema). Para DELETE el body es
          // estándar HTTP raro pero válido — la SDK lo respeta.
          // Fase 4: además `gitAuth` para el push del commit de eliminación.
          const body = await parseBody(req).catch(() => ({}))
          return json(res, await deleteWorkspaceSlug(type, slug, parseS3Credentials(body), parseGitCredentials(body)))
        }
      }

      const cmatch = url.match(/^\/api\/projects\/([^/]+)$/)
      if (cmatch && method === 'POST') {
        // TASK 2: the client sends the FREE-FORM `name` the human typed (the
        // HTML <title>). The server derives the slug with the SHARED
        // slugify() (preview === folder) and auto-increments on collision.
        // Back-compat: an old client still sending `slug` is honored as the
        // name (slugify() is idempotent on an already-valid slug).
        const body = await parseBody(req)
        const name = typeof body?.name === 'string' ? body.name : (body?.slug ?? '')
        const finalSlug = createProject(cmatch[1], name)
        // Arreglo 4: keep the catalog manifest file in sync when a project is
        // created (no-op for workspaces without a manifest). It gets committed
        // with the next scoped save (or the Publicar flow).
        regenManifestIfEnabled(cmatch[1])
        return json(res, { ok: true, slug: finalSlug })
      }

      const dmatch = url.match(/^\/api\/projects\/([^/]+)\/([^/]+)\/duplicate$/)
      if (dmatch && method === 'POST') {
        // Optional `newSlug` from the selector's Spanish prompt. Absent/blank →
        // duplicateProject auto-names "<slug>-copia" and auto-increments on
        // collision so duplicating twice never 500s.
        let desired: string | undefined
        try {
          const body = await parseBody(req)
          if (body && typeof body.newSlug === 'string') desired = body.newSlug
        } catch { /* no/invalid body → auto-name */ }
        const newSlug = duplicateProject(dmatch[1], dmatch[2], desired)
        // Arreglo 4: a duplicate adds a new slug → refresh the catalog manifest
        // (no-op for workspaces without a manifest).
        regenManifestIfEnabled(dmatch[1])
        return json(res, { ok: true, slug: newSlug })
      }

      // ─── Asset listing (Recursos browser + autocomplete) ──────────────
      // GET /api/projects/:type/:slug/assets → files grouped by kind. Single
      // source of truth for the "Recursos" panel AND the image/font combobox
      // suggestions. Read-only; reuses the same content-dir path mapping.
      const almatch = url.match(/^\/api\/projects\/([^/]+)\/([^/]+)\/assets$/)
      if (almatch && method === 'GET') {
        const [, type, slug] = almatch
        return json(res, { ok: true, assets: listProjectAssets(type, slug) })
      }

      // ─── Asset delete ─────────────────────────────────
      // DELETE /api/projects/:type/:slug/assets/:kind/:file → remove one file.
      // Hard-sanitized server-side (basename only, must stay inside the
      // project's <subdir>); 404 if the kind is unknown or the file is gone.
      // Decoded so a sanitized kebab name with %xx still resolves.
      const admatch = url.match(/^\/api\/projects\/([^/]+)\/([^/]+)\/assets\/([^/]+)\/(.+)$/)
      if (admatch && method === 'DELETE') {
        const [, type, slug, kind, rawFile] = admatch
        let file = rawFile
        try { file = decodeURIComponent(rawFile) } catch { /* keep raw */ }
        const result = deleteProjectAsset(type, slug, kind, file)
        // null → 404 (unknown kind / missing file / path-escape attempt).
        // Otherwise pass through the AssetCommitInfo so the client can show
        // the "Guardado y versionado" / "sin versionar" toast (TASK #102).
        return result
          ? json(res, { ok: true, commit: result.commit, commitMessage: result.commitMessage, warning: result.warning })
          : json(res, { error: 'Archivo no encontrado' }, 404)
      }

      // ─── Asset upload ────────────────────────────────
      // POST /api/projects/:type/:slug/assets
      // Body: { filename: string, dataUrl: string }  (dataUrl = "data:<mime>;base64,…")
      // Copies an image / video / audio picked from anywhere on disk into the
      // project's content dir (images/ | video/ | audio/, routed by mime) and
      // returns the relative `src` to store ("<subdir>/<file>"). The editor
      // preview can serve it immediately at /content/<type>/<slug>/<src>.
      const amatch = url.match(/^\/api\/projects\/([^/]+)\/([^/]+)\/assets$/)
      if (amatch && method === 'POST') {
        const [, type, slug] = amatch
        const body = await parseJsonBodyLarge(req)
        const filename = String(body?.filename || '').trim()
        const dataUrl = String(body?.dataUrl || '')
        // overwrite=true (recorte in situ): reemplaza el archivo con ese nombre.
        const overwrite = body?.overwrite === true
        if (!filename) return json(res, { error: 'Falta el nombre del archivo' }, 400)
        const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
        if (!m) return json(res, { error: 'dataUrl inválido' }, 400)
        const mime = (m[1] || '').toLowerCase()
        // Pass the filename too: font mimes are inconsistent (often a generic
        // application/octet-stream), so assetKindFromMime falls back to the
        // file extension to recognize .ttf/.otf/.woff/.woff2.
        const kind = assetKindFromMime(mime, filename)
        // Generalized accept: image / video / audio / font. A present mime
        // that resolves to none of those (e.g. application/pdf) is rejected;
        // octet-stream font uploads still pass via the filename fallback.
        if (mime && !kind) {
          return json(res, { error: `Tipo no permitido: ${mime} (solo imágenes, video, audio o fuentes)` }, 415)
        }
        const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf-8')
        if (buffer.length === 0) return json(res, { error: 'Archivo vacío' }, 400)
        try {
          // Fall back to 'image' only when the dataUrl had no mime at all
          // (keeps the pre-existing image flow working unchanged).
          const result = saveProjectAsset(type, slug, filename, buffer, kind || 'image', overwrite)
          const label = result.kind === 'video' ? 'El video' : result.kind === 'audio' ? 'El audio' : result.kind === 'font' ? 'La fuente' : 'La imagen'
          // Two independent `warning` channels collapse into one user-visible
          // line: the SIZE warning ("pesa 8MB, optimízalo") and the COMMIT
          // warning ("guardado pero no versionado"). Size wins when both are
          // present — it's more actionable for the user ("optimiza la foto");
          // the commit fallback is informational and already reflected in
          // `commit: 'skipped'` for the UI to render its own subtle toast.
          const sizeWarning = result.bytes > 5 * 1024 * 1024
            ? `${label} pesa ${(result.bytes / 1048576).toFixed(1)}MB (recomendado < 5MB). Considera optimizarlo.`
            : undefined
          return json(res, {
            ok: true,
            src: result.src,
            filename: result.filename,
            bytes: result.bytes,
            kind: result.kind,
            warning: sizeWarning || result.warning,
            commit: result.commit,
            commitMessage: result.commitMessage,
          })
        } catch (e: any) {
          return json(res, { error: e.message || 'No se pudo guardar el archivo' }, 415)
        }
      }

      // ─── Git ─────────────────────────────────────────
      const glmatch = url.match(/^\/api\/git\/([^/]+)\/log$/)
      if (glmatch && method === 'GET') {
        return json(res, gitLog(getRepoPath(glmatch[1])))
      }

      // Diff completo de un commit (modal "ver qué se hizo commit"). El hash se
      // valida en el patrón (hex) y de nuevo en gitShow.
      const gshow = url.match(/^\/api\/git\/([^/]+)\/show\/([0-9a-fA-F]{4,40})$/)
      if (gshow && method === 'GET') {
        return json(res, gitShow(getRepoPath(gshow[1]), gshow[2]))
      }

      // Publicar status: how many commits are pending (ahead of upstream), the
      // pending commits themselves and the last 5 commits on origin/main. Drives
      // the toolbar "Publicar" enabled state and the GitPanel listings. All
      // best-effort (no upstream / offline are handled inside the helpers).
      // ?slug= scopes the commit lists AND the ahead-count to files under that
      // slug's content dir so the GitPanel / Publicar badge only count commits
      // that actually touched the open site. Match against PATHNAME (not the
      // raw url) so the trailing `$` survives a `?slug=…` query — without it
      // the regex missed every scoped request and the panel went empty.
      const gsmatch = pathname.match(/^\/api\/git\/([^/]+)\/status$/)
      if (gsmatch && method === 'GET') {
        const repo = getRepoPath(gsmatch[1])
        const u = new URL(req.url || '', 'http://x')
        const slug = (u.searchParams.get('slug') || '').trim()
        const scope = slug ? getContentRelPath(gsmatch[1], slug) : ''
        return json(res, {
          ahead: gitAheadCount(repo, scope || undefined),
          pending: gitPendingCommits(repo, scope || undefined),
          originRecent: gitOriginRecent(repo, 5, scope || undefined),
        })
      }

      const gcmatch = url.match(/^\/api\/git\/([^/]+)\/commit$/)
      if (gcmatch && method === 'POST') {
        // git opcional: si el workspace no usa git, Guardar solo escribe a disco
        // (el PUT ya lo hizo) — sin commit.
        if (resolveWorkspace(gcmatch[1])?.useGit === false) {
          return json(res, { ok: true, result: 'no-git' })
        }
        const { message, slug } = await parseBody(req)
        // SECURITY: scope the save commit to ONLY this site's content dir
        // (content/<slug> | content/portafolio/<slug>). Without a slug we
        // refuse to commit rather than fall back to a repo-wide `git add -A`,
        // which could sweep in other sites / unrelated changes.
        const relPath = slug ? getContentRelPath(gcmatch[1], String(slug)) : ''
        if (!relPath) {
          return json(res, { ok: true, result: 'Nothing to commit' })
        }
        // Arreglo 4: if this workspace keeps a catalog manifest, regenerate it
        // and include ONLY `<contentRoot>/manifest.json` as an extra path in the
        // SAME scoped commit (a single file in the same contentRoot — never
        // another slug). When the workspace has no manifest this is a no-op.
        const manifestRel = regenManifestIfEnabled(gcmatch[1])
        return json(res, {
          ok: true,
          result: gitCommit(
            getRepoPath(gcmatch[1]),
            message || 'Auto-save',
            relPath,
            manifestRel ? [manifestRel] : [],
          ),
        })
      }

      const gpmatch = url.match(/^\/api\/git\/([^/]+)\/push$/)
      if (gpmatch && method === 'POST') {
        return json(res, { ok: true, result: gitPush(getRepoPath(gpmatch[1])) })
      }

      // Snapshot revert (Phase 6): bring the workspace's content folder for ONE
      // slug to the exact state it had at <hash>. Working-tree only (NO commit
      // — the user reviews + commits with their own message via Cmd+S).
      const grestore = url.match(/^\/api\/git\/([^/]+)\/restore-snapshot$/)
      if (grestore && method === 'POST') {
        // git-disabled workspaces have no history to restore from.
        if (resolveWorkspace(grestore[1])?.useGit === false) {
          return json(res, { ok: false, error: 'Este workspace no usa git.' })
        }
        const body = await parseBody(req)
        const hash = String((body as any).hash || '').trim()
        const slug = String((body as any).slug || '').trim()
        if (!hash || !slug) {
          return json(res, { ok: false, error: 'Faltan hash o slug.' })
        }
        const contentRel = getContentRelPath(grestore[1], slug)
        if (!contentRel) {
          return json(res, { ok: false, error: 'Ruta de contenido no válida para este workspace.' })
        }
        return json(res, gitRestoreSnapshot(getRepoPath(grestore[1]), hash, contentRel))
      }

      // Traer cambios del remoto (menú Git → "Traer cambios"). No-op si el
      // workspace no usa git.
      const gpull = url.match(/^\/api\/git\/([^/]+)\/pull$/)
      if (gpull && method === 'POST') {
        if (resolveWorkspace(gpull[1])?.useGit === false) {
          return json(res, { ok: false, error: 'Este workspace no usa git.' })
        }
        // force === true SOLO lo manda la UI tras un confirm explícito del
        // usuario (descartar cambios locales y traer la última versión).
        const { force } = await parseBody(req)
        return json(res, gitPull(getRepoPath(gpull[1]), force === true))
      }

      // ─── Publicar (Fase 3): push + S3 sync + deploy sidecar ───────────
      // POST /api/publish/:workspaceId/:slug. Pushes pending commits, then (if
      // the workspace has S3 enabled) syncs ONLY this slug's content dir to S3
      // and writes/commits/pushes a .deploy.json sidecar. Scoped to the slug.
      // POST /api/git/validate-pat { workspaceId, username, token } → ls-remote
      // contra el origin del workspace con GIT_ASKPASS inyectado. ok=true si el
      // remoto responde a las creds, false si rechaza. SOLO HTTPS.
      if (url === '/api/git/validate-pat' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}))
        const wsId = String(body?.workspaceId || '')
        const ws = resolveWorkspace(wsId)
        if (!ws) return json(res, { ok: false, error: 'Workspace desconocido' }, 404)
        const auth = parseGitCredentials(body)
        if (!auth) return json(res, { ok: false, error: 'Faltan username/token.' })
        try {
          const r = validatePat(ws.repoPath, auth)
          return json(res, r, r.ok ? 200 : 200) // siempre 200; el ok dice el resultado
        } catch (e: any) {
          return json(res, { ok: false, error: e?.message || 'No se pudo validar el PAT.' })
        }
      }

      const pubmatch = url.match(/^\/api\/publish\/([^/]+)\/([^/]+)$/)
      if (pubmatch && method === 'POST') {
        const [, wsId, slug] = pubmatch
        // Body opcional: `credentials` (S3) y `gitAuth` (PAT). Ambos sólo se
        // honran cuando el workspace está en el modo correspondiente; ver
        // gating en publish.ts.
        const body = await parseBody(req).catch(() => ({}))
        const r = await publishWorkspaceSlug(wsId, slug, parseS3Credentials(body), parseGitCredentials(body))
        return json(res, r, r.ok ? 200 : 400)
      }

      // GET /api/publish/:workspaceId/:slug/status → read the .deploy.json
      // sidecar so the Publicar panel shows "Publicado en S3 · <fecha>".
      const pubstat = url.match(/^\/api\/publish\/([^/]+)\/([^/]+)\/status$/)
      if (pubstat && method === 'GET') {
        const [, wsId, slug] = pubstat
        const ws = resolveWorkspace(wsId)
        if (!ws) return json(res, { error: 'Workspace desconocido' }, 404)
        return json(res, { ok: true, deploy: readDeploySidecar(ws, slug) })
      }

      // ─── Claude ──────────────────────────────────────
      // Is the `claude` CLI installed/usable on this machine? Drives the
      // toolbar "Claude" button enabled state (cached server-side).
      if (url === '/api/claude/status' && method === 'GET') {
        return json(res, { available: isClaudeAvailable() })
      }

      // Cancel a running `claude -p` (GAP3 / PLAN §16). The client sends the
      // same `runId` it used to start the run; cancelClaude kills the child
      // and the original /api/claude promise resolves with { canceled:true }
      // so the UI settles cleanly (no hang). Idempotent: a stale/unknown id
      // just returns ok:false.
      if (url === '/api/claude/cancel' && method === 'POST') {
        const { runId } = await parseBody(req)
        const killed = cancelClaude(String(runId || ''))
        return json(res, { ok: killed })
      }

      if (url === '/api/claude' && method === 'POST') {
        // `slug` (optional) keys a CONTINUOUS Claude session for that site so
        // iterative prompts build on prior context (TASK 1). Absent → legacy
        // stateless run (unchanged).
        // `images` (optional, TASK 3 / #67): array of data URLs the client
        // attached. Decoded here (like the asset-upload path — files are read
        // server-side from the dataURL, NEVER referenced by path) into base64
        // blocks delivered to claude via stream-json stdin. Uses the larger
        // body collector since image payloads exceed the small JSON parser.
        const body = await parseJsonBodyLarge(req)
        const { prompt, cwd, runId, slug, type } = body
        const ALLOWED_IMG = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
        const IMG_MAX_BYTES = 5 * 1024 * 1024 // mirror the >5MB asset cap
        const rawImages: any[] = Array.isArray(body?.images) ? body.images : []
        const images: { mediaType: string; dataBase64: string }[] = []
        for (const item of rawImages.slice(0, 8)) {
          const dataUrl = typeof item === 'string' ? item : String(item?.dataUrl || '')
          const m = dataUrl.match(/^data:([^;,]+)?;base64,(.*)$/s)
          if (!m) continue
          const mediaType = (m[1] || '').toLowerCase()
          if (!ALLOWED_IMG.has(mediaType)) {
            return json(res, { error: `Tipo de imagen no permitido: ${mediaType || 'desconocido'} (usa PNG, JPG, WEBP o GIF)` }, 415)
          }
          const b64 = m[2].replace(/\s+/g, '')
          const bytes = Math.floor((b64.length * 3) / 4)
          if (bytes > IMG_MAX_BYTES) {
            return json(res, { error: `Una imagen pesa ${(bytes / 1048576).toFixed(1)}MB (máx 5MB). Optimízala e intenta de nuevo.` }, 413)
          }
          images.push({ mediaType, dataBase64: b64 })
        }
        // Catálogo de componentes custom del workspace (`type`) → se inyecta en
        // el system prompt (junto al contrato del engine) para que Claude use
        // solo los componentes reales del sitio. Best-effort: si falla o no hay
        // `type`, queda vacío y la corrida sigue normal.
        let componentCatalog = ''
        if (type) {
          try { componentCatalog = await formatComponentCatalogForPrompt(String(type)) } catch { /* noop */ }
        }
        // NOTE: Claude's edits are intentionally NOT auto-committed here. They
        // land on disk; the file watcher reloads them into the editor and marks
        // the doc dirty so the "Guardar" button enables — the user reviews and
        // decides whether to keep them (manual Guardar → commit). See the
        // file-changed handler in EditorView.vue.
        // cwd autoritativo: la carpeta del workspace (`type`), no lo que mande el
        // cliente — así Claude SIEMPRE corre en el repo correcto (un workspace
        // nuevo ya no hereda el repo del portafolio). Fallback al cwd del cliente
        // y luego al del proceso.
        const repoCwd = (type && getRepoPath(String(type))) || cwd || process.cwd()
        // BLINDAJE (#claude-no-change): firma del contenido ANTES y DESPUÉS del
        // run. Si no cambió, Claude respondió pero no tocó ningún archivo → el
        // editor lo avisa. Solo medible con type+slug (sabemos qué carpeta mirar);
        // sin ellos `changed` queda undefined y el cliente no avisa.
        let sigBefore: string | null = null
        if (type && slug) {
          try { sigBefore = contentSignature(String(type), String(slug)) } catch { /* noop */ }
        }
        const result = await runClaude(
          prompt,
          repoCwd,
          runId ? String(runId) : undefined,
          slug ? String(slug) : undefined,
          images,
          componentCatalog,
        )
        let changed: boolean | undefined
        if (sigBefore !== null) {
          try { changed = contentSignature(String(type), String(slug)) !== sigBefore } catch { /* noop */ }
        }
        return json(res, { ...result, changed })
      }

      json(res, { error: 'Not found' }, 404)
    } catch (err: any) {
      json(res, { error: err.message }, 500)
    }
  }
}
