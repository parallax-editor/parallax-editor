// ─── useWorkspaceForm — lógica compartida del formulario de workspace ─────────
//
// EXTRACCIÓN del código que vivía inline en `ProjectSelector.vue` para que la
// nueva pantalla dedicada (`WorkspaceSettings.vue`) NO duplique 400+ líneas de
// carga/persistencia/validación/back-compat. UNA sola fuente para:
//
//   • Clonar la config del workspace en un ref editable (`cfg`).
//   • Detectar el sentinel legacy `publishManifestUserSet` (workspaces
//     pre-preset que ya tenían `publishManifest:true` explícito).
//   • `onPresetChange` que propaga defaults SOLO si el usuario no tocó
//     `publishManifest` explícitamente.
//   • Estado + persistencia de credenciales S3 y PAT Git contra el
//     SecretsBus (Keychain / sesión) — sin exponer nunca el secreto al ref
//     visible del form.
//   • Validaciones "verify" (HeadBucket + validatePat).
//   • Guardado atómico: reglas de creación/borrado del secreto según el
//     modo elegido, upsert al store, reactivate en el host.
//
// Contrato: la composable NO renderiza — solo devuelve estado + funciones.
// Cada consumer (modal en el selector o pantalla dedicada) monta su UI.

import { ref, watch } from 'vue'
import {
  s3Api,
  gitApiExtra,
  workspaceApi,
  presetPublishManifestDefault,
  type Workspace,
  type WorkspacePreset,
} from './useApi'
import { useSecrets, secretKeys } from './useSecrets'
import { wsState, selectWorkspace, updateWorkspace, activeWorkspace } from '../stores/workspaces'

export interface UseWorkspaceFormOpts {
  /** Traducciones i18n (`t()` de useI18n). Se inyecta para que la composable no dependa de vue-i18n. */
  t: (key: string, params?: Record<string, unknown>) => string
}

export interface WorkspaceForm {
  cfg: ReturnType<typeof ref<Workspace | null>>
  // ── S3 creds ──
  s3Creds: ReturnType<typeof ref<{ accessKeyId: string; secretAccessKey: string }>>
  s3CredsHasStored: ReturnType<typeof ref<boolean>>
  s3CredsDirty: ReturnType<typeof ref<boolean>>
  s3ShowSecret: ReturnType<typeof ref<boolean>>
  s3VerifyState: ReturnType<typeof ref<'idle' | 'busy' | 'ok' | 'fail'>>
  s3VerifyError: ReturnType<typeof ref<string | null>>
  onS3CredsInput: () => void
  verifyS3Credentials: () => Promise<void>
  // ── Git PAT ──
  gitCreds: ReturnType<typeof ref<{ username: string; token: string }>>
  gitCredsHasStored: ReturnType<typeof ref<boolean>>
  gitCredsDirty: ReturnType<typeof ref<boolean>>
  gitShowToken: ReturnType<typeof ref<boolean>>
  gitVerifyState: ReturnType<typeof ref<'idle' | 'busy' | 'ok' | 'fail'>>
  gitVerifyError: ReturnType<typeof ref<string | null>>
  onGitCredsInput: () => void
  verifyGitCredentials: () => Promise<void>
  // ── Preset ──
  onPresetChange: (next: WorkspacePreset) => void
  onPublishManifestToggle: () => void
  // ── Persist ──
  loadWorkspace: (id: string) => void
  hydrateGitRemoteFromServer: (remoteUrl: string | null | undefined) => void
  saveWorkspace: () => Promise<{ ok: boolean; error?: string }>
  wsBusy: ReturnType<typeof ref<boolean>>
  wsError: ReturnType<typeof ref<string | null>>
  /** True cuando el workspace legacy no traía preset en localStorage. */
  presetMissingAtLoad: ReturnType<typeof ref<boolean>>
}

export function useWorkspaceForm(opts: UseWorkspaceFormOpts): WorkspaceForm {
  const { t } = opts
  const secretsApi = useSecrets()

  const cfg = ref<Workspace | null>(null)
  const wsBusy = ref(false)
  const wsError = ref<string | null>(null)
  // Flag: el workspace legacy no traía preset en localStorage. La UI lo pinta
  // como advertencia + bloquea Guardar hasta que el usuario elija. Sin este
  // fallback, un clic distraído sobrescribía linked-home a multi-tenant.
  const presetMissingAtLoad = ref(false)

  // S3 creds — nunca prepobladas desde el keychain; solo un flag "hay guardadas".
  const s3Creds = ref({ accessKeyId: '', secretAccessKey: '' })
  const s3CredsHasStored = ref(false)
  const s3CredsDirty = ref(false)
  const s3ShowSecret = ref(false)
  const s3VerifyState = ref<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const s3VerifyError = ref<string | null>(null)
  const onS3CredsInput = () => { s3CredsDirty.value = true }

  // PAT Git — mismo patrón.
  const gitCreds = ref({ username: '', token: '' })
  const gitCredsHasStored = ref(false)
  const gitCredsDirty = ref(false)
  const gitShowToken = ref(false)
  const gitVerifyState = ref<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const gitVerifyError = ref<string | null>(null)
  const onGitCredsInput = () => { gitCredsDirty.value = true }

  // Cambiar el MODO (system ↔ explicit/pat) limpia el resultado de la última
  // verificación: un "✗ falta usuario/token" del modo PAT no tiene sentido
  // pegado en pantalla después de pasarse a auth del sistema (y viceversa).
  watch(() => cfg.value?.s3?.credentialsMode, () => {
    s3VerifyState.value = 'idle'
    s3VerifyError.value = null
  })
  watch(() => cfg.value?.git?.authMode, () => {
    gitVerifyState.value = 'idle'
    gitVerifyError.value = null
  })

  function loadWorkspace(id: string) {
    const ws = wsState.list.find((w) => w.id === id)
    if (!ws) return
    // BACK-COMPAT: legacy sin `publishManifestUserSet` pero con
    // `publishManifest:boolean` explícito → promovemos a userSet=true para
    // que un cambio de preset no pisa su elección. Mismo criterio del server.
    const legacyS3UserSet =
      ws.s3 != null &&
      (ws.s3.publishManifestUserSet === true || typeof ws.s3.publishManifest === 'boolean')
    // BUG CRÍTICO reportado por Josh (settings de daniela-reyes-site):
    //   Un workspace pre-feature preset tiene `ws.preset === undefined`. Antes
    //   caíamos silenciosamente a 'multi-tenant', y si el usuario clicaba
    //   Guardar sin darse cuenta MATERIALIZABA el default incorrecto y apagaba
    //   el catálogo (publishManifest → false). Ahora dejamos preset=undefined
    //   en el form; la UI muestra ambos radios sin marca + un banner
    //   "Elige el tipo antes de guardar". `saveWorkspace` rechaza el commit
    //   si el user no eligió.
    const presetInStore = ws.preset === 'linked-home' || ws.preset === 'multi-tenant'
      ? ws.preset
      : undefined
    // Marcamos el estado "legacy sin preset" para que el UI diferencie entre
    // "el user eligió multi-tenant" y "nadie ha elegido". Vive en el cfg como
    // un flag ad-hoc que jamás se envía al server.
    presetMissingAtLoad.value = !presetInStore

    cfg.value = JSON.parse(JSON.stringify({
      id: ws.id,
      name: ws.name,
      repoPath: ws.repoPath,
      // `gitRemote` legacy también puede estar vacío en localStorage — el
      // repo REAL tiene su remoto de git; lo completamos abajo desde el
      // endpoint /status del server tras la carga inicial.
      gitRemote: ws.gitRemote || '',
      contentRoot: ws.contentRoot,
      useGit: ws.useGit !== false,
      preset: presetInStore as WorkspacePreset | undefined,
      s3: ws.s3
        ? {
            ...ws.s3,
            publishManifestUserSet: legacyS3UserSet,
            credentialsMode: ws.s3.credentialsMode === 'explicit' ? 'explicit' : 'system',
          }
        : {
            enabled: false, bucket: '', prefix: '', region: 'us-east-1',
            publishManifest: presetPublishManifestDefault(ws.preset),
            publishManifestUserSet: false,
            credentialsMode: 'system',
          },
      git: ws.git
        ? { authMode: ws.git.authMode === 'pat' ? 'pat' : 'system', provider: ws.git.provider || 'github' }
        : { authMode: 'system', provider: 'github' },
    })) as Workspace
    wsError.value = null
    // Reset del bloque de creds — los inputs se limpian y el flag hasStored se
    // consulta contra el SecretsBus. Un screencast del form NO expone el secreto.
    s3Creds.value = { accessKeyId: '', secretAccessKey: '' }
    s3ShowSecret.value = false
    s3CredsDirty.value = false
    s3VerifyState.value = 'idle'
    s3VerifyError.value = null
    ;(async () => {
      try {
        const r = await secretsApi.get(secretKeys.s3(ws.id))
        s3CredsHasStored.value = !!(r?.ok && r.value)
      } catch { s3CredsHasStored.value = false }
    })()
    gitCreds.value = { username: '', token: '' }
    gitShowToken.value = false
    gitCredsDirty.value = false
    gitVerifyState.value = 'idle'
    gitVerifyError.value = null
    ;(async () => {
      try {
        const r = await secretsApi.get(secretKeys.git(ws.id))
        gitCredsHasStored.value = !!(r?.ok && r.value)
      } catch { gitCredsHasStored.value = false }
    })()
  }

  /**
   * Completa campos que no viven en localStorage pero SÍ existen en la máquina
   * (el remoto real de git, leído por `git remote get-url origin`). El
   * WorkspaceSettings.vue lo llama después del load inicial, pasándole el
   * WorkspaceStatus que ya trajo del endpoint. NO sobreescribe si el usuario ya
   * tipeó algo desde la carga (respeta la dirty-ness del form).
   */
  function hydrateGitRemoteFromServer(remoteUrl: string | null | undefined) {
    if (!cfg.value) return
    // Solo hidratamos si el campo está VACÍO. Si el user tipeó algo tras el
    // load, lo respetamos.
    if (cfg.value.gitRemote && cfg.value.gitRemote.trim()) return
    if (remoteUrl && remoteUrl.trim()) {
      cfg.value.gitRemote = remoteUrl.trim()
    }
  }

  function onPresetChange(next: WorkspacePreset) {
    if (!cfg.value) return
    cfg.value.preset = next
    if (cfg.value.s3 && !cfg.value.s3.publishManifestUserSet) {
      cfg.value.s3.publishManifest = presetPublishManifestDefault(next)
    }
  }
  function onPublishManifestToggle() {
    if (cfg.value?.s3) cfg.value.s3.publishManifestUserSet = true
  }

  /**
   * Verifica que el editor pueda acceder al bucket S3 configurado. Funciona
   * en ambos modos:
   *   • `explicit`: usa el par accessKeyId+secretAccessKey del form (los
   *     valida antes de llamar al HeadBucket).
   *   • `system` (default): omite las creds explícitas → el server usa la
   *     cadena por defecto (~/.aws/credentials, AWS_* env, SSO). Permite al
   *     usuario confirmar que su config existente le sirve SIN tener que
   *     tipear nada.
   * En ambos casos exige que haya bucket + region.
   */
  async function verifyS3Credentials() {
    if (!cfg.value?.s3) return
    if (!cfg.value.s3.bucket) {
      s3VerifyState.value = 'fail'
      s3VerifyError.value = t('workspace.s3VerifyNeedsBucket')
      return
    }
    const isExplicit = cfg.value.s3.credentialsMode === 'explicit'
    let creds: { accessKeyId: string; secretAccessKey: string } | undefined
    if (isExplicit) {
      const ak = s3Creds.value.accessKeyId.trim()
      const sk = s3Creds.value.secretAccessKey.trim()
      if (!ak || !sk) {
        s3VerifyState.value = 'fail'
        s3VerifyError.value = t('workspace.s3CredsBothRequired')
        return
      }
      creds = { accessKeyId: ak, secretAccessKey: sk }
    }
    s3VerifyState.value = 'busy'
    s3VerifyError.value = null
    try {
      // Sin `creds`, s3Api.headBucket omite el body de credentials → el server
      // cae a la cadena por defecto (comportamiento histórico).
      const r = await s3Api.headBucket(cfg.value.s3.bucket, cfg.value.s3.region || 'us-east-1', creds)
      if (r.ok) { s3VerifyState.value = 'ok' }
      else { s3VerifyState.value = 'fail'; s3VerifyError.value = r.error || t('workspace.s3VerifyFailedGeneric') }
    } catch (e: any) {
      s3VerifyState.value = 'fail'
      s3VerifyError.value = e?.message || t('workspace.s3VerifyFailedGeneric')
    }
  }

  async function verifyGitCredentials() {
    if (!cfg.value) return
    const isPat = cfg.value.git?.authMode === 'pat'
    gitVerifyState.value = 'busy'
    gitVerifyError.value = null
    try {
      let r: { ok: boolean; error?: string }
      if (isPat) {
        const u = gitCreds.value.username.trim()
        const tk = gitCreds.value.token.trim()
        if (!u || !tk) {
          gitVerifyState.value = 'fail'
          gitVerifyError.value = t('workspace.gitPatBothRequired')
          return
        }
        r = await gitApiExtra.validatePat(cfg.value.id, { username: u, token: tk })
      } else {
        // Modo `system`: prueba la auth del host (SSH key / credential
        // helper) con ls-remote — paridad con el verify de S3 en system.
        r = await gitApiExtra.verifySystemAccess(cfg.value.id)
      }
      if (r.ok) { gitVerifyState.value = 'ok' }
      else { gitVerifyState.value = 'fail'; gitVerifyError.value = r.error || t('workspace.gitPatVerifyFailedGeneric') }
    } catch (e: any) {
      gitVerifyState.value = 'fail'
      gitVerifyError.value = e?.message || t('workspace.gitPatVerifyFailedGeneric')
    }
  }

  async function saveWorkspace(): Promise<{ ok: boolean; error?: string }> {
    if (!cfg.value) return { ok: false, error: 'No hay workspace cargado.' }
    // GUARD CRÍTICO: si el workspace se cargó SIN preset (legacy) y el usuario
    // NO lo eligió, abortar el guardado. Sin esto sobreescribíamos preset a
    // 'multi-tenant' + apagábamos el catálogo silenciosamente.
    if (presetMissingAtLoad.value && !cfg.value.preset) {
      wsError.value = t('workspace.presetRequiredBeforeSave')
      return { ok: false, error: wsError.value }
    }
    wsBusy.value = true
    wsError.value = null
    const wsId = cfg.value.id
    try {
      // ── Persistencia del secreto S3 ────────────────────────────────────────
      const s3cfg = cfg.value.s3
      if (s3cfg?.credentialsMode === 'explicit' && s3CredsDirty.value) {
        const ak = s3Creds.value.accessKeyId.trim()
        const sk = s3Creds.value.secretAccessKey.trim()
        if (!ak || !sk) {
          wsError.value = t('workspace.s3CredsBothRequired')
          return { ok: false, error: wsError.value }
        }
        const setRes = await secretsApi.setJson(secretKeys.s3(wsId), { accessKeyId: ak, secretAccessKey: sk })
        if (!setRes.ok) {
          wsError.value = setRes.error || t('workspace.s3CredsSaveFailed')
          return { ok: false, error: wsError.value }
        }
        // HeadBucket post-save — best-effort, warning si falla pero NO bloquea.
        if (s3cfg.bucket) {
          const headRes = await s3Api.headBucket(s3cfg.bucket, s3cfg.region || 'us-east-1', { accessKeyId: ak, secretAccessKey: sk })
          if (!headRes.ok) wsError.value = `${t('workspace.s3VerifyFailedSavingAnyway')} ${headRes.error || ''}`.trim()
        }
      } else if (s3cfg?.credentialsMode === 'system') {
        // Cambió a system → limpieza defensiva (re-query al SecretsBus para
        // sortear una race con la IIFE async del `loadWorkspace`).
        try {
          const cur = await secretsApi.get(secretKeys.s3(wsId))
          if (cur?.ok && cur.value) await secretsApi.delete(secretKeys.s3(wsId))
        } catch { /* non-fatal */ }
      }

      // ── Persistencia del PAT Git (mismo contrato) ─────────────────────────
      const gitCfg = cfg.value.git
      if (gitCfg?.authMode === 'pat' && gitCredsDirty.value) {
        const u = gitCreds.value.username.trim()
        const tk = gitCreds.value.token.trim()
        if (!u || !tk) {
          wsError.value = t('workspace.gitPatBothRequired')
          return { ok: false, error: wsError.value }
        }
        const setRes = await secretsApi.setJson(secretKeys.git(wsId), {
          username: u,
          token: tk,
          provider: gitCfg.provider || 'github',
        })
        if (!setRes.ok) {
          wsError.value = setRes.error || t('workspace.gitPatSaveFailed')
          return { ok: false, error: wsError.value }
        }
        try {
          const r = await gitApiExtra.validatePat(wsId, { username: u, token: tk })
          if (!r.ok) wsError.value = `${t('workspace.gitPatVerifyFailedSavingAnyway')} ${r.error || ''}`.trim()
        } catch { /* tolerante a offline */ }
      } else if (gitCfg?.authMode === 'system') {
        try {
          const cur = await secretsApi.get(secretKeys.git(wsId))
          if (cur?.ok && cur.value) await secretsApi.delete(secretKeys.git(wsId))
        } catch { /* non-fatal */ }
      }

      updateWorkspace(wsId, {
        name: cfg.value.name,
        repoPath: cfg.value.repoPath,
        gitRemote: cfg.value.useGit ? (cfg.value.gitRemote || undefined) : undefined,
        contentRoot: cfg.value.contentRoot,
        useGit: cfg.value.useGit,
        preset: cfg.value.preset,
        s3: cfg.value.s3,
        git: cfg.value.git,
      })
      // Si es el workspace activo, re-activar en el host para que las rutas
      // :ws vuelvan a resolver con la config nueva. Sin esto, el server sigue
      // resolviendo con el snapshot antiguo hasta el próximo boot.
      if (wsId === activeWorkspace.value?.id) {
        const r = await selectWorkspace(wsId)
        if (!r?.ok) {
          wsError.value = r?.error || t('workspace.hostRejectedConfig')
          return { ok: false, error: wsError.value }
        }
      }
      return { ok: true }
    } finally {
      wsBusy.value = false
    }
  }

  return {
    cfg,
    s3Creds, s3CredsHasStored, s3CredsDirty, s3ShowSecret, s3VerifyState, s3VerifyError,
    onS3CredsInput, verifyS3Credentials,
    gitCreds, gitCredsHasStored, gitCredsDirty, gitShowToken, gitVerifyState, gitVerifyError,
    onGitCredsInput, verifyGitCredentials,
    onPresetChange, onPublishManifestToggle,
    loadWorkspace, hydrateGitRemoteFromServer, saveWorkspace,
    wsBusy, wsError,
    presetMissingAtLoad,
  }
}

/** Utility para el composable resolver de folder-picker (pantalla dedicada). */
export async function pickFolder(): Promise<string | null> {
  const r = await workspaceApi.pickFolder()
  return r?.ok && r.path ? r.path : null
}
