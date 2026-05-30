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
// FASE 2 (Electron): este módulo exporta `start(port?)` para arrancar el server
// IN-PROCESS desde el proceso principal de Electron. El modo CLI (script
// `yarn start`) se conserva con `if (require.main === module) start()`, así que
// nada del flujo previo cambia.
//
// Puerto: arg de start() → env EDITOR_PORT → default 4317. Cierre limpio con
// SIGINT/SIGTERM (solo cuando se corre como script).

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'http'
import { createReadStream, existsSync, statSync } from 'fs'
import { resolve, extname, normalize, join } from 'path'
import { createHandler } from './api'
import { closeWatcher } from './watcher'

const DEFAULT_PORT = Number(process.env.EDITOR_PORT) || 4317

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
  // /content/<workspaceId>/... para CUALQUIER workspace (no solo eventos/site);
  // si no, las imágenes de un workspace con id nuevo caen al SPA y se ven rotas.
  return url.startsWith('/api/') || /^\/content\/[^/]+\//.test(url)
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

/**
 * Arranca el server standalone y resuelve cuando está escuchando.
 *
 * @param port  Puerto a usar. Default: env EDITOR_PORT → 4317. Pasa 0 para que
 *              el SO asigne uno libre (útil si Electron quiere evitar choques).
 * @returns     `{ port, server, close }` — `port` es el puerto REAL en uso
 *              (relevante si pediste 0), `close()` apaga el server limpio.
 */
export function start(port: number = DEFAULT_PORT): Promise<{
  port: number
  server: HttpServer
  close: () => Promise<void>
}> {
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

  const close = () =>
    new Promise<void>((resolveClose) => {
      // 1) Cerrar el WS server + chokidar watcher PRIMERO. Sin esto, fsevents
      //    (la atadura nativa de chokidar en macOS) sigue viva cuando el
      //    proceso de Electron muere → macOS reporta "se cerró inesperadamente".
      // 2) Forzar drop de conexiones HTTP abiertas (Node 18.2+) para que el
      //    .close() del server no se quede esperando keep-alives o WS sockets
      //    que ya no nos importan en quit time.
      // 3) Failsafe de 2s por si algo aún se cuelga (mejor cerrar parcialmente
      //    que dejar la app bloqueada en quit).
      closeWatcher()
        .catch(() => undefined)
        .finally(() => {
          try {
            if (typeof (httpServer as any).closeAllConnections === 'function') {
              ;(httpServer as any).closeAllConnections()
            }
          } catch { /* older node, ignore */ }
          httpServer.close(() => resolveClose())
          setTimeout(() => resolveClose(), 2000).unref()
        })
    })

  return new Promise((resolveStart, rejectStart) => {
    httpServer.once('error', rejectStart)
    httpServer.listen(port, () => {
      httpServer.removeListener('error', rejectStart)
      // Handler PERSISTENTE de errores en runtime (socket roto, suspensión del
      // equipo, EMFILE…). Sin esto, tras el arranque el httpServer queda SIN
      // listener de 'error' → un error post-arranque es "unhandled" y Node tumba
      // el proceso → el server desaparece y el renderer ve ERR_CONNECTION_REFUSED.
      // Lo registramos y NO relanzamos, así el server sobrevive.
      httpServer.on('error', (e) => {
        console.error('[standalone] error del servidor en runtime (ignorado para no caer):', e)
      })
      const addr = httpServer.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      console.log(`\n  Parallax Editor (standalone) → http://localhost:${actualPort}\n`)
      console.log(`  Sirviendo SPA desde: ${DIST}`)
      if (!existsSync(join(DIST, 'index.html'))) {
        console.warn('  AVISO: dist/index.html no existe. Corre `yarn build` para compilar el SPA.')
      }
      resolveStart({ port: actualPort, server: httpServer, close })
    })
  })
}

// ─── Modo CLI (script `yarn start`) ─────────────────────────────────────────
// Cuando se ejecuta como script (no `require`d por Electron), arranca y maneja
// las señales de cierre por sí mismo. Bajo Electron, el proceso principal hace
// `require()` de este módulo y llama start() directamente, así que esta rama no
// corre y el manejo de señales lo hace Electron.
if (require.main === module) {
  start().then(({ close }) => {
    const shutdown = (signal: string) => {
      console.log(`\n[standalone] ${signal} recibido → cerrando…`)
      close().then(() => process.exit(0))
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  }).catch((err) => {
    console.error('[standalone] Error al arrancar:', err)
    process.exit(1)
  })
}
