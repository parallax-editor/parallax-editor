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

import { ref } from 'vue'
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
  saveWorkspace: () => Promise<{ ok: boolean; error?: string }>
  wsBusy: ReturnType<typeof ref<boolean>>
  wsError: ReturnType<typeof ref<string | null>>
}

export function useWorkspaceForm(opts: UseWorkspaceFormOpts): WorkspaceForm {
  const { t } = opts
  const secretsApi = useSecrets()

  const cfg = ref<Workspace | null>(null)
  const wsBusy = ref(false)
  const wsError = ref<string | null>(null)

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

  function loadWorkspace(id: string) {
    const ws = wsState.list.find((w) => w.id === id)
    if (!ws) return
    // BACK-COMPAT: legacy sin `publishManifestUserSet` pero con
    // `publishManifest:boolean` explícito → promovemos a userSet=true para
    // que un cambio de preset no pisa su elección. Mismo criterio del server.
    const legacyS3UserSet =
      ws.s3 != null &&
      (ws.s3.publishManifestUserSet === true || typeof ws.s3.publishManifest === 'boolean')
    cfg.value = JSON.parse(JSON.stringify({
      id: ws.id,
      name: ws.name,
      repoPath: ws.repoPath,
      gitRemote: ws.gitRemote || '',
      contentRoot: ws.contentRoot,
      useGit: ws.useGit !== false,
      preset: (ws.preset || 'multi-tenant') as WorkspacePreset,
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

  async function verifyS3Credentials() {
    if (!cfg.value?.s3) return
    const ak = s3Creds.value.accessKeyId.trim()
    const sk = s3Creds.value.secretAccessKey.trim()
    if (!ak || !sk) {
      s3VerifyState.value = 'fail'
      s3VerifyError.value = t('workspace.s3CredsBothRequired')
      return
    }
    if (!cfg.value.s3.bucket) {
      s3VerifyState.value = 'fail'
      s3VerifyError.value = t('workspace.s3VerifyNeedsBucket')
      return
    }
    s3VerifyState.value = 'busy'
    s3VerifyError.value = null
    try {
      const r = await s3Api.headBucket(cfg.value.s3.bucket, cfg.value.s3.region || 'us-east-1', { accessKeyId: ak, secretAccessKey: sk })
      if (r.ok) { s3VerifyState.value = 'ok' }
      else { s3VerifyState.value = 'fail'; s3VerifyError.value = r.error || t('workspace.s3VerifyFailedGeneric') }
    } catch (e: any) {
      s3VerifyState.value = 'fail'
      s3VerifyError.value = e?.message || t('workspace.s3VerifyFailedGeneric')
    }
  }

  async function verifyGitCredentials() {
    if (!cfg.value) return
    const u = gitCreds.value.username.trim()
    const tk = gitCreds.value.token.trim()
    if (!u || !tk) {
      gitVerifyState.value = 'fail'
      gitVerifyError.value = t('workspace.gitPatBothRequired')
      return
    }
    gitVerifyState.value = 'busy'
    gitVerifyError.value = null
    try {
      const r = await gitApiExtra.validatePat(cfg.value.id, { username: u, token: tk })
      if (r.ok) { gitVerifyState.value = 'ok' }
      else { gitVerifyState.value = 'fail'; gitVerifyError.value = r.error || t('workspace.gitPatVerifyFailedGeneric') }
    } catch (e: any) {
      gitVerifyState.value = 'fail'
      gitVerifyError.value = e?.message || t('workspace.gitPatVerifyFailedGeneric')
    }
  }

  async function saveWorkspace(): Promise<{ ok: boolean; error?: string }> {
    if (!cfg.value) return { ok: false, error: 'No hay workspace cargado.' }
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
    loadWorkspace, saveWorkspace,
    wsBusy, wsError,
  }
}

/** Utility para el composable resolver de folder-picker (pantalla dedicada). */
export async function pickFolder(): Promise<string | null> {
  const r = await workspaceApi.pickFolder()
  return r?.ok && r.path ? r.path : null
}
