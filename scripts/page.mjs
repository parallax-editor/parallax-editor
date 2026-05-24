// ─── Página de descargas del bucket (icon + index.html) ──────────────────────
//
// Fuente única de la página pública. La usa scripts/release.mjs en cada release
// y también se puede correr suelto para refrescar la página sin re-empaquetar:
//   node scripts/page.mjs       # reconstruye index.html desde versions.json en S3
//
// Sube el logo (build/icon-1024.png → icon.png) y un index.html con el logo, la
// última versión, el botón de descarga y la lista de versiones.

import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUCKET = 'parallax-editor-versions'
export const REGION = 'us-east-1'
const run = (c) => execSync(c, { cwd: ROOT, stdio: 'inherit' })
const cap = (c) => execSync(c, { cwd: ROOT, encoding: 'utf8' }).trim()

export function buildIndexHtml(versions) {
  const latest = versions[0]?.version || '—'
  const rows = versions
    .map((v) => `<li><a href="${encodeURIComponent(v.file)}">v${v.version}</a> — ${new Date(v.date).toLocaleDateString('es-ES')}</li>`)
    .join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parallax Editor — descargas</title><link rel="icon" href="icon.png"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111;color:#eee;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.5;text-align:center}a{color:#7fa8d6}img.logo{width:104px;height:104px;border-radius:24px;display:block;margin:0 auto 16px}h1{font-weight:700;margin:0 0 4px}.latest{display:inline-block;background:#0066cc;color:#fff;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:600;margin:18px 0}ul{padding:0;list-style:none;text-align:left;display:inline-block}li{margin:6px 0;color:#bbb}.note{color:#777;font-size:13px;margin-top:30px}</style></head><body><img class="logo" src="icon.png" alt="Parallax Editor"><h1>Parallax Editor</h1><p>Última versión: <strong>v${latest}</strong></p><a class="latest" href="latest.dmg">Descargar última (.dmg)</a><h3>Todas las versiones</h3><ul>${rows}</ul><p class="note">Primera vez (app sin firma): clic derecho sobre la app → <strong>Abrir</strong> → Abrir.</p></body></html>`
}

/**
 * Sube icon.png + index.html al bucket. Si `versions` no se pasa, lo lee de
 * versions.json en S3 (para refrescar la página sin un release completo).
 */
export function uploadPage(versions) {
  run(`aws s3 cp "${resolve(ROOT, 'build', 'icon-1024.png')}" "s3://${BUCKET}/icon.png" --region ${REGION} --content-type image/png`)
  let list = versions
  if (!Array.isArray(list)) {
    try {
      list = JSON.parse(cap(`aws s3 cp s3://${BUCKET}/versions.json - --region ${REGION}`))
    } catch {
      list = []
    }
    if (!Array.isArray(list)) list = []
  }
  const out = resolve(ROOT, 'dist-electron')
  mkdirSync(out, { recursive: true })
  const p = resolve(out, 'index.html')
  writeFileSync(p, buildIndexHtml(list))
  run(`aws s3 cp "${p}" "s3://${BUCKET}/index.html" --region ${REGION} --content-type "text/html; charset=utf-8" --cache-control no-cache`)
}

// pathToFileURL codifica bien rutas con espacios (p.ej. ".../Daniela Reyes/...")
// → la detección de "ejecutado directo" funciona aunque el path tenga espacios.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) uploadPage()
