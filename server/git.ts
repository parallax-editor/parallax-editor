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
    return git(`commit -m "${message.replace(/"/g, '\\"')}"`, cwd)
  } catch {
    return 'Nothing to commit'
  }
}

export function gitPush(cwd: string): string {
  return git('push', cwd)
}

export function gitRevert(cwd: string, hash: string): string {
  return git(`revert --no-edit ${hash}`, cwd)
}
