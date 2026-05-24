#!/usr/bin/env node
// ─── Release del editor: bump de versión → empaquetar .dmg → subir a S3 ───────
//
//   yarn release            # bump patch (0.1.0 → 0.1.1)
//   yarn release minor      # 0.1.0 → 0.2.0
//   yarn release major      # 0.1.0 → 1.0.0
//
// Pasos:
//   1) exige árbol git limpio,
//   2) `npm version <tipo>` → bumpea package.json + commit "release: vX.Y.Z" + tag,
//   3) empaqueta el .dmg (yarn dist:mac),
//   4) sube a s3://parallax-editor-versions (público): el .dmg versionado +
//      latest.dmg + versions.json + index.html (página de descarga),
//   5) push del commit + tag.
//
// Lo corre el DEV (usa el aws del host). Daniela solo descarga del link público.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUCKET = 'parallax-editor-versions'
const REGION = 'us-east-1'
const WEB = `http://${BUCKET}.s3-website-${REGION}.amazonaws.com`

const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
const cap = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1) }

const bump = (process.argv[2] || 'patch').toLowerCase()
if (!['patch', 'minor', 'major'].includes(bump)) {
  fail(`Tipo de bump inválido: "${bump}". Usa: patch | minor | major.`)
}

// 1) Árbol git limpio.
if (cap('git status --porcelain')) {
  fail('El árbol git no está limpio. Commitea o descarta los cambios antes del release.')
}

// 2) Bump de versión (npm version: package.json + commit + tag vX.Y.Z).
console.log(`\n▶ Bump de versión (${bump})…`)
run(`npm version ${bump} -m "release: v%s"`)
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version
console.log(`  → v${version}`)

// 3) Empaquetar el .dmg.
console.log('\n▶ Empaquetando .dmg (yarn dist:mac)…')
run('yarn dist:mac')
const dmg = resolve(ROOT, 'dist-electron', `Parallax Editor-${version}-arm64.dmg`)
if (!existsSync(dmg)) fail(`No se encontró el .dmg esperado: ${dmg}`)

// 4) Subir a S3 (público).
const key = `Parallax-Editor-${version}-arm64.dmg`
const DMG_CT = '--content-type application/x-apple-diskimage'
console.log(`\n▶ Subiendo a s3://${BUCKET}/ …`)
run(`aws s3 cp "${dmg}" "s3://${BUCKET}/${key}" --region ${REGION} ${DMG_CT}`)
run(`aws s3 cp "${dmg}" "s3://${BUCKET}/latest.dmg" --region ${REGION} ${DMG_CT} --cache-control no-cache`)

// 4b) versions.json (índice acumulado): leer el de S3, agregar esta versión, resubir.
let versions = []
try {
  versions = JSON.parse(cap(`aws s3 cp s3://${BUCKET}/versions.json - --region ${REGION}`))
  if (!Array.isArray(versions)) versions = []
} catch { /* primer release: empieza vacío */ }
versions = versions.filter((v) => v && v.version !== version)
versions.unshift({ version, file: key, date: new Date().toISOString() })
const versionsPath = resolve(ROOT, 'dist-electron', 'versions.json')
writeFileSync(versionsPath, JSON.stringify(versions, null, 2))
run(`aws s3 cp "${versionsPath}" "s3://${BUCKET}/versions.json" --region ${REGION} --content-type application/json --cache-control no-cache`)

// 4c) index.html: página de descarga simple (el bucket es web-hosting).
const rows = versions
  .map((v) => `<li><a href="${encodeURIComponent(v.file)}">v${v.version}</a> — ${new Date(v.date).toLocaleDateString('es-ES')}</li>`)
  .join('')
const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parallax Editor — descargas</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111;color:#eee;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.5}a{color:#7fa8d6}h1{font-weight:700;margin-bottom:4px}.latest{display:inline-block;background:#0066cc;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0}ul{padding-left:18px}li{margin:6px 0;color:#bbb}.note{color:#777;font-size:13px;margin-top:28px}</style></head><body><h1>Parallax Editor</h1><p>Última versión: <strong>v${version}</strong></p><a class="latest" href="latest.dmg">Descargar última (.dmg)</a><h3>Todas las versiones</h3><ul>${rows}</ul><p class="note">Primera vez que la abres (app sin firma): clic derecho sobre la app → <strong>Abrir</strong> → Abrir.</p></body></html>`
const indexPath = resolve(ROOT, 'dist-electron', 'index.html')
writeFileSync(indexPath, html)
run(`aws s3 cp "${indexPath}" "s3://${BUCKET}/index.html" --region ${REGION} --content-type "text/html; charset=utf-8" --cache-control no-cache`)

// 5) Push del commit + tag.
console.log('\n▶ Push del commit + tag…')
run('git push')
run('git push --tags')

console.log(`\n✓ Release v${version} publicado.`)
console.log(`  Página:  ${WEB}`)
console.log(`  Última:  ${WEB}/latest.dmg`)
