import type { ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { createReadStream, existsSync } from 'fs'
import { resolve, extname } from 'path'
import { listProjects, readProject, writeProject, createProject, duplicateProject, deleteProject, getRepoPath, getAssetPath } from './projects'
import { gitLog, gitCommit, gitPush, gitRevert } from './git'
import { runClaude } from './claude'
import { setupWatcher } from './watcher'

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => { try { res(JSON.parse(body)) } catch { res({}) } })
    req.on('error', rej)
  })
}

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function createHandler(server: ViteDevServer) {
  // Setup file watcher
  if (server.httpServer) {
    const eventosRepo = resolve(process.cwd(), '..', 'daniela-reyes-eventos')
    const siteRepo = resolve(process.cwd(), '..', 'daniela-reyes-site')
    setupWatcher(server.httpServer, [eventosRepo, siteRepo])
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
