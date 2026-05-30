// Unit test for the pathspec scoping added to server/git.ts in commit 56d618f.
//
// Why this lives in tests/ instead of e2e/: the change is server-side only and
// has nothing to do with the browser. Spinning a real git repo and asserting
// `git log -- <pathspec>` returns the right commits gives stronger coverage
// for THIS change than the engine-render matrix would (which doesn't exercise
// any of the touched code paths). Bundles server/git.ts via esbuild (already a
// project dep) so we run the actual production code, not a reimplementation.

import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const repoRoot = new URL('..', import.meta.url).pathname

const bundled = await build({
  entryPoints: [join(repoRoot, 'server/git.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
})
const moduleDir = mkdtempSync(join(tmpdir(), 'git-test-mod-'))
const tmpModule = join(moduleDir, 'git.cjs')
writeFileSync(tmpModule, bundled.outputFiles[0].text)
const require = createRequire(import.meta.url)
const { gitPendingCommits, gitOriginRecent, gitAheadCount } = require(tmpModule)

const tmpRoot = mkdtempSync(join(tmpdir(), 'pathspec-'))
const origin = join(tmpRoot, 'origin.git')
const work = join(tmpRoot, 'work')
function sh(cmd, cwd = work) {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString()
}
function commit(relPath, content, msg) {
  const abs = join(work, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  sh(`git add "${relPath}"`)
  sh(`git -c user.name=t -c user.email=t@t commit -q -m "${msg}"`)
}

let pass = false
try {
  sh(`git init --bare "${origin}"`, tmpRoot)
  sh(`git clone -q "${origin}" "${work}"`, tmpRoot)
  sh('git checkout -q -B main')
  sh('git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "init"')
  sh('git push -q -u origin main')

  commit('content/foo/site.json', '{"v":1}', 'foo-1')
  commit('content/bar/site.json', '{"v":1}', 'bar-1')
  commit('content/foo/images/x.txt', 'x', 'foo-2')
  sh('git push -q origin main')

  commit('content/foo/site.json', '{"v":2}', 'foo-ahead')
  commit('content/bar/site.json', '{"v":2}', 'bar-ahead')

  // gitAheadCount: scoped vs unscoped
  assert.equal(gitAheadCount(work), 2, 'unscoped ahead = 2')
  assert.equal(gitAheadCount(work, 'content/foo'), 1, 'foo-scoped ahead = 1')
  assert.equal(gitAheadCount(work, 'content/bar'), 1, 'bar-scoped ahead = 1')
  assert.equal(gitAheadCount(work, 'content/nope'), 0, 'missing slug ahead = 0')

  // gitPendingCommits: same scoping for the list
  const allPending = gitPendingCommits(work)
  assert.equal(allPending.length, 2, 'unscoped pending = 2')
  const fooPending = gitPendingCommits(work, 'content/foo')
  assert.equal(fooPending.length, 1, 'foo pending = 1')
  assert.equal(fooPending[0].message, 'foo-ahead')
  const barPending = gitPendingCommits(work, 'content/bar')
  assert.equal(barPending.length, 1, 'bar pending = 1')
  assert.equal(barPending[0].message, 'bar-ahead')

  // gitOriginRecent: 3x window so the scoped filter still surfaces hits
  const originAll = gitOriginRecent(work, 5)
  assert.ok(originAll.length >= 3, 'origin recent ≥ 3')
  const originFoo = gitOriginRecent(work, 5, 'content/foo')
  assert.equal(originFoo.length, 2, 'foo origin recent = 2')
  assert.ok(originFoo.every((c) => c.message.startsWith('foo-')))

  // After a push, nothing remains pending
  sh('git push -q origin main')
  assert.equal(gitAheadCount(work), 0, 'after push, nothing ahead')
  assert.equal(gitPendingCommits(work, 'content/foo').length, 0, 'after push, foo pending empty')

  pass = true
  console.log('✓ git-pathspec test passed — scoping works for ahead-count, pending, and origin-recent')
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(moduleDir, { recursive: true, force: true })
  if (!pass) process.exit(1)
}
