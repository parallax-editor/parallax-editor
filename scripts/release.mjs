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
import { uploadPage } from './page.mjs'

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
// Buscar el .dmg por patrón (el sufijo de arch varía: -x64 / -arm64).
const dmgDir = resolve(ROOT, 'dist-electron')
const dmgName = readdirSync(dmgDir).find((f) => f.startsWith(`Parallax Editor-${version}`) && f.endsWith('.dmg'))
if (!dmgName) fail(`No se encontró el .dmg de v${version} en ${dmgDir}`)
const dmg = resolve(dmgDir, dmgName)

// 4) Subir a S3 (público). Key sin espacios.
const key = dmgName.replace(/ /g, '-')
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

// 4c) Página de descargas (logo icon.png + index.html). Fuente única en
// scripts/page.mjs (también corrible suelto: `node scripts/page.mjs`).
uploadPage(versions)

// 5) Push del commit + tag.
console.log('\n▶ Push del commit + tag…')
run('git push')
run('git push --tags')

console.log(`\n✓ Release v${version} publicado.`)
console.log(`  Página:  ${WEB}`)
console.log(`  Última:  ${WEB}/latest.dmg`)
