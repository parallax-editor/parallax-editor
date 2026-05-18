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
        let apiHandler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null = null

        server.ssrLoadModule('/server/api').then((mod) => {
          apiHandler = mod.createHandler(server)
          console.log('[editor-api] API middleware loaded')
        }).catch((err) => {
          console.error('[editor-api] Failed:', err.message)
        })

        server.middlewares.use((req, res, next) => {
          const url = req.url || ''
          if (url.startsWith('/api/') || url.match(/^\/content\/(eventos|site)\//)) {
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
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      'parallax-engine/schema': resolve(__dirname, '..', 'parallax-engine', 'dist', 'schema.js'),
      'parallax-engine': resolve(__dirname, '..', 'parallax-engine', 'dist', 'index.js'),
    },
    dedupe: ['vue'],
  },
  optimizeDeps: {
    include: ['vue', 'vue-router', 'pinia'],
    exclude: ['parallax-engine'],
  },
  server: {
    port: 3000,
    hmr: {
      overlay: false,
    },
  },
})
