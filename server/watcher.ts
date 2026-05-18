import type { HttpServer } from 'vite'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import chokidar from 'chokidar'
import { WebSocketServer, WebSocket } from 'ws'

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
    broadcast({ type: 'file-changed', path })
  })

  watcher.on('add', (path) => {
    broadcast({ type: 'file-added', path })
  })

  watcher.on('unlink', (path) => {
    broadcast({ type: 'file-deleted', path })
  })
}

function broadcast(data: object) {
  if (!wss) return
  const msg = JSON.stringify(data)
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
    }
  })
}
