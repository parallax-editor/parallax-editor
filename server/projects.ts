import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync, rmSync, statSync } from 'fs'
import { resolve, relative } from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { markSelfWrite } from './selfWrites'
// SINGLE canonical slug transform (TASK 2) — the SAME function the create
// panel uses for its live read-only preview, so the previewed slug ALWAYS
// equals the folder we create here.
import { slugify } from './slug'
// Single source of truth for the schema version of NEW projects. The engine
// (parallax-engine/schema, no Vue dep) is THE contract; sourcing the constant
// from it keeps new files aligned as the engine evolves. Resolved through the
// editor's normal module resolution (symlinked dist). Falls back to the
// current engine value if the import ever fails so createProject never throws.
import { SCHEMA_VERSION as ENGINE_SCHEMA_VERSION } from 'parallax-engine/schema'
// Fase 2: the hardcoded REPO_MAP/contentDir are gone. `type` is now a WORKSPACE
// ID resolved through the host-side workspace registry (server/workspaces.ts).
// The seeded default workspaces use ids 'eventos'/'site' with the SAME
// repo/contentRoot as before, so every existing call path is unchanged.
import { workspaceContentDir, workspaceRepoPath } from './workspaces'

const SCHEMA_VERSION: string =
  typeof ENGINE_SCHEMA_VERSION === 'string' && /^\d+\.\d+$/.test(ENGINE_SCHEMA_VERSION)
    ? ENGINE_SCHEMA_VERSION
    : '1.1'

// `type` is a workspace id throughout this module (kept the param name `type`
// to minimize churn against the existing call sites in server/api.ts).
function contentDir(type: string): string {
  const dir = workspaceContentDir(type)
  if (!dir) throw new Error(`Unknown workspace: ${type}`)
  return dir
}

export function listProjects(type: string): { slug: string; title: string; updatedAt: number }[] {
  const dir = contentDir(type)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, 'site.json')))
    .map((d) => {
      const file = resolve(dir, d.name, 'site.json')
      // `updatedAt` = the site.json file mtime in ms. Drives the "most recently
      // edited first" sort in ProjectSelector — autosave/Guardar rewrite this
      // file (writeProject), so its mtime is the truest signal of recent work.
      // A stat failure (race) falls back to 0 so the project still lists.
      let updatedAt = 0
      try {
        updatedAt = statSync(file).mtimeMs
      } catch {
        /* race: file vanished between readdir and stat → 0 (sorts last) */
      }
      try {
        const json = JSON.parse(readFileSync(file, 'utf-8'))
        return { slug: d.name, title: json.meta?.title || d.name, updatedAt }
      } catch {
        return { slug: d.name, title: d.name, updatedAt }
      }
    })
}

export function readProject(type: string, slug: string): object | null {
  const file = resolve(contentDir(type), slug, 'site.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf-8'))
}

export function writeProject(type: string, slug: string, data: object): void {
  const dir = resolve(contentDir(type), slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = resolve(dir, 'site.json')
  const content = JSON.stringify(data, null, 2)
  writeFileSync(file, content, 'utf-8')
  // Tag this path so the chokidar watcher (server/watcher.ts) skips the WS
  // broadcast for the change WE just caused — autosave/Guardar must not force
  // the client to reload and lose the user's selection. External edits (no
  // marker) still broadcast. Size = byte length actually written so a racing
  // external edit with different content is not suppressed.
  markSelfWrite(file, Buffer.byteLength(content, 'utf-8'))
}

/**
 * Create a new project from a FREE-FORM, human-typed name (TASK 2).
 *  - `meta.title` is the typed name VERBATIM (the HTML <title>).
 *  - The folder/route slug is derived with the SHARED `slugify()` — the exact
 *    transform the create panel previews live, so preview === created folder.
 *  - Empty/blank name → falls back to "sitio". On slug collision we
 *    auto-increment "<slug>-2", "<slug>-3", … (GAP10 collision pattern) so
 *    creating a duplicate name never errors.
 * Returns the slug actually created so the UI can show/open it.
 */
export function createProject(type: string, name: string): string {
  const title = typeof name === 'string' ? name.trim() : ''
  const base = slugify(title) || 'sitio'
  const dir = contentDir(type)

  let slug = base
  let n = 2
  while (existsSync(resolve(dir, slug))) {
    slug = `${base}-${n}`
    n++
  }

  const projDir = resolve(dir, slug)
  mkdirSync(resolve(projDir, 'images'), { recursive: true })
  const template = {
    // Align NEW projects with the engine's current schema version (sourced
    // from parallax-engine/schema). Additive/back-compat: '1.0' files still
    // load; this just keeps fresh files consistent with the contract.
    schemaVersion: SCHEMA_VERSION,
    // The HTML <title> is the name the human typed, verbatim — NOT the slug.
    // Empty name → derive a readable title from the slug as a graceful
    // fallback so meta.title is never blank.
    meta: { title: title || base.replace(/-/g, ' '), lang: 'es' },
    sections: [],
  }
  writeFileSync(resolve(projDir, 'site.json'), JSON.stringify(template, null, 2), 'utf-8')
  return slug
}

// Sanitize a user-proposed slug to the workspace convention (kebab-case, no
// accents, lowercase). Empty → null so the caller falls back to auto-naming.
function sanitizeSlug(raw: unknown): string | null {
  // Delegate to the SHARED canonical transform (TASK 2) so create + duplicate
  // + the live panel preview all use exactly ONE slug rule.
  return slugify(raw) || null
}

/**
 * Duplicate a project folder. Previously it ALWAYS used `<slug>-copia` and
 * `cpSync` threw if that already existed (duplicating twice = 500). Now:
 *  - An explicit `desiredSlug` (from the selector's Spanish prompt) is honored
 *    when given and free.
 *  - Otherwise the base is `<slug>-copia`; on collision we auto-increment
 *    `-copia-2`, `-copia-3`, … until a free slug is found.
 * Returns the slug actually created so the UI can show/open it.
 */
export function duplicateProject(
  type: string,
  slug: string,
  desiredSlug?: string,
): string {
  const src = resolve(contentDir(type), slug)
  const dir = contentDir(type)
  const wanted = sanitizeSlug(desiredSlug)

  let newSlug: string
  if (wanted && !existsSync(resolve(dir, wanted))) {
    newSlug = wanted
  } else {
    const base = wanted || `${slug}-copia`
    newSlug = base
    let n = 2
    while (existsSync(resolve(dir, newSlug))) {
      newSlug = `${base}-${n}`
      n++
    }
  }
  const dest = resolve(dir, newSlug)
  cpSync(src, dest, { recursive: true })
  return newSlug
}

export function deleteProject(type: string, slug: string): void {
  const dir = resolve(contentDir(type), slug)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
}

export function getRepoPath(type: string): string {
  return workspaceRepoPath(type)
}

/**
 * The active site's content directory expressed RELATIVE to its repo root —
 * `content/<slug>` for eventos, `content/portafolio/<slug>` for site. Used by
 * the scoped save commit (`server/git.ts` → `gitCommit`) so a "Guardar" stages
 * ONLY that one site's files (security: never sweep in other sites / unrelated
 * repo changes). Returns '' for an unknown type so the caller can refuse.
 */
export function getContentRelPath(type: string, slug: string): string {
  const repo = workspaceRepoPath(type)
  if (!repo) return ''
  return relative(repo, resolve(contentDir(type), slug))
}

export function getAssetPath(type: string, slug: string, assetPath: string): string {
  return resolve(contentDir(type), slug, assetPath)
}

/**
 * BLINDAJE (#claude-no-change): firma del contenido de un site para detectar si
 * una corrida de `claude -p` REALMENTE cambió algo. Hashea el `site.json`
 * (lo que Claude edita) byte a byte + un inventario `relpath:tamaño` del resto
 * de archivos (detecta agregar/quitar/reemplazar assets sin leer sus bytes).
 * Tomada ANTES y DESPUÉS del run: si la firma no cambió, Claude dijo que hizo
 * algo pero el archivo quedó intacto → el editor avisa. Determinista; ante
 * cualquier error de lectura devuelve lo que pudo (nunca lanza).
 */
export function contentSignature(type: string, slug: string): string {
  const dir = resolve(contentDir(type), slug)
  const h = createHash('sha1')
  try {
    h.update(readFileSync(resolve(dir, 'site.json')))
  } catch {
    h.update('<no-site.json>')
  }
  const inv: string[] = []
  const walk = (d: string, rel: string) => {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = readdirSync(d, { withFileTypes: true }) as any[]
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === 'site.json') continue // ya hasheado byte a byte arriba
      const p = resolve(d, e.name)
      if (e.isDirectory()) walk(p, r)
      else {
        try {
          inv.push(`${r}:${statSync(p).size}`)
        } catch {
          /* archivo desaparecido entre readdir y stat — ignorar */
        }
      }
    }
  }
  walk(dir, '')
  inv.sort()
  h.update(inv.join('|'))
  return h.digest('hex')
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv'])
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.flac'])
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2'])

// Asset "kind" → content subdir + the relative src prefix stored in site.json.
// Layout (confirmed via workspace CLAUDE.md + neighbor repos):
//   eventos: content/<slug>/{images,audio,video}
//   site:    content/portafolio/<slug>/{images,audio,video}
// Consumers resolve a relative src by prefixing /content/<slug>/ (and the
// editor preview serves /content/(eventos|site)/<slug>/<src>) — so the src
// is simply "<subdir>/<file>".
// 'font' added (TASK #73): custom typefaces uploaded from the FUENTES list go
// to content/<...>/fonts/ and are stored in site.json as meta.fonts[].url =
// "fonts/<file>" (engine injects @font-face from that url).
export type AssetKind = 'image' | 'video' | 'audio' | 'font'

const KIND_DIR: Record<AssetKind, string> = {
  image: 'images',
  video: 'video',
  audio: 'audio',
  font: 'fonts',
}

const KIND_EXTS: Record<AssetKind, Set<string>> = {
  image: IMAGE_EXTS,
  video: VIDEO_EXTS,
  audio: AUDIO_EXTS,
  font: FONT_EXTS,
}

const KIND_FALLBACK_EXT: Record<AssetKind, string> = {
  image: '.png',
  video: '.mp4',
  audio: '.mp3',
  font: '.woff2',
}

const KIND_LABEL: Record<AssetKind, string> = {
  image: 'imágenes',
  video: 'video',
  audio: 'audio',
  font: 'fuentes',
}

/**
 * Classify a mime string into an asset kind, or null if unsupported.
 * Font mimes are notoriously inconsistent across browsers/OSes
 * (`font/ttf`, `font/woff2`, `application/font-woff`, `application/x-font-ttf`,
 * and very often a generic `application/octet-stream`). We therefore detect a
 * font by: a `font/` prefix, OR an `application/*font*` mime, OR (the common
 * octet-stream case) the trailing filename extension being a known font ext.
 */
export function assetKindFromMime(mime: string, filename?: string): AssetKind | null {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('font/')) return 'font'
  if (m.startsWith('application/') && m.includes('font')) return 'font'
  if (filename) {
    const dot = filename.lastIndexOf('.')
    const ext = dot > 0 ? filename.slice(dot).toLowerCase() : ''
    if (FONT_EXTS.has(ext)) return 'font'
  }
  return null
}

/**
 * Sanitize an uploaded filename → kebab-case, no accents, lowercased, keep
 * extension. Mirrors the slug convention used across the workspace
 * (kebab-case, no accents). Falls back to "archivo" if the base becomes empty.
 * `kind` decides which extensions are valid and the fallback extension.
 */
export function sanitizeAssetFilename(original: string, kind: AssetKind = 'image'): string {
  const dot = original.lastIndexOf('.')
  const rawExt = dot > 0 ? original.slice(dot).toLowerCase() : ''
  const rawBase = dot > 0 ? original.slice(0, dot) : original
  const base = rawBase
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents (combining diacriticals)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alnum → hyphen
    .replace(/^-+|-+$/g, '') // trim hyphens
    .replace(/-{2,}/g, '-') || 'archivo'
  const ext = KIND_EXTS[kind].has(rawExt) ? rawExt : KIND_FALLBACK_EXT[kind]
  return `${base}${ext}`
}

export interface SaveAssetResult {
  /** Relative src to store in site.json — `<subdir>/<file>` (images/, video/, audio/, fonts/). */
  src: string
  filename: string
  bytes: number
  kind: AssetKind
}

/**
 * Outcome of the atomic per-asset git commit attached to add/delete (TASK #102).
 *
 * The asset commit and the site.json autosave/Guardar commit are independent:
 * an upload that triggers a save will produce two short, well-named commits
 * (`asset+: …` then the autosave message) — that's clearer than one big mixed
 * commit and survives a crash between upload and save with the file already
 * versioned. `--no-verify` is used (same rationale as `gitCommit` in
 * server/git.ts — uploads must be instant and never blocked by the pre-commit
 * test suite).
 *
 * `commit: 'skipped'` is a soft fallback: when the repo is in a bad state (no
 * `.git`, detached HEAD, lock contention, etc.) we DO NOT fail the upload —
 * the file is on disk, we just couldn't version it. `warning` carries a short
 * Spanish line the UI can show, mirroring the existing `warning` channel.
 */
export interface AssetCommitInfo {
  commit: 'ok' | 'skipped'
  commitMessage?: string
  warning?: string
}

/**
 * Stage and commit a SINGLE asset path inside one of the content repos as its
 * own atomic commit. NEVER touches paths outside `<repoRoot>/<relPath>`.
 *
 *  - `op: 'add'`    → `git add <relPath>` then commit (`asset+: …`).
 *  - `op: 'delete'` → `git add -A <relPath>` (records the deletion) then
 *    commit (`asset-: …`). `git rm` would refuse if the file was never
 *    tracked — `add -A <path>` handles both tracked-and-deleted and the
 *    (rare) "never-tracked-and-already-gone" cases uniformly.
 *
 * On ANY git failure we swallow the error and return `commit:'skipped'` so
 * the calling endpoint returns a normal success with a `warning`. The asset
 * remains on disk (add) or gone from disk (delete) — versioning is the only
 * thing missing, and the next site.json autosave's broad `git add -A` will
 * sweep it up just like the pre-#102 behavior.
 *
 * `--no-verify` matches `gitCommit` (server/git.ts): uploads must be
 * instant and never blocked by the repo's pre-commit hook (full offline
 * lint+test suite — fine for human commits, unusable on a click). Content
 * correctness is enforced elsewhere (engine `validateSite` on load,
 * "Publicar" re-validates before push).
 */
function commitOneAsset(
  type: string,
  op: 'add' | 'delete',
  relPathInsideRepo: string,
  displayName: string,
): AssetCommitInfo {
  const repo = workspaceRepoPath(type)
  if (!repo || !existsSync(resolve(repo, '.git'))) {
    return { commit: 'skipped', warning: 'Archivo guardado pero no versionado (sin repo git).' }
  }
  // Containment guard: never let a smuggled `..` or absolute path land in the
  // git command. The caller already builds this from controlled inputs, but
  // this is the LAST line where we still have a chance to refuse.
  if (
    !relPathInsideRepo ||
    relPathInsideRepo.startsWith('/') ||
    relPathInsideRepo.split(/[\\/]/).some((seg) => seg === '..')
  ) {
    return { commit: 'skipped', warning: 'Archivo guardado pero no versionado (ruta inválida).' }
  }
  const message = `${op === 'add' ? 'asset+' : 'asset-'}: ${displayName}`
  try {
    if (op === 'add') {
      execFileSync('git', ['add', '--', relPathInsideRepo], {
        cwd: repo,
        stdio: 'pipe',
        timeout: 15000,
      })
    } else {
      // `add -A <path>` records the deletion of a tracked file AND ignores a
      // path that was never tracked (idempotent). Safer than `git rm` here
      // because the asset may have been uploaded mid-session and never
      // committed yet (e.g. if a prior commit was skipped).
      execFileSync('git', ['add', '-A', '--', relPathInsideRepo], {
        cwd: repo,
        stdio: 'pipe',
        timeout: 15000,
      })
    }
    // `--allow-empty` is NOT used: if there is genuinely nothing to commit
    // (e.g. the file was already in the index identically), we want the
    // catch branch to fire and fall back to 'skipped' rather than littering
    // history with empty commits.
    // `-m <msg>` must come BEFORE `--` because everything after `--` is a
    // pathspec. `--only` restricts the commit to ONLY the paths listed
    // (matches our staged change), even though we already added explicitly —
    // belt-and-suspenders so an unrelated staged change can never sneak in.
    execFileSync('git', ['commit', '--no-verify', '--only', '-m', message, '--', relPathInsideRepo], {
      cwd: repo,
      stdio: 'pipe',
      timeout: 15000,
    })
    return { commit: 'ok', commitMessage: message }
  } catch {
    return {
      commit: 'skipped',
      warning:
        op === 'add'
          ? 'Archivo guardado pero no versionado (el commit falló).'
          : 'Archivo borrado pero el commit falló.',
    }
  }
}

/** Compute the asset path relative to its repo root, for git. */
function assetRelPathInRepo(type: string, slug: string, subdir: string, filename: string): string {
  const repo = workspaceRepoPath(type)
  const abs = resolve(contentDir(type), slug, subdir, filename)
  // `path.relative` returns a POSIX-ish path on macOS/Linux (git accepts both
  // separators on macOS, but staying POSIX matches the rest of the codebase).
  return relative(repo, abs)
}

/**
 * Write an asset buffer into the project's content dir, routed by `kind`:
 *   image → images/   video → video/   audio → audio/
 * Returns the relative `src` (`<subdir>/<file>`) that the engine/consumers
 * expect (consumers prefix it with `/content/<slug>/`, and the editor
 * preview serves it at /content/(eventos|site)/<slug>/<src>). Dedupes by
 * appending `-1`, `-2`, … if a file with the sanitized name already exists.
 * `kind` defaults to 'image' for backwards compatibility.
 */
export function saveProjectAsset(
  type: string,
  slug: string,
  originalName: string,
  buffer: Buffer,
  kind: AssetKind = 'image',
  // overwrite=true → escribe SOBRE el archivo con ese nombre (no deduplica). Lo
  // usa el RECORTE desde Recursos: reemplaza el .png in situ para que su recorte
  // aplique dondequiera que se use (mismo `src`), sin crear `-1`/`-2`.
  overwrite = false,
): SaveAssetResult & AssetCommitInfo {
  const dot = originalName.lastIndexOf('.')
  const ext = dot > 0 ? originalName.slice(dot).toLowerCase() : KIND_FALLBACK_EXT[kind]
  if (!KIND_EXTS[kind].has(ext)) {
    throw new Error(
      `Tipo de archivo no soportado para ${KIND_LABEL[kind]}: ${ext || '(sin extension)'}`,
    )
  }
  const subdir = KIND_DIR[kind]
  const destDir = resolve(contentDir(type), slug, subdir)
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

  const sanitized = sanitizeAssetFilename(originalName, kind)
  const sdot = sanitized.lastIndexOf('.')
  const sBase = sanitized.slice(0, sdot)
  const sExt = sanitized.slice(sdot)

  let filename = sanitized
  if (!overwrite) {
    let n = 1
    while (existsSync(resolve(destDir, filename))) {
      filename = `${sBase}-${n}${sExt}`
      n++
    }
  }
  // overwrite=true → `filename` queda en el nombre sanitizado y writeFileSync
  // reemplaza el archivo existente (recorte in situ).

  writeFileSync(resolve(destDir, filename), buffer)

  // TASK #102: each asset upload is its OWN atomic commit so the file is
  // immediately versioned — no more silent "untracked until next save"
  // ambiguity. Display the asset as "<subdir>/<file>" (the same string we
  // store in site.json), keeping commit messages readable in `git log`.
  const relPath = assetRelPathInRepo(type, slug, subdir, filename)
  // Incluye el slug del proyecto en el mensaje → `asset+: <slug>/<subdir>/<file>`
  // (antes era `asset+: <subdir>/<file>` y no se sabía a qué sitio pertenecía).
  const commitInfo = commitOneAsset(type, 'add', relPath, `${slug}/${subdir}/${filename}`)
  return { src: `${subdir}/${filename}`, filename, bytes: buffer.length, kind, ...commitInfo }
}

const ALL_KINDS: AssetKind[] = ['image', 'video', 'audio', 'font']

export interface ProjectAsset {
  /** File name only (e.g. "hero.png"). */
  name: string
  kind: AssetKind
  /** Relative src exactly as stored in site.json — "<subdir>/<file>". */
  src: string
  /** Byte size on disk. */
  bytes: number
}

/**
 * List every asset that physically exists for a project, grouped by kind.
 * Scans each `KIND_DIR` (images/ video/ audio/ fonts/) under the project's
 * content folder and returns one entry per file with the SAME relative `src`
 * the engine/consumers expect ("<subdir>/<file>"). Read-only; a missing
 * subdir just yields an empty group. Used by the "Recursos" browser AND the
 * image/font autocomplete comboboxes (single source of truth).
 */
export function listProjectAssets(
  type: string,
  slug: string,
): Record<AssetKind, ProjectAsset[]> {
  const base = resolve(contentDir(type), slug)
  const out = { image: [], video: [], audio: [], font: [] } as Record<AssetKind, ProjectAsset[]>
  for (const kind of ALL_KINDS) {
    const subdir = KIND_DIR[kind]
    const dir = resolve(base, subdir)
    // No existsSync pre-check: readdirSync throws ENOENT for a missing subdir,
    // which the catch turns into "empty group" (one fs hit instead of two).
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of entries) {
      if (!d.isFile()) continue
      const name = d.name
      if (name.startsWith('.')) continue // skip .DS_Store etc.
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
      // Only surface files whose extension matches the kind's whitelist so a
      // stray non-media file in images/ doesn't pollute the list.
      if (!KIND_EXTS[kind].has(ext)) continue
      let bytes = 0
      try {
        bytes = statSync(resolve(dir, name)).size
      } catch {
        /* race: file vanished — report 0 */
      }
      out[kind].push({ name, kind, src: `${subdir}/${name}`, bytes })
    }
    out[kind].sort((a, b) => a.name.localeCompare(b.name))
  }
  return out
}

/**
 * Delete ONE asset file. Hard-sanitized: `file` is reduced to its basename
 * and re-resolved; the final path MUST stay inside the project's expected
 * `<subdir>` for the given kind (defense against `..` / absolute paths).
 * Returns false (→ 404) if the kind is unknown or the file is missing; never
 * deletes anything outside the project's asset dirs.
 */
export function deleteProjectAsset(
  type: string,
  slug: string,
  kind: string,
  file: string,
): AssetCommitInfo | null {
  if (!ALL_KINDS.includes(kind as AssetKind)) return null
  const subdir = KIND_DIR[kind as AssetKind]
  // basename only — strip any path component a caller might smuggle in.
  const safeName = String(file || '').replace(/^.*[\\/]/, '').trim()
  if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('\0')) return null
  const dir = resolve(contentDir(type), slug, subdir)
  const target = resolve(dir, safeName)
  // Containment guard: the resolved target must live directly inside `dir`.
  if (!target.startsWith(dir + '/')) return null
  // Stat directly (no pre-check existsSync — avoids a TOCTOU race and an
  // extra fs hit); a missing file or a non-file both → 404.
  try {
    if (!statSync(target).isFile()) return null
  } catch {
    return null
  }
  rmSync(target)

  // TASK #102: same atomic-commit story as add. We commit the deletion as its
  // OWN commit (`asset-: <subdir>/<file>`) so the user sees an immediate,
  // predictable record of the remove. If git fails, we still return success
  // (the file IS gone from disk) with a `warning`/`commit:'skipped'` flag.
  const relPath = assetRelPathInRepo(type, slug, subdir, safeName)
  return commitOneAsset(type, 'delete', relPath, `${slug}/${subdir}/${safeName}`)
}
