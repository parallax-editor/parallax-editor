import chokidar from 'chokidar'
import { WebSocketServer, WebSocket } from 'ws'

let wss: WebSocketServer | null = null

const WATCHER_PORT = 3001

export function setupWatcher(watchPaths: string[]) {
  // Use a separate port to avoid conflicting with Vite's HMR WebSocket
  wss = new WebSocketServer({ port: WATCHER_PORT })
  console.log(`[editor-watcher] WebSocket on ws://localhost:${WATCHER_PORT}`)

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
