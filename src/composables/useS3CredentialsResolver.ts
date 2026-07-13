// ─── Resolver de credenciales S3 para un workspace ────────────────────────────
//
// Pieza pequeña, intencionalmente sin estado: dada la config S3 del workspace
// activo, devuelve las credenciales adecuadas para el próximo request. Si el
// workspace está en `credentialsMode:'explicit'`, leemos del SecretsBus
// (Keychain / sesión efímera). Si está en 'system' (o no existe), devolvemos
// `undefined` para que el server caiga a la cadena por defecto de la SDK.
//
// Se centraliza aquí porque varios callers (publish, delete, head-bucket) deben
// hidratar las mismas creds de la misma forma — pequeñas divergencias serían
// un bug silencioso ("el delete usa cadena del sistema pero el publish usa la
// del Keychain"). El composable es la única fuente.

import { useSecrets, secretKeys } from './useSecrets'
import type { S3Credentials, WorkspaceS3 } from './useApi'

/**
 * Resuelve las credenciales S3 a usar para `workspaceId`.
 *
 * @returns `S3Credentials` cuando el workspace está en modo explícito y las
 *          creds están guardadas; `undefined` cuando está en modo 'system' o
 *          cuando el secreto no está disponible. En este último caso el caller
 *          decide qué hacer (ofrecer al usuario re-ingresarlas, o degradar).
 *
 * `useSecrets()` se invoca DENTRO de la función (no a module-top) para
 * que tests que re-importan el módulo de secrets para simular reload no queden
 * atados a un `s` huérfano del módulo viejo. Costo: una indirección por call.
 */
export async function resolveS3Credentials(
  workspaceId: string,
  s3: WorkspaceS3 | undefined | null,
): Promise<S3Credentials | undefined> {
  if (!workspaceId || !s3) return undefined
  if (s3.credentialsMode !== 'explicit') return undefined
  const s = useSecrets()
  const stored = await s.getJson<S3Credentials>(secretKeys.s3(workspaceId))
  if (!stored || !stored.accessKeyId || !stored.secretAccessKey) return undefined
  return stored
}
