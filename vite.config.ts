import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'editor-api',
      configureServer(server) {
        // Load API module async but register middleware sync (before Vite's SPA fallback)
        let apiHandler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null = null

        server.ssrLoadModule('/server/api').then((mod) => {
          apiHandler = mod.createHandler(server)
          console.log('[editor-api] API middleware loaded')
        }).catch((err) => {
          console.error('[editor-api] Failed:', err.message)
        })

        // This middleware runs BEFORE Vite's internal middleware (registered synchronously)
        server.middlewares.use((req, res, next) => {
          const url = req.url || ''
          if (url.startsWith('/api/') || url.match(/^\/content\/(eventos|site)\//)) {
            if (apiHandler) {
              apiHandler(req, res, next)
            } else {
              // API not loaded yet
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
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    dedupe: ['vue'],
  },
  server: {
    port: 3000,
  },
})
