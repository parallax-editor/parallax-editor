import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'

// Absolute path to server/ so the watcher can scope changes to JUST the
// API/middleware code (never client files → never an HMR/restart loop).
const SERVER_DIR = resolve(__dirname, 'server')

// Versión de la app, horneada en el bundle del SPA (visible en el editor). Sale
// de package.json — `yarn release` (npm version) la bumpea antes de empaquetar.
const APP_VERSION = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version

export default defineConfig({
  plugins: [
    // ── Auto-reload the API middleware on server/**/*.ts edits ──────────────
    // The REST API (server/api.ts) is loaded ONCE via configureServer's
    // ssrLoadModule, so editing any server/*.ts had NO effect until the user
    // manually restarted :3000 (the cause of stale 404s on new routes).
    //
    // This plugin watches server/**/*.ts on Vite's OWN file watcher (the
    // chokidar instance Vite already runs — no extra process) and calls
    // server.restart() when one changes. server.restart() tears down and
    // re-runs the dev server in-process: configureServer fires again, the
    // freshest server/api.ts is re-imported via ssrLoadModule, the /__ws
    // watcher + asset route + client HMR are all re-wired exactly as on a
    // cold boot — but the user's `vite` process and the :3000 socket stay up,
    // so it is transparent (no manual restart, browser auto-reconnects).
    //
    // Loop-safety: the watcher glob is scoped to SERVER_DIR only, and the
    // change handler hard-filters to paths under server/ ending in .ts.
    // Client files therefore never trigger restart() (they keep normal HMR),
    // and a restart does not itself rewrite any server file, so there is no
    // feedback loop. Restarts are debounced (150ms) and guarded by an
    // in-flight flag so a burst of saves coalesces into a single restart.
    {
      name: 'editor-api-autoreload',
      configureServer(server) {
        let pending: NodeJS.Timeout | null = null
        let restarting = false

        const isServerTs = (file: string) =>
          (file.startsWith(SERVER_DIR + '/') || file.startsWith(SERVER_DIR + '\\')) &&
          file.endsWith('.ts')

        const onChange = (file: string) => {
          if (!isServerTs(file) || restarting) return
          if (pending) clearTimeout(pending)
          pending = setTimeout(async () => {
            pending = null
            restarting = true
            const rel = file.slice(SERVER_DIR.length + 1)
            server.config.logger.info(
              `[editor-api] server/${rel} changed → restarting API (no manual restart needed)`,
            )
            try {
              await server.restart()
            } catch (err: any) {
              restarting = false
              server.config.logger.error(`[editor-api] restart failed: ${err?.message || err}`)
            }
            // On a successful restart this plugin instance is discarded and a
            // fresh configureServer runs, so `restarting` is never cleared in
            // the success path by design (the closure dies with the old server).
          }, 150)
        }

        // Vite watches the project root but ignores node_modules etc.; server/
        // *.ts are inside the root so they are already watched. add() is
        // idempotent and guarantees coverage even if a future Vite default
        // excludes them.
        server.watcher.add(`${SERVER_DIR}/**/*.ts`)
        server.watcher.on('change', onChange)
        server.watcher.on('add', onChange)
        server.watcher.on('unlink', onChange)
      },
    },
    vue(),
    {
      name: 'editor-api',
      configureServer(server) {
        let apiHandler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null = null

        server.ssrLoadModule('/server/api').then((mod) => {
          // FASE 1: createHandler no longer needs the whole ViteDevServer — only
          // the HTTP server (for the /__ws watcher). Pass it via the options
          // object. The component-registry loader is now esbuild-based (no
          // ssrLoadModule) and resolves the workspace internally.
          apiHandler = mod.createHandler({ httpServer: server.httpServer })
          console.log('[editor-api] API middleware loaded')
        }).catch((err) => {
          console.error('[editor-api] Failed:', err.message)
        })

        server.middlewares.use((req, res, next) => {
          const url = req.url || ''
          // /content/<workspaceId>/... para CUALQUIER workspace (no solo los
          // seeds eventos/site) — si no, las imágenes de un workspace con id
          // nuevo (p.ej. solo-disco) caen al SPA y se ven rotas.
          if (url.startsWith('/api/') || url.match(/^\/content\/[^/]+\//)) {
            if (apiHandler) {
              apiHandler(req, res, next)
            } else {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end('{"error":"API loading..."}')
            }
          } else {
            next()
          }
        })
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    // `@parallax-editor/parallax-engine` resolves from node_modules via its
    // exports map (main/schema/style.css). Local development against a
    // sibling engine checkout is handled by `yarn link`, not by a hardcoded
    // path alias.
    dedupe: ['vue'],
  },
  optimizeDeps: {
    include: ['vue', 'vue-router', 'pinia'],
    exclude: ['@parallax-editor/parallax-engine'],
  },
  server: {
    port: 3000,
    hmr: {
      overlay: false,
    },
  },
})
