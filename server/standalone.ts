// ─── Standalone Node server (FASE 1 — base para empaquetado / Electron) ─────────
//
// Sirve el editor SIN el dev server de Vite. Es ADICIONAL: `yarn dev`/`yarn
// editor` (Vite + HMR en :3000) siguen funcionando idénticos. Este server es
// para producción/empaquetado y hace tres cosas:
//
//   (a) Sirve el SPA compilado desde dist/ como estático, con fallback SPA a
//       index.html para las rutas del cliente (vue-router en modo history).
//   (b) Enruta /api/* y /content/(eventos|site)/... por el MISMO createHandler()
//       que usa el plugin de Vite (ahora Vite-free).
//   (c) Monta el watcher WebSocket en /__ws sobre este httpServer.
//
// Puerto: env EDITOR_PORT (default 4317). Cierre limpio con SIGINT/SIGTERM.

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { createReadStream, existsSync, statSync } from 'fs'
import { resolve, extname, normalize, join } from 'path'
import { createHandler } from './api'

const PORT = Number(process.env.EDITOR_PORT) || 4317

// dist/ del SPA compilado (vite build). En el bundle CJS, __dirname apunta a
// dist-server/, así que dist/ es ../dist relativo a este archivo; pero también
// soportamos correr desde cwd = raíz del proyecto.
const DIST_CANDIDATES = [
  resolve(__dirname, '..', 'dist'),
  resolve(process.cwd(), 'dist'),
]
const DIST = DIST_CANDIDATES.find((d) => existsSync(join(d, 'index.html'))) || DIST_CANDIDATES[0]

// MIME para los estáticos del SPA (los assets de contenido los sirve la API).
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
}

function isApiOrContent(url: string): boolean {
  return url.startsWith('/api/') || /^\/content\/(eventos|site)\//.test(url)
}

/** Sirve un archivo estático del SPA o hace fallback a index.html (SPA route). */
function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const rawUrl = (req.url || '/').split('?')[0]
  // Sanitiza: nunca dejar salir de DIST. normalize() colapsa ../, luego
  // confirmamos que el path resuelto sigue dentro de DIST.
  const decoded = decodeURIComponent(rawUrl)
  const candidate = normalize(join(DIST, decoded))
  const indexHtml = join(DIST, 'index.html')

  if (candidate.startsWith(DIST) && rawUrl !== '/' && existsSync(candidate) && statSync(candidate).isFile()) {
    const ext = extname(candidate).toLowerCase()
    res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' })
    createReadStream(candidate).pipe(res)
    return
  }

  // Fallback SPA: cualquier ruta del cliente → index.html (vue-router history).
  if (existsSync(indexHtml)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    createReadStream(indexHtml).pipe(res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('dist/index.html no encontrado. Corre `yarn build` primero.')
}

const httpServer = createServer((req, res) => {
  const url = req.url || ''
  if (isApiOrContent(url)) {
    // next() = caer al estático (p. ej. una ruta /api desconocida igual
    // responde 404 dentro del handler; este next solo se usa si el handler
    // decide no manejarla, lo cual no ocurre para estos prefijos).
    apiHandler(req, res, () => serveStatic(req, res))
  } else {
    serveStatic(req, res)
  }
})

// createHandler monta el watcher /__ws sobre ESTE httpServer (mismo mecanismo
// que en Vite) y resuelve el registry de componentes con esbuild (sin Vite).
const apiHandler = createHandler({ httpServer })

httpServer.listen(PORT, () => {
  console.log(`\n  Parallax Editor (standalone) → http://localhost:${PORT}\n`)
  console.log(`  Sirviendo SPA desde: ${DIST}`)
  if (!existsSync(join(DIST, 'index.html'))) {
    console.warn('  AVISO: dist/index.html no existe. Corre `yarn build` para compilar el SPA.')
  }
})

function shutdown(signal: string) {
  console.log(`\n[standalone] ${signal} recibido → cerrando…`)
  httpServer.close(() => process.exit(0))
  // Failsafe: si algún socket queda colgado, forzar salida.
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
