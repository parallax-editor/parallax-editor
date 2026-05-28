#!/usr/bin/env node
// ─── Editor release: version bump → build .dmg → publish GitHub Release ───────
//
//   yarn release            # bump patch (0.1.0 → 0.1.1)
//   yarn release minor      # 0.1.0 → 0.2.0
//   yarn release major      # 0.1.0 → 1.0.0
//
// Steps:
//   1) require a clean git tree,
//   2) `npm version <kind>` → bumps package.json + commits "release: vX.Y.Z" + tags,
//   3) build both .dmgs (x64 + arm64) via `yarn dist:mac`,
//   4) push the commit + tag,
//   5) create the GitHub Release and upload both .dmgs via `gh release create`.
//
// The landing is published separately by GitHub Pages from the `landing/`
// directory (see `.github/workflows/pages.yml`). The download links in the
// landing always point at `/releases/latest/download/Parallax-Editor-<arch>.dmg`,
// so a fresh release immediately becomes the new "latest" with no manual edit.
//
// Run by the maintainer. End users just download from the GitHub Releases page
// (or the landing's download buttons).

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
const cap = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1) }

// Prerequisite: `gh` CLI must be authenticated with push + release permissions
// on this repo.
try { cap('gh auth status') } catch {
  fail('GitHub CLI not authenticated. Run `gh auth login` first.')
}

const bump = (process.argv[2] || 'patch').toLowerCase()
if (!['patch', 'minor', 'major'].includes(bump)) {
  fail(`Invalid bump kind: "${bump}". Use: patch | minor | major.`)
}

// 1) Clean git tree.
if (cap('git status --porcelain')) {
  fail('Git tree is not clean. Commit or discard changes before releasing.')
}

// 2) Version bump (npm version: package.json + commit + tag vX.Y.Z).
console.log(`\n▶ Version bump (${bump})…`)
run(`npm version ${bump} -m "release: v%s"`)
const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version
const tag = `v${version}`
console.log(`  → ${tag}`)

// 3) Build BOTH .dmgs (x64 + arm64). `dist:mac` runs --x64 --arm64.
console.log('\n▶ Building .dmgs x64 + arm64 (yarn dist:mac)…')
run('yarn dist:mac')

// electron-builder writes stable filenames (see electron-builder.yml):
//   Parallax-Editor-x64.dmg  and  Parallax-Editor-arm64.dmg
const dmgDir = resolve(ROOT, 'dist-electron')
const x64Dmg = resolve(dmgDir, 'Parallax-Editor-x64.dmg')
const arm64Dmg = resolve(dmgDir, 'Parallax-Editor-arm64.dmg')
for (const p of [x64Dmg, arm64Dmg]) {
  if (!existsSync(p)) fail(`Missing build artifact: ${p}`)
}

// 4) Push commit + tag (the tag triggers GitHub Actions if any).
console.log('\n▶ Pushing commit + tag…')
run('git push')
run('git push --tags')

// 5) Create the GitHub Release and attach both .dmgs.
//    --generate-notes makes GitHub fill the release body from commit messages.
console.log(`\n▶ Creating GitHub Release ${tag}…`)
const notesFlag = '--generate-notes'
const title = `Parallax Editor ${tag}`
run(`gh release create "${tag}" "${x64Dmg}" "${arm64Dmg}" --title "${title}" ${notesFlag}`)

console.log(`\n✓ Release ${tag} published.`)
console.log(`  Releases page:     https://github.com/parallax-editor/parallax-editor/releases/tag/${tag}`)
console.log(`  Latest (Intel):    https://github.com/parallax-editor/parallax-editor/releases/latest/download/Parallax-Editor-x64.dmg`)
console.log(`  Latest (Apple):    https://github.com/parallax-editor/parallax-editor/releases/latest/download/Parallax-Editor-arm64.dmg`)
