import { execSync, execFileSync } from 'child_process'
import { existsSync, statSync, accessSync, constants } from 'fs'
import { dirname, isAbsolute } from 'path'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}

export function gitLog(cwd: string, limit = 20): { hash: string; message: string; date: string }[] {
  try {
    const raw = git(`log --oneline --format="%H|%s|%ci" -n ${limit}`, cwd)
    if (!raw) return []
    return raw.split('\n').map((line) => {
      const [hash, message, date] = line.split('|')
      return { hash, message, date }
    })
  } catch {
    return []
  }
}

/**
 * SECURITY (scoped save commit): the editor's "Guardar" must only ever stage
 * the ACTIVE site's content directory. The previous `git add -A` swept the
 * ENTIRE content repo, so one autosave could commit OTHER sites' edits or any
 * unrelated change in the repo. `addPath` is the site's path RELATIVE to the
 * repo root (e.g. `content/sofia-y-juan` for eventos,
 * `content/portafolio/mi-mundo` for site). We `git add -- <addPath>` so the
 * commit is confined to that one site's files and nothing else can leak in.
 *
 * `--no-verify`: the editor's auto-commit-on-save (manual Cmd+S, Guardar and
 * the autosave timer all funnel through here) MUST bypass the repo's
 * pre-commit hook. That hook runs the full offline lint+test suite, which is
 * fine for a human `git commit` but unusable on every keystroke-driven
 * autosave — and was repeatedly polluting the content repos with heavy test
 * runs all session. Content correctness is already guaranteed elsewhere: the
 * engine's `validateSite` runs on load and the "Publicar" flow re-validates
 * the schema before push (task #44). So skipping the hook here is by design.
 *
 * The commit is ALSO scoped at commit time with `--only -- <addPath>` so even
 * if something is already staged from another path, it cannot ride along.
 */
export function gitCommit(cwd: string, message: string, addPath: string): string {
  // Containment guard: never let an absolute path or a `..` segment reach git.
  // The caller builds addPath from controlled inputs (type → subdir + slug),
  // but this is the last line where we can still refuse a malformed path.
  if (
    !addPath ||
    addPath.startsWith('/') ||
    addPath.split(/[\\/]/).some((seg) => seg === '..')
  ) {
    return 'Nothing to commit'
  }
  try {
    git(`add -- "${addPath}"`, cwd)
  } catch {
    return 'Nothing to commit'
  }
  try {
    // `--only -- <path>` restricts the commit to ONLY that site's path even if
    // unrelated changes are already staged in the index (belt-and-suspenders
    // over the scoped `add` above). `-m` must precede `--` (pathspec).
    return git(
      `commit --no-verify --only -m "${message.replace(/"/g, '\\"')}" -- "${addPath}"`,
      cwd,
    )
  } catch {
    return 'Nothing to commit'
  }
}

// Commit any uncommitted changes (used to persist edits Claude made on disk via
// the chat). Returns the new short hash, or null if there was nothing to commit.
// Like the autosave path it stages everything and bypasses the pre-commit hook
// (--no-verify) — content correctness is covered by validateSite on load and the
// schema re-check in the Publicar flow.
export function gitCommitContent(cwd: string, message: string): string | null {
  let dirty = ''
  try {
    dirty = git('status --porcelain', cwd)
  } catch {
    return null
  }
  if (!dirty) return null
  git('add -A', cwd)
  try {
    git(`commit --no-verify -m "${message.replace(/"/g, '\\"')}"`, cwd)
    return git('rev-parse --short HEAD', cwd)
  } catch {
    return null
  }
}

export function gitPush(cwd: string): string {
  return git('push', cwd)
}

// ── Git global config status (Fase 2) ────────────────────────────────────────
// The editor clones/commits/pushes on Daniela's behalf using the host's git.
// If `git config --global user.name`/`user.email` are unset, commits will fail
// — so the workspace selector shows a persistent banner until git is set up.
// Never throws.
export interface GitConfigStatus {
  configured: boolean
  name: string
  email: string
}

export function gitConfigStatus(): GitConfigStatus {
  const read = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--global', key], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      }).trim()
    } catch {
      return ''
    }
  }
  const name = read('user.name')
  const email = read('user.email')
  return { configured: !!name && !!email, name, email }
}

// ── Clone a repo for a new workspace (Fase 2) ─────────────────────────────────
// Uses the HOST's authenticated git/ssh (Daniela is logged in as
// danielareyesarte). `localPath` must be an absolute path whose PARENT exists
// and is writable, and must not already exist (git clone refuses a non-empty
// target anyway, but we fail early with a clear Spanish message). Never throws —
// returns a structured result the API passes through.
export interface CloneResult {
  ok: boolean
  path?: string
  error?: string
}

export function gitClone(gitUrl: string, localPath: string): CloneResult {
  const url = (gitUrl || '').trim()
  const dest = (localPath || '').trim()
  if (!url) return { ok: false, error: 'Falta la URL de GitHub.' }
  if (!dest || !isAbsolute(dest)) {
    return { ok: false, error: 'La ruta local debe ser absoluta.' }
  }
  if (existsSync(dest)) {
    return { ok: false, error: `La carpeta destino ya existe: ${dest}` }
  }
  const parent = dirname(dest)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return { ok: false, error: `La carpeta contenedora no existe: ${parent}` }
  }
  try {
    accessSync(parent, constants.W_OK)
  } catch {
    return { ok: false, error: `No se puede escribir en: ${parent}` }
  }
  try {
    // execFileSync (no shell) so the URL/path are passed verbatim — no quoting
    // hazard. Generous timeout for a fresh clone over the network.
    execFileSync('git', ['clone', url, dest], {
      encoding: 'utf-8',
      timeout: 300000,
      stdio: 'pipe',
    })
    return { ok: true, path: dest }
  } catch (e: any) {
    const msg = (e?.stderr || e?.message || '').toString().trim()
    return { ok: false, error: `No se pudo clonar: ${msg || 'error de git'}` }
  }
}

// ── Scoped sidecar commit (Fase 3: deploy state) ──────────────────────────────
// Stage + commit ONE path (the slug's .deploy.json) with the standard scoped,
// --no-verify, --only contract. Mirrors gitCommit but lets the caller pass an
// explicit message. Returns the commit output or 'Nothing to commit'.
export function gitCommitPath(cwd: string, message: string, addPath: string): string {
  return gitCommit(cwd, message, addPath)
}

// ── Publicar status helpers (task: Git → "Publicar") ─────────────────────────
// All of these are best-effort and MUST NOT throw: a content repo may have no
// upstream configured and the machine may be offline. On any failure they fall
// back to a safe empty/zero result so the toolbar/panel degrade gracefully.

interface Commit { hash: string; message: string; date: string }

function parseCommitLines(raw: string): Commit[] {
  if (!raw) return []
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const [hash, message, date] = line.split('|')
      return { hash, message, date }
    })
}

/**
 * Commits that are LOCAL-ONLY (ahead of the configured upstream and not yet
 * pushed): `git log @{u}..HEAD`. Empty array if there is no upstream or
 * nothing is ahead. Never throws.
 */
export function gitPendingCommits(cwd: string): Commit[] {
  try {
    const raw = git('log @{u}..HEAD --format="%H|%s|%ci"', cwd)
    return parseCommitLines(raw)
  } catch {
    // No upstream tracking branch (or other git error) → nothing pending.
    return []
  }
}

/**
 * The last `n` commits of the REMOTE main branch. Best-effort `git fetch
 * origin main` first (short timeout) so the view is fresh; if the fetch fails
 * (offline / no remote) we just read whatever `origin/main` ref we already
 * have locally. Empty array if there is no `origin/main` at all. Never throws.
 */
export function gitOriginRecent(cwd: string, n = 5): Commit[] {
  try {
    // Short timeout so an offline machine doesn't hang the status request.
    execSync('git fetch origin main', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
  } catch {
    // Offline / no remote / branch missing — fall through to the local ref.
  }
  try {
    const raw = git(`log origin/main -n ${n} --format="%H|%s|%ci"`, cwd)
    return parseCommitLines(raw)
  } catch {
    return []
  }
}

/**
 * Number of commits the local branch is AHEAD of its upstream (pending push).
 * Drives the "Publicar" button's enabled state. 0 if no upstream / on error.
 * Never throws.
 */
export function gitAheadCount(cwd: string): number {
  try {
    const raw = git('rev-list --count @{u}..HEAD', cwd)
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}
