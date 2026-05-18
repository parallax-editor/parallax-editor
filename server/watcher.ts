import chokidar from 'chokidar'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'

let wss: WebSocketServer | null = null

export function setupWatcher(httpServer: Server, watchPaths: string[]) {
  wss = new WebSocketServer({ server: httpServer, path: '/__ws' })

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
