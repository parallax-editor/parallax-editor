import type { HttpServer } from 'vite'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import chokidar from 'chokidar'
import { statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { shouldIgnoreSelfWrite } from './selfWrites'
import { invalidateComponent } from './sfcBundler'

let wss: WebSocketServer | null = null
// Module-level handle so newly-activated workspaces (Fase 2) can extend the
// watched globs at runtime via addWatchPath — without restarting the server.
let activeWatcher: import('chokidar').FSWatcher | null = null
const watchedRoots = new Set<string>()

const WS_PATH = '/__ws'

export function setupWatcher(httpServer: HttpServer, watchPaths: string[]) {
  // Ride on the existing Vite dev server via an HTTP upgrade on WS_PATH —
  // no separate port (avoids colliding with sibling dev servers).
  wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url !== WS_PATH) return
    wss!.handleUpgrade(request, socket, head, (client) => {
      wss!.emit('connection', client, request)
    })
  })
  console.log(`[editor-watcher] WebSocket on ${WS_PATH} (shared Vite server)`)

  // Watch both site.json (auto-reload the canvas) AND .vue files under each
  // workspace's `components/` folder (invalidate server-side SFC bundles +
  // broadcast a `component-changed` so CustomComponentHost can re-import).
  const globs = watchPaths.flatMap((p) => [
    `${p}/**/site.json`,
    `${p}/components/*.vue`,
  ])
  const watcher = chokidar.watch(globs, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 },
  })
  activeWatcher = watcher
  for (const p of watchPaths) watchedRoots.add(p)

  watcher.on('change', (path) => {
    // Workspace SFC changed → drop its compiled bundle from the cache and
    // tell connected clients to re-import the component.
    if (path.endsWith('.vue')) {
      invalidateComponent(path)
      broadcast({ type: 'component-changed', path })
      return
    }
    // Self-write suppression (PLAN §16): if this change is the editor's own
    // write of site.json (manual Guardar / Autosave), don't broadcast — the
    // client must not reload and discard the user's selection. We match by
    // absolute path + current on-disk size against what writeProject just
    // wrote. An EXTERNAL change (claude -p, hand edit) has no marker (or a
    // different size) and still broadcasts → reload, exactly as before.
    let size = -1
    try {
      size = statSync(path).size
    } catch {
      // Can't stat (deleted/raced) → can't be a matched self-write; broadcast.
    }
    if (size >= 0 && shouldIgnoreSelfWrite(path, size)) {
      return
    }
    broadcast({ type: 'file-changed', path })
  })

  watcher.on('add', (path) => {
    broadcast({ type: 'file-added', path })
  })

  watcher.on('unlink', (path) => {
    broadcast({ type: 'file-deleted', path })
  })
}

/**
 * Add a workspace repo to the live site.json watch set (Fase 2). Idempotent —
 * a repo that's already watched (e.g. the two seeded defaults) is skipped.
 * No-op until setupWatcher has run.
 */
export function addWatchPath(repoPath: string) {
  if (!repoPath || !activeWatcher || watchedRoots.has(repoPath)) return
  watchedRoots.add(repoPath)
  activeWatcher.add(`${repoPath}/**/site.json`)
  activeWatcher.add(`${repoPath}/components/*.vue`)
}

export function broadcast(data: object) {
  if (!wss) return
  const msg = JSON.stringify(data)
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  })
}


/**
 * Limpieza para `app before-quit` (electron/main.cjs) y para los tests:
 * cierra el WebSocketServer (termina clientes conectados) y await el
 * chokidar watcher (libera la atadura nativa fsevents en macOS). Sin esto,
 * al cerrar la app instalada desde el .dmg el proceso muere con fsevents
 * todavía activo y macOS muestra el modal "Parallax Editor quit unexpectedly".
 * Idempotente: dos llamadas seguidas son seguras.
 */
export async function closeWatcher(): Promise<void> {
  const tasks: Promise<unknown>[] = []
  if (wss) {
    const local = wss
    wss = null
    tasks.push(
      new Promise<void>((r) => {
        try {
          for (const client of local.clients) {
            try { client.terminate() } catch { /* ignore */ }
          }
          local.close(() => r())
        } catch { r() }
      }),
    )
  }
  if (activeWatcher) {
    const local = activeWatcher
    activeWatcher = null
    watchedRoots.clear()
    tasks.push(local.close().catch(() => undefined))
  }
  await Promise.all(tasks)
}
