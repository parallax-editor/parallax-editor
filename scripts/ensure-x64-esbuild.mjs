// ─── Asegura el binario de esbuild para Intel (x64) ──────────────────────────
//
// El editor empaqueta para x64 (la Mac de Daniela es Intel), pero `yarn install`
// en una Mac Apple Silicon solo instala el binario de esbuild de SU arch
// (@esbuild/darwin-arm64). Sin el de x64, el .app x64 llevaría un esbuild arm64
// que NO corre en Intel → al cargar parallax.config.ts (componentes custom)
// fallaría. Este script baja el binario x64 del registry si falta, así el build
// x64 es reproducible en cualquier máquina de dev. Corre antes de dist:*.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binPath = resolve(ROOT, 'node_modules/@esbuild/darwin-x64/bin/esbuild')

if (existsSync(binPath)) {
  console.log('[ensure-x64-esbuild] @esbuild/darwin-x64 ya presente.')
  process.exit(0)
}

const version = JSON.parse(
  readFileSync(resolve(ROOT, 'node_modules/esbuild/package.json'), 'utf8'),
).version
const dest = resolve(ROOT, 'node_modules/@esbuild/darwin-x64')
const tgz = '/tmp/esbuild-darwin-x64.tgz'
const url = `https://registry.npmjs.org/@esbuild/darwin-x64/-/darwin-x64-${version}.tgz`

console.log(`[ensure-x64-esbuild] descargando ${url}`)
execSync(`curl -fsSL "${url}" -o "${tgz}"`, { stdio: 'inherit' })
mkdirSync(dest, { recursive: true })
execSync(`tar -xzf "${tgz}" -C "${dest}" --strip-components=1`, { stdio: 'inherit' })
execSync(`rm -f "${tgz}"`)
console.log(`[ensure-x64-esbuild] OK → @esbuild/darwin-x64 v${version}`)
