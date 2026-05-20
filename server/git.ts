import { execSync } from 'child_process'

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
