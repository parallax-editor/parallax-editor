/**
 * Tiny zero-dependency static server for the engine render-matrix suite.
 *
 * This is the e2e repo's OWN server (NOT a user dev server) — starting/stopping
 * it is fine and conflicts with nothing on :3000/:3001/:3002. It binds an
 * unused high port (default 41789, override with MATRIX_PORT) on 127.0.0.1 and
 * FAILS LOUDLY (rejects) if the port is already taken.
 *
 * Routes (all read-only, GET/HEAD only):
 *   /                  -> enginematrix/index.html
 *   /index.html        -> enginematrix/index.html
 *   /mount.mjs         -> enginematrix/mount.mjs
 *   /fixtures/<n>.json -> enginematrix/fixtures/<n>.json
 *   /assets/<f>        -> enginematrix/assets/<f>     (tiny local test images)
 *   /engine/<f>        -> ../../parallax-engine/dist/<f>  (built bundle: index.js, schema.js, style.css)
 *   /vendor/vue.esm-browser.js -> engine node_modules Vue 3 ESM (single instance)
 *   /vendor/lenis.mjs          -> engine node_modules lenis ESM
 *
 * Used by ../suites/engine-matrix.cjs (start before Playwright, stop in
 * finally). Can also run standalone for manual debugging:
 *   node enginematrix/server.cjs
 * then open http://127.0.0.1:41789/?fixture=anchors-all
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.MATRIX_PORT || 41789)
const HOST = '127.0.0.1'

const HERE = __dirname
// e2e/ vive DENTRO de parallax-editor (autocontenido). parallax-engine es
// hermano de parallax-editor, así que desde e2e/enginematrix/ son 3 niveles
// arriba: enginematrix → e2e → parallax-editor → (workspace) → parallax-engine.
const ENGINE_DIST = path.resolve(HERE, '..', '..', '..', 'parallax-engine', 'dist')
const ENGINE_NM = path.resolve(HERE, '..', '..', '..', 'parallax-engine', 'node_modules')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, `not found: ${filePath}`)
    send(res, 200, buf, MIME[path.extname(filePath)] || 'application/octet-stream')
  })
}

// Resolve a request path to an absolute file, refusing path traversal.
function resolveTarget(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0])

  if (clean === '/' || clean === '/index.html') {
    return path.join(HERE, 'index.html')
  }
  if (clean === '/mount.mjs') return path.join(HERE, 'mount.mjs')

  const prefixDirs = {
    '/fixtures/': path.join(HERE, 'fixtures'),
    '/assets/': path.join(HERE, 'assets'),
    '/engine/': ENGINE_DIST,
    '/shots/': path.join(HERE, 'shots'),
  }
  for (const [prefix, dir] of Object.entries(prefixDirs)) {
    if (clean.startsWith(prefix)) {
      const f = path.normalize(clean.slice(prefix.length))
      if (f.includes('..') || path.isAbsolute(f)) return null
      return path.join(dir, f)
    }
  }

  if (clean === '/vendor/vue.esm-browser.js') {
    return path.join(ENGINE_NM, 'vue', 'dist', 'vue.esm-browser.js')
  }
  if (clean === '/vendor/lenis.mjs') {
    return path.join(ENGINE_NM, 'lenis', 'dist', 'lenis.mjs')
  }
  return null
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed')
    }
    const target = resolveTarget(req.url)
    if (!target) return send(res, 404, `no route: ${req.url}`)
    sendFile(res, target)
  })
}

function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error(
          `MATRIX_PORT ${port} is already in use. The engine-matrix suite ` +
          `needs an unused high port. Free it or set MATRIX_PORT=<other>.`,
        ))
      } else {
        reject(err)
      }
    })
    server.listen(port, HOST, () => {
      resolve({
        server,
        origin: `http://${HOST}:${port}`,
        stop: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

module.exports = { start, PORT, HOST }

// Standalone debug mode.
if (require.main === module) {
  start().then(({ origin }) => {
    // eslint-disable-next-line no-console
    console.log(`enginematrix static server: ${origin}`)
    console.log(`try: ${origin}/?fixture=anchors-all`)
  }).catch((e) => {
    console.error(String((e && e.message) || e))
    process.exit(2)
  })
}
