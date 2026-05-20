import type { HttpServer } from 'vite'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import chokidar from 'chokidar'
import { statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { shouldIgnoreSelfWrite } from './selfWrites'

let wss: WebSocketServer | null = null

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

  const watcher = chokidar.watch(
    watchPaths.map((p) => `${p}/**/site.json`),
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500 } },
  )

  watcher.on('change', (path) => {
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

export function broadcast(data: object) {
  if (!wss) return
  const msg = JSON.stringify(data)
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  })
}
