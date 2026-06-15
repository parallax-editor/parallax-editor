// Unit test del flow PAT Git (Fase 4):
//
//   1. `WorkspaceGit` se acepta y persiste con enum (`authMode`, `provider`).
//   2. `parseGitCredentials` rechaza shapes inválidos / payload demasiado grande.
//   3. publish.ts y deleteWorkspaceSlug usan EL MISMO gate:
//      `git.authMode === 'pat' && username && token ? auth : undefined`
//   4. El token NUNCA se cachea en el workspace (igual que S3) — un cliente
//      malicioso/buggy no puede colarlo via raw.git.

import { transform } from 'esbuild'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname

async function loadWorkspaces() {
  const src = await readFile(`${repoRoot}server/workspaces.ts`, 'utf-8')
  const stubbed = src
    .replace(
      /import \{[^}]+\} from 'fs'/,
      `const statSync = () => ({ isDirectory: () => true });
const accessSync = () => undefined;
const existsSync = () => true;
const mkdirSync = () => undefined;
const constants = { W_OK: 0 };`,
    )
    .replace(
      /import \{ resolve, isAbsolute \} from 'path'/,
      `const resolve = (...args) => args.filter(Boolean).join('/').replace(/\\/+/g, '/');
const isAbsolute = (p) => p.startsWith('/');`,
    )
  const out = await transform(stubbed, { loader: 'ts', format: 'esm' })
  const tmp = await mkdtemp(join(tmpdir(), 'git-pat-test-'))
  const file = join(tmp, 'workspaces.mjs')
  await writeFile(file, out.code)
  const mod = await import(`file://${file}?t=${Date.now()}`)
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
  return mod
}

const { activateWorkspace } = await loadWorkspaces()
const FAKE_REPO = '/tmp/__ws_test_repo__'

// ─── 1) Schema: WorkspaceGit ────────────────────────────────────────────────
// 1a) ausencia → undefined (back-compat puro)
const a = activateWorkspace({ id: 'a', name: 'A', repoPath: FAKE_REPO, contentRoot: 'content', useGit: false })
assert.equal(a.workspace.git, undefined, 'sin git cfg → undefined (no se materializa)')

// 1b) authMode 'pat' + provider github
const b = activateWorkspace({
  id: 'b', name: 'B', repoPath: FAKE_REPO, contentRoot: 'content', useGit: false,
  git: { authMode: 'pat', provider: 'github' },
})
assert.deepEqual(b.workspace.git, { authMode: 'pat', provider: 'github' }, "'pat' + provider válido se preserva")

// 1c) provider desconocido → undefined (pero authMode se mantiene)
const c = activateWorkspace({
  id: 'c', name: 'C', repoPath: FAKE_REPO, contentRoot: 'content', useGit: false,
  git: { authMode: 'pat', provider: 'forgejo' },
})
assert.equal(c.workspace.git.authMode, 'pat')
assert.equal(c.workspace.git.provider, undefined, 'provider desconocido → undefined')

// 1d) authMode desconocido → 'system'
const d = activateWorkspace({
  id: 'd', name: 'D', repoPath: FAKE_REPO, contentRoot: 'content', useGit: false,
  git: { authMode: 'magic' },
})
assert.equal(d.workspace.git.authMode, 'system', 'authMode garbage → system')

// 1e) Los secretos NO se cachean aunque el cliente intente colarlos.
const e = activateWorkspace({
  id: 'e', name: 'E', repoPath: FAKE_REPO, contentRoot: 'content', useGit: false,
  git: { authMode: 'pat', provider: 'github', username: 'alice', token: 'ghp_should_not_persist' },
})
assert.equal(e.workspace.git.username, undefined, 'username NO se cachea en el workspace')
assert.equal(e.workspace.git.token, undefined, 'token NO se cachea en el workspace')

// ─── 2) parseGitCredentials del módulo api.ts ───────────────────────────────
const apiSrc = await readFile(`${repoRoot}server/api.ts`, 'utf-8')
const fnMatch = apiSrc.match(/function parseGitCredentials\([\s\S]*?\n\}/)
assert.ok(fnMatch, 'parseGitCredentials debe extraerse limpio')
const parseSrc = `export ${fnMatch[0]}`
const parseOut = await transform(parseSrc, { loader: 'ts', format: 'esm' })
const tmp2 = await mkdtemp(join(tmpdir(), 'git-parse-test-'))
const parseFile = join(tmp2, 'parse.mjs')
await writeFile(parseFile, parseOut.code)
const { parseGitCredentials } = await import(`file://${parseFile}?t=${Date.now()}`)
await rm(tmp2, { recursive: true, force: true }).catch(() => {})

assert.equal(parseGitCredentials(null), undefined, 'null → undefined')
assert.equal(parseGitCredentials({}), undefined, 'sin gitAuth → undefined')
assert.equal(parseGitCredentials({ gitAuth: { username: 'u' } }), undefined, 'sin token → undefined')
assert.equal(parseGitCredentials({ gitAuth: { username: '   ', token: 't' } }), undefined, 'username vacío tras trim → undefined')
const big = 'x'.repeat(1200)
assert.equal(parseGitCredentials({ gitAuth: { username: 'u', token: big } }), undefined, 'token >1024 → undefined')
assert.deepEqual(
  parseGitCredentials({ gitAuth: { username: '  alice  ', token: 'ghp_xxx' } }),
  { username: 'alice', token: 'ghp_xxx' },
  'shape válido pasa trim y se preserva',
)

// ─── 3) Gate del modo: 'system' descarta PAT aunque el cliente lo mande ─────
const publishSrc = await readFile(`${repoRoot}server/publish.ts`, 'utf-8')
const gateMatch = publishSrc.match(
  /const gitAuthEffective[\s\S]{0,400}?ws\.git\?\.authMode === 'pat' && gitAuth\?\.username && gitAuth\?\.token/,
)
assert.ok(
  gateMatch,
  "publish.ts debe tener el gate `authMode === 'pat' && username && token`. Si la línea cambió, actualiza el test.",
)
// Verifica que aparezca DOS veces: una en publishWorkspaceSlug y otra en
// deleteWorkspaceSlug. La regex global cuenta ocurrencias.
const occurrences = publishSrc.match(
  /ws\.git\?\.authMode === 'pat' && gitAuth\?\.username && gitAuth\?\.token/g,
) || []
assert.equal(
  occurrences.length,
  2,
  `el gate debe estar EN AMBAS funciones (publish + delete). Encontrado: ${occurrences.length}.`,
)

console.log('✓ git PAT flow OK')
