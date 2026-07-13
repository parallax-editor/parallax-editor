// ─── usePublishReadiness — ¿podemos publicar con el workspace activo? ────────
//
// Decisión REACTIVA para el botón "Publicar" del toolbar del editor:
//   • si el workspace declara `s3.credentialsMode:'explicit'` pero NO hay
//     secreto guardado en el SecretsBus → bloqueamos con motivo.
//   • si el workspace declara `git.authMode:'pat'` pero NO hay PAT guardado
//     → bloqueamos con motivo.
//   • cualquier otra combinación (system, sin S3, etc.) → sin bloqueo.
//
// El tooltip usa esa razón como texto humano; click lleva a la pantalla de
// settings apuntando a la tab correcta (`?tab=s3` o `?tab=git`). Antes de esto
// el botón siempre abría el panel y el error aparecía DESPUÉS de intentar el
// push — el usuario no entendía por qué pasaba nada.
//
// El check se refresca cuando:
//   • cambia el workspace activo
//   • cambia el modo de auth de S3/git (por ejemplo tras guardar en settings)
//   • el composable se remounta (navegación de vuelta al editor)

import { computed, ref, watch } from 'vue'
import { activeWorkspace } from '../stores/workspaces'
import { useSecrets, secretKeys } from './useSecrets'

export interface PublishReadiness {
  /** Motivo bloqueante o null. Se pinta en el tooltip. */
  blockedReason: ReturnType<typeof computed<string | null>>
  /** Tab que la settings screen debería abrir si el usuario hace click en el botón bloqueado. */
  suggestedTab: ReturnType<typeof computed<'s3' | 'git' | 'general'>>
  /** Fuerza un re-check (útil tras guardar settings sin remount del toolbar). */
  refresh: () => Promise<void>
}

export function usePublishReadiness(): PublishReadiness {
  const secrets = useSecrets()
  // Estado interno: hay secreto guardado para cada tipo. Lo consultamos
  // asincrónico al SecretsBus. Un flag por lado — no queremos leer los valores.
  const s3HasStored = ref(false)
  const gitHasStored = ref(false)

  async function refresh() {
    const ws = activeWorkspace.value
    if (!ws) { s3HasStored.value = false; gitHasStored.value = false; return }
    try {
      const r = await secrets.get(secretKeys.s3(ws.id))
      s3HasStored.value = !!(r?.ok && r.value)
    } catch { s3HasStored.value = false }
    try {
      const r = await secrets.get(secretKeys.git(ws.id))
      gitHasStored.value = !!(r?.ok && r.value)
    } catch { gitHasStored.value = false }
  }

  // Re-consulta cuando cambia el workspace o cuando sus modos de auth cambian
  // (por ejemplo el usuario acaba de guardar settings). `deep:true` porque
  // `s3.credentialsMode` y `git.authMode` viven dentro de sub-objetos.
  watch(
    () => activeWorkspace.value,
    () => { void refresh() },
    { immediate: true, deep: true },
  )
  // Un segundo watcher específico a los modos, por si el usuario los cambia
  // desde la settings screen sin que el `active` cambie de id.
  watch(
    [
      () => activeWorkspace.value?.s3?.credentialsMode,
      () => activeWorkspace.value?.git?.authMode,
    ],
    () => { void refresh() },
  )

  const blockedReason = computed<string | null>(() => {
    const ws = activeWorkspace.value
    if (!ws) return null
    if (ws.s3?.credentialsMode === 'explicit' && !s3HasStored.value) {
      return 'Faltan credenciales S3 en el llavero. Configura el workspace para poder publicar.'
    }
    if (ws.useGit !== false && ws.git?.authMode === 'pat' && !gitHasStored.value) {
      return 'Falta el token de Git en el llavero. Configura el workspace para poder publicar.'
    }
    return null
  })

  const suggestedTab = computed<'s3' | 'git' | 'general'>(() => {
    const ws = activeWorkspace.value
    if (!ws) return 'general'
    if (ws.s3?.credentialsMode === 'explicit' && !s3HasStored.value) return 's3'
    if (ws.useGit !== false && ws.git?.authMode === 'pat' && !gitHasStored.value) return 'git'
    return 'general'
  })

  return { blockedReason, suggestedTab, refresh }
}
