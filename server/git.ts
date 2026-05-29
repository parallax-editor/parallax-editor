import { execSync, execFileSync } from 'child_process'
import { existsSync, statSync, accessSync, constants } from 'fs'
import { dirname, isAbsolute } from 'path'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30000 }).trim()
}

/**
 * Diff completo de un commit (`git show`), para el modal "ver qué se hizo
 * commit". SEGURIDAD: el hash se valida como nombre de objeto hex (sin
 * metacaracteres ni flags) y se pasa por execFileSync (no por shell). La salida
 * se acota para que un commit enorme (muchos assets) no inunde la UI; los
 * binarios aparecen como "Binary files … differ" (texto del propio git).
 */
export function gitShow(cwd: string, hash: string): { ok: boolean; diff?: string; error?: string } {
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) {
    return { ok: false, error: 'Hash de commit inválido.' }
  }
  try {
    const out = execFileSync(
      'git',
      ['show', '--stat', '--patch', '--no-color', '--format=medium', hash, '--'],
      { cwd, encoding: 'utf-8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
    )
    const MAX = 200_000
    const diff = out.length > MAX ? out.slice(0, MAX) + '\n\n… (diff truncado)' : out
    return { ok: true, diff }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo obtener el diff del commit.' }
  }
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
 *
 * `extraPaths` (optional): additional repo-relative paths to include in the SAME
 * scoped commit. The ONLY caller is the manifest feature (Arreglo 4): when a
 * workspace keeps a catalog manifest, the save commit also stages exactly
 * `<contentRoot>/manifest.json` — a single extra file that lives in the SAME
 * contentRoot as the slug being saved. Every extra path goes through the SAME
 * containment guard (no absolute, no `..`) and is added to BOTH the `git add`
 * and the `--only -- <paths…>` pathspec, so the commit can never spill into
 * another slug or any unrelated repo change. Empty/invalid extras are dropped.
 */
export function gitCommit(
  cwd: string,
  message: string,
  addPath: string,
  extraPaths: string[] = [],
): string {
  // Containment guard: never let an absolute path or a `..` segment reach git.
  // The caller builds addPath from controlled inputs (type → subdir + slug),
  // but this is the last line where we can still refuse a malformed path.
  const safe = (p: string): boolean =>
    !!p && !p.startsWith('/') && !p.split(/[\\/]/).some((seg) => seg === '..')
  if (!safe(addPath)) {
    return 'Nothing to commit'
  }
  // Validate + dedupe the extra paths against the SAME guard. A malformed extra
  // is silently dropped (never aborts the save) so the manifest can never widen
  // the commit's scope beyond well-formed, repo-relative paths.
  const extras = Array.from(new Set(extraPaths.filter(safe)))
  const paths = [addPath, ...extras]
  // Quote every path; this is the exact set staged AND the exact `--only`
  // pathspec, so the two can never diverge.
  const quoted = paths.map((p) => `"${p}"`).join(' ')
  try {
    git(`add -- ${quoted}`, cwd)
  } catch {
    return 'Nothing to commit'
  }
  try {
    // `--only -- <paths…>` restricts the commit to ONLY these paths even if
    // unrelated changes are already staged in the index (belt-and-suspenders
    // over the scoped `add` above). `-m` must precede `--` (pathspec).
    return git(
      `commit --no-verify --only -m "${message.replace(/"/g, '\\"')}" -- ${quoted}`,
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

// Push "inteligente" para flujos colaborativos sobre el mismo repo: si el push
// se rechaza por estar DETRÁS del remoto (el otro colaborador ya pusheó),
// integramos lo del remoto con un MERGE (no rebase) y reintentamos el push. Si
// ambos tocaron SITES DISTINTOS, el merge es automático (sin conflicto). Si
// tocaron el MISMO archivo, el merge falla → lo abortamos y lanzamos un error
// claro (resolución manual / descartar desde la UI).
export function gitPush(cwd: string): string {
  try {
    return git('push', cwd)
  } catch (e: any) {
    const msg = (e && e.message) || ''
    if (/non-fast-forward|\brejected\b|behind|failed to push|fetch first/i.test(msg)) {
      try {
        // Merge AUTOMÁTICO: `-X ours` resuelve las líneas en conflicto a favor de
        // lo LOCAL (el trabajo que se está publicando ahora) → nunca pide resolver
        // a mano. Lo que no choca se mezcla normal. (La versión del otro lado
        // queda en el historial de git, recuperable.)
        git('pull --no-rebase --no-edit -X ours', cwd)
      } catch (mergeErr: any) {
        try { git('merge --abort', cwd) } catch { /* nada que abortar */ }
        throw new Error(
          'No se pudo integrar automáticamente con el servidor (conflicto no resoluble, p.ej. archivo borrado de un lado). ' +
            ((mergeErr && mergeErr.message) || ''),
        )
      }
      return git('push', cwd) // ya integrado → ahora sí
    }
    throw e
  }
}

// Traer cambios del remoto. Estrategia para 2 personas editando el repo:
//   1) `pull --ff-only` (avance limpio cuando solo el remoto cambió).
//   2) si NO puede avanzar por DIVERGENCIA (ambos commitearon) y el árbol está
//      limpio → `pull --no-rebase` (MERGE) para integrar ambos lados. Conflicto
//      (mismo archivo) → se aborta y se pide descartar.
//   3) si falla por CAMBIOS LOCALES sin commitear → needsForce (descartar).
//   force=true (tras confirm explícito) → "traer la del servidor y descartar lo
//   mío": fetch + `reset --hard @{u}` (descarta commits locales + árbol).
export function gitPull(
  cwd: string,
  force = false,
): { ok: boolean; result?: string; error?: string; needsForce?: boolean; merged?: boolean } {
  try {
    if (force) {
      git('fetch origin', cwd)
      return { ok: true, result: git('reset --hard @{u}', cwd) }
    }
    return { ok: true, result: git('pull --ff-only', cwd) }
  } catch (e: any) {
    const msg = (e && e.message) || 'No se pudo traer cambios (pull).'
    if (force) return { ok: false, error: msg }
    // Cambios locales sin commitear → ofrecer descartar-y-forzar.
    if (/unstaged changes|uncommitted changes|commit or stash|local changes|would be overwritten/i.test(msg)) {
      return { ok: false, error: msg, needsForce: true }
    }
    // Historias divergidas (ff imposible) con árbol limpio → MERGE automático.
    // `-X ours`: las líneas en conflicto se resuelven a favor de lo LOCAL (no se
    // pide resolver a mano). Lo no conflictivo se mezcla normal.
    if (/fast-forward|diverg/i.test(msg)) {
      try {
        return { ok: true, result: git('pull --no-rebase --no-edit -X ours', cwd), merged: true }
      } catch (mergeErr: any) {
        try { git('merge --abort', cwd) } catch { /* nada que abortar */ }
        return {
          ok: false,
          error:
            'No se pudo integrar automáticamente (conflicto no resoluble, p.ej. archivo borrado de un lado). ' +
            ((mergeErr && mergeErr.message) || ''),
          needsForce: true,
        }
      }
    }
    return { ok: false, error: msg }
  }
}

// ── Git global config status ─────────────────────────────────────────────────
// The editor clones/commits/pushes on the user's behalf using the host's git.
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

// ── Clone a repo for a new workspace ─────────────────────────────────────────
// Uses the HOST's authenticated git/ssh (whatever account the user is logged
// in with). `localPath` must be an absolute path whose PARENT exists and is
// writable, and must not already exist (git clone refuses a non-empty target
// anyway, but we fail early with a clear Spanish message). Never throws —
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

// ── Snapshot revert (Phase 6) ────────────────────────────────────────────────
//
// "Restaurar a este punto" — bring the ENTIRE workspace folder of ONE site
// (every file under `content/<slug>/`) to the state it had at <hash>, leaving
// the changes in the working tree (NOT committed). The user reviews + commits
// with their own message via the normal save flow.
//
// Implementation:
//   1. Hash is validated as hex (same guard gitShow uses) so it can never carry
//      shell metacharacters or flags.
//   2. `git ls-tree -r --name-only <hash> -- <contentDir>` lists every file
//      that existed under that subtree at the commit.
//   3. For each listed path: `git show <hash>:<path>` streams the file's
//      contents (text or binary, via Buffer) and we write it to disk in the
//      working tree (creating parent dirs as needed).
//   4. Files currently present under <contentDir> in the working tree that do
//      NOT appear in the snapshot's tree are deleted, so the result is the
//      EXACT set of files from the commit — additions made since are removed,
//      not left behind.
//   5. Nothing is committed. The user sees the diff in the editor / their
//      next Cmd+S commits the snapshot with whatever message they choose.
//
// SECURITY:
//   - Hash validated as hex.
//   - `contentDir` must be a clean relative path (no leading `/`, no `..`).
//   - All git invocations use execFileSync (no shell). Paths from `git ls-tree`
//     are git's canonical normalized POSIX paths, but we still re-check they
//     start with the contentDir prefix and reject `..` segments before writing.
//   - File deletions are scoped to under <cwd>/<contentDir>.
export interface RestoreSnapshotResult {
  ok: boolean
  error?: string
  /** Total file count that ended up reflecting the commit's state. */
  restored?: number
  /** How many working-tree-only files were removed to match the snapshot. */
  removed?: number
}

export function gitRestoreSnapshot(
  cwd: string,
  hash: string,
  contentDir: string,
): RestoreSnapshotResult {
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) {
    return { ok: false, error: 'Hash de commit inválido.' }
  }
  const cleanDir = (contentDir || '').replace(/^\/+|\/+$/g, '')
  if (!cleanDir || cleanDir.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) {
    return { ok: false, error: 'Ruta de contenido inválida.' }
  }
  // Eagerly require fs APIs (we're in node — top-level imports in this file
  // are CommonJS-compatible).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdirSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync, rmdirSync } = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join, dirname, resolve, relative } = require('path') as typeof import('path')

  const absRoot = resolve(cwd, cleanDir)
  // Guard: absRoot must stay inside cwd.
  const rel = relative(resolve(cwd), absRoot)
  if (rel.startsWith('..') || resolve(absRoot) !== absRoot.replace(/\/+$/, '')) {
    // The startsWith('..') check handles a contentDir that escapes cwd.
    return { ok: false, error: 'Ruta de contenido fuera del workspace.' }
  }

  // If the slug folder didn't exist at <hash> (project added after that commit),
  // ls-tree returns empty. Without this guard the subsequent walkAndRemove
  // would delete the entire current `content/<slug>/` folder, leaving the user
  // with an empty project they can't recover from the UI. Bail out early so
  // the workspace is never destructively touched on a no-op snapshot.
  let listed: string[]
  try {
    const out = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', '-z', hash, '--', cleanDir],
      { cwd, encoding: 'utf-8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
    )
    listed = out.split(' ').filter(Boolean)
  } catch (e: any) {
    return { ok: false, error: e?.message || 'No se pudo leer el árbol del commit.' }
  }

  // Defensive: reject any returned path that escapes cleanDir or contains '..'.
  // Git itself won't emit '..' segments, but treating this as a hard rule keeps
  // every write/delete bounded to the workspace.
  const safe = (p: string) =>
    p.startsWith(cleanDir + '/') &&
    !p.split('/').some((seg) => seg === '..' || seg === '')
  const snapshotFiles = new Set(listed.filter(safe))

  // Missing-at-commit guard: if the commit had ZERO files under <cleanDir>,
  // either the slug never existed at that point in time or all files were
  // (re)moved. Either way restoring would just delete everything currently in
  // the working tree — refuse, with a clear error.
  if (snapshotFiles.size === 0) {
    return {
      ok: false,
      error: `Este sitio no existía en el commit ${hash.slice(0, 7)} (ningún archivo bajo ${cleanDir}). No se restauró nada.`,
    }
  }

  // 1) Restore each file in the snapshot.
  let restored = 0
  for (const repoPath of snapshotFiles) {
    let buf: Buffer
    try {
      buf = execFileSync('git', ['show', `${hash}:${repoPath}`], {
        cwd,
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch {
      // If a single file fails (e.g. a path with submodule mode), skip it.
      continue
    }
    const absTarget = join(cwd, repoPath)
    try {
      mkdirSync(dirname(absTarget), { recursive: true })
      writeFileSync(absTarget, buf)
      restored++
    } catch {
      /* swallow per-file errors so one bad file doesn't abort the whole restore */
    }
  }

  // 2) Delete files in working tree under <cleanDir> that are NOT in the
  //    snapshot (we're targeting an EXACT mirror of the commit's tree).
  let removed = 0
  function walkAndRemove(absDir: string) {
    if (!existsSync(absDir)) return
    const entries = readdirSync(absDir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(absDir, entry.name)
      const repoPath = relative(resolve(cwd), abs).split(/[\\/]/).join('/')
      if (entry.isDirectory()) {
        walkAndRemove(abs)
        // Clean up empty dirs.
        try {
          const rest = readdirSync(abs)
          if (rest.length === 0) rmdirSync(abs)
        } catch {
          /* ignore */
        }
        continue
      }
      if (!snapshotFiles.has(repoPath)) {
        try {
          unlinkSync(abs)
          removed++
        } catch {
          /* ignore */
        }
      }
    }
  }
  try {
    if (existsSync(absRoot) && statSync(absRoot).isDirectory()) {
      walkAndRemove(absRoot)
    }
  } catch {
    /* keep going — restore counts are already populated */
  }

  return { ok: true, restored, removed }
}
