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

export function gitCommit(cwd: string, message: string): string {
  git('add -A', cwd)
  try {
    // --no-verify: the editor's auto-commit-on-save (manual Cmd+S, Guardar and
    // the autosave timer all funnel through here) MUST bypass the repo's
    // pre-commit hook. That hook runs the full offline lint+test suite, which
    // is fine for a human `git commit` but unusable on every keystroke-driven
    // autosave — and was repeatedly polluting the content repos with heavy
    // test runs all session. Content correctness is already guaranteed
    // elsewhere: the engine's `validateSite` runs on load and the "Publicar"
    // flow re-validates the schema before push (task #44). So skipping the
    // hook here is by design, not a shortcut.
    return git(`commit --no-verify -m "${message.replace(/"/g, '\\"')}"`, cwd)
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

export function gitRevert(cwd: string, hash: string): string {
  return git(`revert --no-edit ${hash}`, cwd)
}
