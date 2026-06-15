// ─── Resolver de credenciales Git PAT para un workspace (Fase 4) ──────────────
//
// Análogo a `useS3CredentialsResolver.ts`: una sola fuente para hidratar el PAT
// del SecretsBus antes de cada fetch que lo necesite (publish, delete, validate).
// En modo 'system' devuelve undefined → server cae a SSH key / osxkeychain.

import { useSecrets, secretKeys } from './useSecrets'
import type { GitCredentials, WorkspaceGit } from './useApi'

interface StoredGitSecret {
  username: string
  token: string
  provider?: 'github' | 'gitlab' | 'bitbucket'
}

/**
 * Resuelve el PAT a usar para `workspaceId`. Devuelve `undefined` cuando el
 * workspace está en 'system' o cuando el secreto no está guardado.
 *
 * `useSecrets()` se invoca DENTRO de la función (no a module-top) para que en
 * tests que re-importan el módulo de secrets para simular un reload, el
 * resolver no quede atado a un `s` huérfano del módulo viejo.
 */
export async function resolveGitCredentials(
  workspaceId: string,
  git: WorkspaceGit | undefined | null,
): Promise<GitCredentials | undefined> {
  if (!workspaceId || !git) return undefined
  if (git.authMode !== 'pat') return undefined
  const s = useSecrets()
  const stored = await s.getJson<StoredGitSecret>(secretKeys.git(workspaceId))
  if (!stored || !stored.username || !stored.token) return undefined
  return { username: stored.username, token: stored.token }
}
