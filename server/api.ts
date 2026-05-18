import type { ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { createReadStream, existsSync } from 'fs'
import { resolve, extname } from 'path'
import { listProjects, readProject, writeProject, createProject, duplicateProject, deleteProject, getRepoPath, getAssetPath, saveProjectAsset, assetKindFromMime } from './projects'
import { gitLog, gitCommit, gitPush, gitRevert } from './git'
import { runClaude } from './claude'
import { setupWatcher } from './watcher'

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
  '.ttf': 'font/ttf', '.woff2': 'font/woff2',
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
        const { slug } = await parseBody(req)
        createProject(cmatch[1], slug)
        return json(res, { ok: true, slug })
      }

      const dmatch = url.match(/^\/api\/projects\/(eventos|site)\/([^/]+)\/duplicate$/)
      if (dmatch && method === 'POST') {
        const newSlug = duplicateProject(dmatch[1], dmatch[2])
        return json(res, { ok: true, slug: newSlug })
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
        const kind = assetKindFromMime(mime)
        if (mime && !kind) {
          return json(res, { error: `Tipo no permitido: ${mime} (solo imágenes, video o audio)` }, 415)
        }
        const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf-8')
        if (buffer.length === 0) return json(res, { error: 'Archivo vacío' }, 400)
        try {
          // Fall back to 'image' only when the dataUrl had no mime at all
          // (keeps the pre-existing image flow working unchanged).
          const result = saveProjectAsset(type, slug, filename, buffer, kind || 'image')
          const label = result.kind === 'video' ? 'El video' : result.kind === 'audio' ? 'El audio' : 'La imagen'
          const warning = result.bytes > 5 * 1024 * 1024
            ? `${label} pesa ${(result.bytes / 1048576).toFixed(1)}MB (recomendado < 5MB). Considera optimizarlo.`
            : undefined
          return json(res, { ok: true, src: result.src, filename: result.filename, bytes: result.bytes, kind: result.kind, warning })
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
      if (url === '/api/claude' && method === 'POST') {
        const { prompt, cwd } = await parseBody(req)
        return json(res, await runClaude(prompt, cwd || process.cwd()))
      }

      json(res, { error: 'Not found' }, 404)
    } catch (err: any) {
      json(res, { error: err.message }, 500)
    }
  }
}
