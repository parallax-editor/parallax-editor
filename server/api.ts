import type { ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { createReadStream, existsSync } from 'fs'
import { resolve, extname } from 'path'
import { listProjects, readProject, writeProject, createProject, duplicateProject, deleteProject, getRepoPath, getAssetPath, saveProjectAsset, assetKindFromMime, listProjectAssets, deleteProjectAsset } from './projects'
import { gitLog, gitCommit, gitPush, gitRevert } from './git'
import { runClaude, cancelClaude } from './claude'
import { setupWatcher } from './watcher'
import { loadComponentRegistry } from './components'

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

export function createHandler(server: ViteDevServer) {
  // Setup file watcher on the shared Vite HTTP server (path /__ws, no extra port)
  const eventosRepo = resolve(process.cwd(), '..', 'daniela-reyes-eventos')
  const siteRepo = resolve(process.cwd(), '..', 'daniela-reyes-site')
  if (server.httpServer) {
    setupWatcher(server.httpServer, [eventosRepo, siteRepo])
  } else {
    console.warn('[editor-watcher] No HTTP server available — file watcher disabled')
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url || ''
    const method = req.method || 'GET'

    try {
      // ─── Asset serving ───────────────────────────────
      const assetMatch = url.match(/^\/content\/(eventos|site)\/([^/]+)\/(.+)$/)
      if (assetMatch && method === 'GET') {
        const [, type, slug, assetPath] = assetMatch
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
      const compMatch = url.match(/^\/api\/components\/(eventos|site)$/)
      if (compMatch && method === 'GET') {
        const registry = await loadComponentRegistry(server, compMatch[1])
        return json(res, registry)
      }

      // ─── Projects ────────────────────────────────────
      if (url === '/api/projects' && method === 'GET') {
        return json(res, { eventos: listProjects('eventos'), site: listProjects('site') })
      }

      const pmatch = url.match(/^\/api\/projects\/(eventos|site)\/([^/]+)$/)
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
          deleteProject(type, slug)
          return json(res, { ok: true })
        }
      }

      const cmatch = url.match(/^\/api\/projects\/(eventos|site)$/)
      if (cmatch && method === 'POST') {
        // TASK 2: the client sends the FREE-FORM `name` the human typed (the
        // HTML <title>). The server derives the slug with the SHARED
        // slugify() (preview === folder) and auto-increments on collision.
        // Back-compat: an old client still sending `slug` is honored as the
        // name (slugify() is idempotent on an already-valid slug).
        const body = await parseBody(req)
        const name = typeof body?.name === 'string' ? body.name : (body?.slug ?? '')
        const finalSlug = createProject(cmatch[1], name)
        return json(res, { ok: true, slug: finalSlug })
      }

      const dmatch = url.match(/^\/api\/projects\/(eventos|site)\/([^/]+)\/duplicate$/)
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
        return json(res, { ok: true, slug: newSlug })
      }

      // ─── Asset listing (Recursos browser + autocomplete) ──────────────
      // GET /api/projects/:type/:slug/assets → files grouped by kind. Single
      // source of truth for the "Recursos" panel AND the image/font combobox
      // suggestions. Read-only; reuses the same content-dir path mapping.
      const almatch = url.match(/^\/api\/projects\/(eventos|site)\/([^/]+)\/assets$/)
      if (almatch && method === 'GET') {
        const [, type, slug] = almatch
        return json(res, { ok: true, assets: listProjectAssets(type, slug) })
      }

      // ─── Asset delete ─────────────────────────────────
      // DELETE /api/projects/:type/:slug/assets/:kind/:file → remove one file.
      // Hard-sanitized server-side (basename only, must stay inside the
      // project's <subdir>); 404 if the kind is unknown or the file is gone.
      // Decoded so a sanitized kebab name with %xx still resolves.
      const admatch = url.match(/^\/api\/projects\/(eventos|site)\/([^/]+)\/assets\/([^/]+)\/(.+)$/)
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
      const amatch = url.match(/^\/api\/projects\/(eventos|site)\/([^/]+)\/assets$/)
      if (amatch && method === 'POST') {
        const [, type, slug] = amatch
        const body = await parseJsonBodyLarge(req)
        const filename = String(body?.filename || '').trim()
        const dataUrl = String(body?.dataUrl || '')
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
          const result = saveProjectAsset(type, slug, filename, buffer, kind || 'image')
          const label = result.kind === 'video' ? 'El video' : result.kind === 'audio' ? 'El audio' : result.kind === 'font' ? 'La fuente' : 'La imagen'
          // Two independent `warning` channels collapse into one user-visible
          // line: the SIZE warning ("pesa 8MB, optimízalo") and the COMMIT
          // warning ("guardado pero no versionado"). Size wins when both are
          // present — it's more actionable for Daniela ("optimiza la foto");
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
      const glmatch = url.match(/^\/api\/git\/(eventos|site)\/log$/)
      if (glmatch && method === 'GET') {
        return json(res, gitLog(getRepoPath(glmatch[1])))
      }

      const gcmatch = url.match(/^\/api\/git\/(eventos|site)\/commit$/)
      if (gcmatch && method === 'POST') {
        const { message } = await parseBody(req)
        return json(res, { ok: true, result: gitCommit(getRepoPath(gcmatch[1]), message || 'Auto-save') })
      }

      const gpmatch = url.match(/^\/api\/git\/(eventos|site)\/push$/)
      if (gpmatch && method === 'POST') {
        return json(res, { ok: true, result: gitPush(getRepoPath(gpmatch[1])) })
      }

      const grmatch = url.match(/^\/api\/git\/(eventos|site)\/revert\/([a-f0-9]+)$/)
      if (grmatch && method === 'POST') {
        return json(res, { ok: true, result: gitRevert(getRepoPath(grmatch[1]), grmatch[2]) })
      }

      // ─── Claude ──────────────────────────────────────
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
        const { prompt, cwd, runId, slug } = body
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
        // NOTE: Claude's edits are intentionally NOT auto-committed here. They
        // land on disk; the file watcher reloads them into the editor and marks
        // the doc dirty so the "Guardar" button enables — Daniela reviews and
        // decides whether to keep them (manual Guardar → commit). See the
        // file-changed handler in EditorView.vue.
        return json(res, await runClaude(
          prompt,
          cwd || process.cwd(),
          runId ? String(runId) : undefined,
          slug ? String(slug) : undefined,
          images,
        ))
      }

      json(res, { error: 'Not found' }, 404)
    } catch (err: any) {
      json(res, { error: err.message }, 500)
    }
  }
}
