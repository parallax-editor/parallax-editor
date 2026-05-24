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
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Bucket público (web hosting) con la landing + las descargas. La landing
// (index.html/editor.html/style.css/icon.png) se sube con `yarn deploy:landing`;
// el release solo sube el .dmg + latest.dmg + versions.json (no toca la landing).
const BUCKET = 'parallax-engine'
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

// 3) Empaquetar AMBOS .dmg (x64 + arm64). dist:mac corre --x64 --arm64.
console.log('\n▶ Empaquetando .dmg x64 + arm64 (yarn dist:mac)…')
run('yarn dist:mac')
const dmgDir = resolve(ROOT, 'dist-electron')
const dmgs = readdirSync(dmgDir).filter(
  (f) => f.startsWith(`Parallax Editor-${version}-`) && f.endsWith('.dmg'),
)
const x64Name = dmgs.find((f) => f.includes('-x64'))
const arm64Name = dmgs.find((f) => f.includes('-arm64'))
if (!x64Name || !arm64Name) {
  fail(`Faltan dmgs de v${version} (x64/arm64) en ${dmgDir}. Encontrados: ${dmgs.join(', ') || 'ninguno'}`)
}

// 4) Subir a S3 (público). Cada arch: el .dmg versionado + su latest-<arch>.dmg.
const DMG_CT = '--content-type application/x-apple-diskimage'
console.log(`\n▶ Subiendo a s3://${BUCKET}/ …`)
function uploadDmg(name, latestKey) {
  const dmg = resolve(dmgDir, name)
  const key = name.replace(/ /g, '-')
  run(`aws s3 cp "${dmg}" "s3://${BUCKET}/${key}" --region ${REGION} ${DMG_CT}`)
  run(`aws s3 cp "${dmg}" "s3://${BUCKET}/${latestKey}" --region ${REGION} ${DMG_CT} --cache-control no-cache`)
  return key
}
const x64Key = uploadDmg(x64Name, 'latest-x64.dmg')
const arm64Key = uploadDmg(arm64Name, 'latest-arm64.dmg')
// `latest.dmg` (sin sufijo) sigue apuntando a x64: back-compat + corre en
// cualquier Mac vía Rosetta si alguien usa el link viejo.
run(`aws s3 cp "${resolve(dmgDir, x64Name)}" "s3://${BUCKET}/latest.dmg" --region ${REGION} ${DMG_CT} --cache-control no-cache`)

// 4b) versions.json (índice acumulado): leer el de S3, agregar esta versión, resubir.
let versions = []
try {
  versions = JSON.parse(cap(`aws s3 cp s3://${BUCKET}/versions.json - --region ${REGION}`))
  if (!Array.isArray(versions)) versions = []
} catch { /* primer release: empieza vacío */ }
versions = versions.filter((v) => v && v.version !== version)
// `file` = x64 (back-compat con consumidores viejos); x64/arm64 explícitos para
// la página de descarga.
versions.unshift({ version, file: x64Key, x64: x64Key, arm64: arm64Key, date: new Date().toISOString() })
const versionsPath = resolve(ROOT, 'dist-electron', 'versions.json')
writeFileSync(versionsPath, JSON.stringify(versions, null, 2))
run(`aws s3 cp "${versionsPath}" "s3://${BUCKET}/versions.json" --region ${REGION} --content-type application/json --cache-control no-cache`)

// (La landing — index.html/editor.html/style.css/icon.png — NO se toca aquí;
//  es estática y se publica con `yarn deploy:landing`. El release solo mueve el
//  .dmg + latest.dmg + versions.json.)

// 5) Push del commit + tag.
console.log('\n▶ Push del commit + tag…')
run('git push')
run('git push --tags')

console.log(`\n✓ Release v${version} publicado.`)
console.log(`  Página:           ${WEB}/editor.html`)
console.log(`  Última (Intel):   ${WEB}/latest-x64.dmg`)
console.log(`  Última (Apple):   ${WEB}/latest-arm64.dmg`)
