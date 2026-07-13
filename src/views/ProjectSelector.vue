<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { projectsApi, workspaceApi, s3Api, gitApiExtra, HOME_SLUG, presetPublishManifestDefault } from '../composables/useApi'
import { resolveS3Credentials } from '../composables/useS3CredentialsResolver'
import { resolveGitCredentials } from '../composables/useGitCredentialsResolver'
import { useSecrets, secretKeys } from '../composables/useSecrets'

const { t } = useI18n()
import { APP_VERSION } from '../version'
import type { ProjectListItem, Workspace, WorkspacePreset } from '../composables/useApi'
import ProjectCard from '../components/selector/ProjectCard.vue'
import HelpHint from '../components/properties/HelpHint.vue'
// The SAME canonical slug transform the server uses to create the folder, so
// this live preview ALWAYS matches the folder/route that gets created.
import { slugify } from '../../server/slug'
import { useDialog } from '../composables/useDialog'
import {
  wsState,
  activeWorkspace,
  loadWorkspaces,
  selectWorkspace,
  addWorkspace,
  updateWorkspace,
  removeWorkspace,
  makeWorkspaceId,
} from '../stores/workspaces'

const router = useRouter()
const dialog = useDialog()
const projects = ref<ProjectListItem[]>([])
const loading = ref(true)
const wsError = ref<string | null>(null)
// Slug del proyecto que se está eliminando (borrado asíncrono: commit+push+S3).
// Mientras dura, su ProjectCard muestra un spinner en lugar de los botones.
const deletingSlug = ref<string | null>(null)

// Free-form NAME the human types (becomes meta.title / the HTML <title>).
const newName = ref('')
const showCreate = ref(false)
const creating = ref(false)
const slugPreview = computed(() => slugify(newName.value))
const nameInput = ref<HTMLInputElement | null>(null)

// ── Load: workspaces first, then the active workspace's projects ────────────
async function refreshProjects() {
  const ws = activeWorkspace.value
  if (!ws) {
    projects.value = []
    return
  }
  const r = await workspaceApi.projects(ws.id)
  projects.value = Array.isArray(r?.projects) ? r.projects : []
}

async function activateAndLoad() {
  wsError.value = null
  const ws = activeWorkspace.value
  if (!ws) {
    projects.value = []
    return
  }
  const r = await selectWorkspace(ws.id)
  if (!r?.ok) {
    wsError.value = r?.error || t('workspace.activationError')
    projects.value = []
    return
  }
  await refreshProjects()
}

onMounted(async () => {
  document.addEventListener('keydown', onKey, true)
  if (!wsState.loaded) await loadWorkspaces()
  await activateAndLoad()
  loading.value = false
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

// Switch active workspace from the selector bar.
async function pickWorkspace(id: string) {
  if (id === wsState.activeId) return
  await selectWorkspace(id)
  search.value = ''
  await activateAndLoad()
}

// ── Search ──────────────────────────────────────────────────────────────────
const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
function norm(s: string): string {
  return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}
function matches(p: ProjectListItem, q: string): boolean {
  if (!q) return true
  return norm(p.title).includes(q) || norm(p.slug).includes(q)
}
function sortByRecent(list: ProjectListItem[]): ProjectListItem[] {
  return [...list].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return (a.title || a.slug).localeCompare(b.title || b.slug, 'es')
  })
}

// El proyecto `home` se trata especial solo cuando el preset es `linked-home`:
// se quita de la lista normal y se renderiza arriba como card pineada.
// En `multi-tenant` no existe ese tratamiento — todos los proyectos van planos.
const isLinkedHome = computed(() => activeWorkspace.value?.preset === 'linked-home')
const homeProject = computed<ProjectListItem | null>(() => {
  if (!isLinkedHome.value) return null
  return projects.value.find((p) => p.slug === HOME_SLUG) || null
})
const nonHomeProjects = computed(() =>
  isLinkedHome.value ? projects.value.filter((p) => p.slug !== HOME_SLUG) : projects.value,
)
const visibleProjects = computed(() => {
  const q = norm(search.value)
  return sortByRecent(nonHomeProjects.value).filter((p) => matches(p, q))
})

// ── Copy condicional al preset ──────────────────────────────────────────────
// Default ('multi-tenant') es lo más conservador: workspaces existentes en
// localStorage SIN preset entran a este flujo. `linked-home` solo cambia el
// texto cuando el usuario lo eligió explícitamente.
const newProjectCtaText = computed(() => {
  if (!activeWorkspace.value) return t('selector.newProjectCta')
  return isLinkedHome.value
    ? t('selector.newProjectCtaLinkedHome')
    : t('selector.newProjectCtaMultiTenant')
})
const createDialogTitleText = computed(() =>
  isLinkedHome.value
    ? t('selector.createDialogTitleLinkedHome')
    : t('selector.createDialogTitleMultiTenant'),
)
const namePlaceholderText = computed(() =>
  isLinkedHome.value
    ? t('selector.namePlaceholderLinkedHome')
    : t('selector.namePlaceholderMultiTenant'),
)

async function createHomeSite() {
  const ws = activeWorkspace.value
  if (!ws || !isLinkedHome.value || creating.value) return
  // Guard CRÍTICO: si `home` ya existe, NO llamar a /api/projects (el server
  // auto-incrementa el slug colisionado → crearía `home-2` y eso NO sirve para
  // este preset porque el routing del consumidor sirve exactamente `home` en /).
  // Solo lo abrimos.
  if (projects.value.some((p) => p.slug === HOME_SLUG)) {
    openProject(HOME_SLUG)
    return
  }
  creating.value = true
  wsError.value = null
  try {
    // El servidor canoniza el name → slug; slugify("Home") === "home".
    const r = await projectsApi.create(ws.id, 'Home')
    await refreshProjects()
    const created = r?.slug
    if (!created) {
      wsError.value = t('workspace.hostRejected')
      return
    }
    if (created !== HOME_SLUG) {
      // No debería pasar (acabamos de verificar que no existe), pero si el
      // server canoniza distinto, surfaceamos para no abrir un slug fantasma.
      await dialog.alert({
        title: t('selector.addressInUseTitle'),
        message: t('selector.addressInUseMessage', { slug: created }),
      })
    }
    openProject(created)
  } catch (e: any) {
    wsError.value = e?.message || t('workspace.activationError')
  } finally {
    creating.value = false
  }
}

// ── Create / open / duplicate / delete (scoped to the active workspace) ──────
watch(showCreate, (v) => {
  if (v) nextTick(() => nameInput.value?.focus())
})
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // Orden: cerramos los modales de AYUDA primero (preset-explain, s3-policy,
    // git-pat) porque viven encima de los otros. Después los modales
    // principales. Esto evita que Escape cierre el config modal mientras el
    // usuario está mirando uno de los help modales por encima.
    if (showPresetExplain.value) { e.stopPropagation(); showPresetExplain.value = false }
    else if (showS3PolicyHelp.value) { e.stopPropagation(); showS3PolicyHelp.value = false }
    else if (showGitPatHelp.value) { e.stopPropagation(); showGitPatHelp.value = false }
    else if (showCreate.value) { e.stopPropagation(); showCreate.value = false; newName.value = '' }
    else if (wsConfigId.value) { e.stopPropagation(); wsConfigId.value = null }
    else if (showNewWs.value) { e.stopPropagation(); showNewWs.value = false }
  }
}

function openProject(slug: string) {
  const ws = activeWorkspace.value
  if (!ws) return
  router.push(`/edit/${ws.id}/${slug}`)
}

async function createNew() {
  const ws = activeWorkspace.value
  if (!ws || !newName.value.trim() || creating.value) return
  creating.value = true
  try {
    const r = await projectsApi.create(ws.id, newName.value.trim())
    const created = r?.slug
    const expected = slugPreview.value
    showCreate.value = false
    newName.value = ''
    if (created && expected && created !== expected) {
      await dialog.alert({
        title: t('selector.addressInUseTitle'),
        message: t('selector.addressInUseMessage', { slug: created }),
      })
    }
    if (created) { openProject(created); return }
  } finally {
    creating.value = false
  }
}

async function duplicate(slug: string) {
  const ws = activeWorkspace.value
  if (!ws) return
  const proposed = await dialog.prompt({
    title: t('selector.duplicateTitle'),
    message: t('selector.duplicateMessage', { slug }),
    defaultValue: `${slug}-copia`,
    confirmText: t('selector.duplicateConfirm'),
  })
  if (proposed === null) return
  const r = await projectsApi.duplicate(ws.id, slug, proposed.trim() || undefined)
  await refreshProjects()
  if (r?.slug) await dialog.alert({ title: t('selector.copyCreatedTitle'), message: t('selector.copyCreatedMessage', { slug: r.slug }) })
}

async function remove(slug: string) {
  const ws = activeWorkspace.value
  if (!ws) return
  const ok = await dialog.confirm({
    title: t('selector.deleteTitle'),
    message: t('selector.deleteMessage', { slug }),
    confirmText: t('selector.deleteConfirm'),
    danger: true,
  })
  if (!ok) return
  // Mismo contrato que Publish: si el workspace usa creds explícitas, las
  // hidratamos para que el borrado S3 también funcione; si no, undefined →
  // server usa la cadena del sistema. SIMETRÍA CRÍTICA con GitPanel.publish:
  // si el modo es 'explicit' pero el secreto no se encuentra, NO seguimos —
  // si lo hiciéramos, el server caería a la cadena del sistema (probablemente
  // sin permisos del bucket configurado) y el sitio quedaría vivo en S3
  // aunque la carpeta local se borre. Mejor abortar con un mensaje claro.
  let creds: Awaited<ReturnType<typeof resolveS3Credentials>> = undefined
  if (ws.s3?.credentialsMode === 'explicit') {
    creds = await resolveS3Credentials(ws.id, ws.s3)
    if (!creds) {
      await dialog.alert({
        title: t('workspace.deleteNeedsCredsTitle'),
        message: t('workspace.deleteNeedsCredsBody'),
      })
      return
    }
  }
  // Mismo gate para PAT.
  let gitAuth: Awaited<ReturnType<typeof resolveGitCredentials>> = undefined
  if (ws.git?.authMode === 'pat') {
    gitAuth = await resolveGitCredentials(ws.id, ws.git)
    if (!gitAuth) {
      await dialog.alert({
        title: t('workspace.deleteNeedsGitPatTitle'),
        message: t('workspace.deleteNeedsGitPatBody'),
      })
      return
    }
  }
  // Feedback en la fila: spinner mientras el borrado asíncrono corre. En éxito,
  // refreshProjects() quita la fila; en error, el finally restaura los botones.
  deletingSlug.value = slug
  try {
    await projectsApi.delete(ws.id, slug, creds, gitAuth)
    await refreshProjects()
  } finally {
    deletingSlug.value = null
  }
}

// ── Workspace config modal (gear) ─────────────────────────────────────────────
const wsConfigId = ref<string | null>(null)
const cfg = ref<Workspace>({ id: '', name: '', repoPath: '', contentRoot: 'content', useGit: true, preset: 'multi-tenant' })
const bucketSuggestions = ref<string[]>([])
const wsBusy = ref(false)
const wsModalError = ref<string | null>(null)
// Modal informativo "¿qué preset elijo?"
const showPresetExplain = ref(false)
// Modal informativo "¿qué permisos S3 debo darle?"
const showS3PolicyHelp = ref(false)
// Modal informativo "¿cómo creo un PAT?" — el cuerpo depende del provider.
const showGitPatHelp = ref(false)

// ── Credenciales S3 explícitas (Fase 3) ──────────────────────────────────────
// Los campos accessKeyId/secretAccessKey NO viven en `cfg` (el workspace) sino
// en este local del modal. Al guardar se persisten en el SecretsBus
// (Keychain/sesión) bajo `s3:${ws.id}` — JAMÁS en localStorage. Si el modo es
// 'system' se ignoran, y si el usuario apaga 'explicit' borramos el secreto.
const secretsApi = useSecrets()
const s3Creds = ref<{ accessKeyId: string; secretAccessKey: string }>({ accessKeyId: '', secretAccessKey: '' })
const s3ShowSecret = ref(false)
const s3CredsHasStored = ref(false)
// Sentinel: si el usuario NO toca los campos y solo cambia bucket/region, NO
// reescribimos el secreto guardado. Esto evita borrar accidentalmente las creds
// guardadas si el form se abrió "vacío" en una sesión nueva.
const s3CredsDirty = ref(false)
function onS3CredsInput() { s3CredsDirty.value = true }
// Estado del botón "Verificar":
//   - 'idle' (por defecto)
//   - 'busy' mientras se hace el HeadBucket
//   - 'ok'   si pasó
//   - 'fail' si no pasó (con `s3VerifyError`)
const s3VerifyState = ref<'idle' | 'busy' | 'ok' | 'fail'>('idle')
const s3VerifyError = ref<string | null>(null)

// ── Git PAT por workspace (Fase 4) ──────────────────────────────────────────
// Mismo patrón que el bloque S3: el form NO precarga el token guardado, solo
// indica si hay uno y permite reemplazar. El secreto vive en SecretsBus bajo
// `git:${ws.id}`. La validación es un `git ls-remote` con ASKPASS — más
// caro que HeadBucket de S3 pero igual de informativo.
const gitCreds = ref<{ username: string; token: string }>({ username: '', token: '' })
const gitShowToken = ref(false)
const gitCredsHasStored = ref(false)
const gitCredsDirty = ref(false)
function onGitCredsInput() { gitCredsDirty.value = true }
const gitVerifyState = ref<'idle' | 'busy' | 'ok' | 'fail'>('idle')
const gitVerifyError = ref<string | null>(null)

function openConfig(id: string) {
  const ws = wsState.list.find((w) => w.id === id)
  if (!ws) return
  // BACK-COMPAT: el localStorage de un workspace legacy (pre-preset) puede
  // tener `s3.publishManifest:true` SIN el flag `publishManifestUserSet`. Si
  // dejáramos `userSet=false`, un cambio de preset desde el modal pisaría su
  // elección. Promovemos el flag a true cuando vemos `publishManifest` con un
  // valor booleano explícito — mismo criterio que el server aplica en
  // `activateWorkspace`, así cliente y server quedan alineados.
  const legacyS3UserSet =
    ws.s3 != null &&
    (ws.s3.publishManifestUserSet === true ||
      typeof ws.s3.publishManifest === 'boolean')
  // Deep clone so editing the form doesn't mutate the store until "Guardar".
  cfg.value = JSON.parse(JSON.stringify({
    id: ws.id, name: ws.name, repoPath: ws.repoPath, gitRemote: ws.gitRemote || '',
    contentRoot: ws.contentRoot,
    useGit: ws.useGit !== false,
    // Default 'multi-tenant' por back-compat con workspaces existentes en
    // localStorage que no traen preset.
    preset: (ws.preset || 'multi-tenant') as WorkspacePreset,
    s3: ws.s3
      ? {
          ...ws.s3,
          publishManifestUserSet: legacyS3UserSet,
          credentialsMode: ws.s3.credentialsMode === 'explicit' ? 'explicit' : 'system',
        }
      : { enabled: false, bucket: '', prefix: '', region: 'us-east-1', publishManifest: presetPublishManifestDefault(ws.preset), publishManifestUserSet: false, credentialsMode: 'system' },
    git: ws.git
      ? { authMode: ws.git.authMode === 'pat' ? 'pat' : 'system', provider: ws.git.provider || 'github' }
      : { authMode: 'system', provider: 'github' },
  }))
  wsModalError.value = null
  wsConfigId.value = id
  // Reset estado del bloque de creds. Los campos NUNCA se prepoblan desde el
  // SecretsBus — el usuario solo ve "hay credenciales guardadas" / "no hay" y
  // si quiere reemplazarlas las re-escribe. Esto evita que un screencast del
  // modal exponga el secreto al instante de abrirlo.
  s3Creds.value = { accessKeyId: '', secretAccessKey: '' }
  s3ShowSecret.value = false
  s3CredsDirty.value = false
  s3VerifyState.value = 'idle'
  s3VerifyError.value = null
  // Solo necesitamos saber SI hay creds guardadas (no su valor).
  ;(async () => {
    try {
      const r = await secretsApi.get(secretKeys.s3(ws.id))
      s3CredsHasStored.value = !!(r?.ok && r.value)
    } catch {
      s3CredsHasStored.value = false
    }
  })()
  // Reset del bloque Git — mismo patrón que el de S3.
  gitCreds.value = { username: '', token: '' }
  gitShowToken.value = false
  gitCredsDirty.value = false
  gitVerifyState.value = 'idle'
  gitVerifyError.value = null
  ;(async () => {
    try {
      const r = await secretsApi.get(secretKeys.git(ws.id))
      gitCredsHasStored.value = !!(r?.ok && r.value)
    } catch {
      gitCredsHasStored.value = false
    }
  })()
  void loadBuckets()
}

/**
 * Cuando el usuario cambia el preset desde el modal, si NO marcó publishManifest
 * explícitamente, refrescamos su valor al default del preset nuevo. Si ya lo
 * tocó (`publishManifestUserSet`), respetamos su elección. Mismo contrato que
 * el server (`presetPublishManifestDefault`).
 */
function onPresetChange(newPreset: WorkspacePreset) {
  cfg.value.preset = newPreset
  if (cfg.value.s3 && !cfg.value.s3.publishManifestUserSet) {
    cfg.value.s3.publishManifest = presetPublishManifestDefault(newPreset)
  }
}
function onPublishManifestToggle() {
  if (cfg.value.s3) cfg.value.s3.publishManifestUserSet = true
}

async function loadBuckets() {
  try {
    const r = await s3Api.buckets()
    if (r?.ok && Array.isArray(r.buckets)) bucketSuggestions.value = r.buckets
  } catch { /* offline / no creds — leave empty */ }
}

// ── Bucket combobox (Arreglo 2) ───────────────────────────────────────────────
// A real anchored dropdown (not the broken floating <datalist>): a text input
// with a list positioned BELOW it that filters bucketSuggestions as you type.
const bucketOpen = ref(false)
const bucketActiveIdx = ref(-1)
const filteredBuckets = computed<string[]>(() => {
  const q = (cfg.value.s3?.bucket || '').trim().toLowerCase()
  const list = bucketSuggestions.value
  if (!q) return list.slice(0, 50)
  return list.filter((b) => b.toLowerCase().includes(q)).slice(0, 50)
})
function pickBucket(name: string) {
  if (cfg.value.s3) cfg.value.s3.bucket = name
  bucketOpen.value = false
  bucketActiveIdx.value = -1
}
function onBucketInput() {
  bucketOpen.value = true
  bucketActiveIdx.value = -1
}
function onBucketFocus() {
  bucketOpen.value = true
}
function onBucketBlur() {
  // Delay so a click on a suggestion lands before we close.
  setTimeout(() => { bucketOpen.value = false; bucketActiveIdx.value = -1 }, 150)
}
function onBucketKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!bucketOpen.value) bucketOpen.value = true
    bucketActiveIdx.value = Math.min(bucketActiveIdx.value + 1, filteredBuckets.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    bucketActiveIdx.value = Math.max(bucketActiveIdx.value - 1, -1)
  } else if (e.key === 'Enter') {
    if (bucketOpen.value && bucketActiveIdx.value >= 0 && filteredBuckets.value[bucketActiveIdx.value]) {
      e.preventDefault()
      pickBucket(filteredBuckets.value[bucketActiveIdx.value])
    } else {
      bucketOpen.value = false
    }
  } else if (e.key === 'Escape') {
    bucketOpen.value = false
    bucketActiveIdx.value = -1
  }
}

async function pickRepoFolder() {
  const r = await workspaceApi.pickFolder()
  if (r?.ok && r.path) cfg.value.repoPath = r.path
}

async function createS3Bucket() {
  if (!cfg.value.s3?.bucket) return
  wsBusy.value = true
  try {
    const r = await s3Api.createBucket(cfg.value.s3.bucket, cfg.value.s3.region || 'us-east-1')
    if (!r?.ok) wsModalError.value = r?.error || t('workspace.s3CreateBucketFailed')
    else await loadBuckets()
  } finally { wsBusy.value = false }
}

async function saveConfig() {
  if (!wsConfigId.value) return
  wsBusy.value = true
  wsModalError.value = null
  const wsId = wsConfigId.value
  try {
    // Persistencia de credenciales S3 explícitas:
    //   - mode='explicit' + creds dirty (usuario tipeó algo) → upsert al keychain
    //   - mode='system' Y había creds guardadas → BORRAMOS para no dejar
    //     huérfanas (si más adelante vuelve a 'explicit' sin escribir nada
    //     pensaría que están listas y publicaría con un secreto fantasma)
    //   - mode='explicit' + nada dirty + ya había guardadas → no tocamos
    //   - mode='explicit' + nada dirty + NUNCA hubo guardadas → no validamos
    //     ahora (el usuario las puede agregar después o usar verify); el publish
    //     ya tiene un check claro de "no hay creds guardadas".
    const s3cfg = cfg.value.s3
    if (s3cfg?.credentialsMode === 'explicit' && s3CredsDirty.value) {
      const ak = s3Creds.value.accessKeyId.trim()
      const sk = s3Creds.value.secretAccessKey.trim()
      if (!ak || !sk) {
        wsModalError.value = t('workspace.s3CredsBothRequired')
        return
      }
      const setRes = await secretsApi.setJson(secretKeys.s3(wsId), { accessKeyId: ak, secretAccessKey: sk })
      if (!setRes.ok) {
        wsModalError.value = setRes.error || t('workspace.s3CredsSaveFailed')
        return
      }
      // Validación post-guardar: si hay bucket, hacemos un HeadBucket. Si falla
      // dejamos guardado pero avisamos para que el usuario sepa que el publish
      // va a fallar igual. NO bloqueamos el guardado del resto del workspace.
      if (s3cfg.bucket) {
        const headRes = await s3Api.headBucket(s3cfg.bucket, s3cfg.region || 'us-east-1', { accessKeyId: ak, secretAccessKey: sk })
        if (!headRes.ok) {
          wsModalError.value = `${t('workspace.s3VerifyFailedSavingAnyway')} ${headRes.error || ''}`.trim()
          // No `return` aquí — el usuario quiere guardar igual; solo avisamos.
        }
      }
    } else if (s3cfg?.credentialsMode === 'system') {
      // Cambió a 'system'. NO confíes en el sentinel `s3CredsHasStored` — su
      // carga es una IIFE async que pudo no haber resuelto si el usuario
      // pulsó Guardar muy rápido tras abrir el modal. Re-consultamos al
      // SecretsBus aquí y, si hay algo guardado, lo borramos. Sin esta
      // re-consulta un toggle rápido 'system → explicit → system' podía
      // dejar un secreto huérfano en disco.
      try {
        const cur = await secretsApi.get(secretKeys.s3(wsId))
        if (cur?.ok && cur.value) await secretsApi.delete(secretKeys.s3(wsId))
      } catch { /* non-fatal */ }
    }

    // ── Persistencia del PAT Git (Fase 4) — mismo contrato que S3 ──────────────
    const gitCfg = cfg.value.git
    if (gitCfg?.authMode === 'pat' && gitCredsDirty.value) {
      const u = gitCreds.value.username.trim()
      const tk = gitCreds.value.token.trim()
      if (!u || !tk) {
        wsModalError.value = t('workspace.gitPatBothRequired')
        return
      }
      const setRes = await secretsApi.setJson(secretKeys.git(wsId), {
        username: u,
        token: tk,
        provider: gitCfg.provider || 'github',
      })
      if (!setRes.ok) {
        wsModalError.value = setRes.error || t('workspace.gitPatSaveFailed')
        return
      }
      // Validación opcional contra el remoto. NO bloquea el guardado si falla;
      // el usuario quizá está editando algo offline.
      try {
        const r = await gitApiExtra.validatePat(wsId, { username: u, token: tk })
        if (!r.ok) {
          wsModalError.value = `${t('workspace.gitPatVerifyFailedSavingAnyway')} ${r.error || ''}`.trim()
        }
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
    // If we edited the active workspace, re-activate + reload projects.
    if (wsConfigId.value === wsState.activeId) {
      const r = await selectWorkspace(wsConfigId.value)
      if (!r?.ok) { wsModalError.value = r?.error || t('workspace.hostRejectedConfig'); return }
      await refreshProjects()
    }
    wsConfigId.value = null
  } finally { wsBusy.value = false }
}

async function deleteWorkspace() {
  if (!wsConfigId.value) return
  const ok = await dialog.confirm({
    title: t('workspace.removeConfirmTitle'),
    message: t('workspace.removeConfirmMessage'),
    confirmText: t('workspace.removeConfirmCta'),
    danger: true,
  })
  if (!ok) return
  const wsId = wsConfigId.value
  // Limpia los secretos asociados al workspace antes de removerlo del store.
  // Mejor un huérfano cifrado en disco que un orphan con referencia
  // perdida — `secretsApi.delete` es idempotente y no falla si no existe.
  try { await secretsApi.delete(secretKeys.s3(wsId)) } catch { /* best-effort */ }
  try { await secretsApi.delete(secretKeys.git(wsId)) } catch { /* best-effort */ }
  removeWorkspace(wsId)
  wsConfigId.value = null
  void activateAndLoad()
}

/** Verifica el PAT tipeado contra el origin del workspace. */
async function verifyGitCredentials() {
  const wsId = wsConfigId.value
  if (!wsId) return
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
    const r = await gitApiExtra.validatePat(wsId, { username: u, token: tk })
    if (r.ok) {
      gitVerifyState.value = 'ok'
    } else {
      gitVerifyState.value = 'fail'
      gitVerifyError.value = r.error || t('workspace.gitPatVerifyFailedGeneric')
    }
  } catch (e: any) {
    gitVerifyState.value = 'fail'
    gitVerifyError.value = e?.message || t('workspace.gitPatVerifyFailedGeneric')
  }
}

/** Verifica las creds tipeadas haciendo un HeadBucket. Botón "Verificar". */
async function verifyS3Credentials() {
  const s3cfg = cfg.value.s3
  if (!s3cfg) return
  const ak = s3Creds.value.accessKeyId.trim()
  const sk = s3Creds.value.secretAccessKey.trim()
  if (!ak || !sk) {
    s3VerifyState.value = 'fail'
    s3VerifyError.value = t('workspace.s3CredsBothRequired')
    return
  }
  if (!s3cfg.bucket) {
    s3VerifyState.value = 'fail'
    s3VerifyError.value = t('workspace.s3VerifyNeedsBucket')
    return
  }
  s3VerifyState.value = 'busy'
  s3VerifyError.value = null
  try {
    const r = await s3Api.headBucket(s3cfg.bucket, s3cfg.region || 'us-east-1', { accessKeyId: ak, secretAccessKey: sk })
    if (r.ok) {
      s3VerifyState.value = 'ok'
    } else {
      s3VerifyState.value = 'fail'
      s3VerifyError.value = r.error || t('workspace.s3VerifyFailedGeneric')
    }
  } catch (e: any) {
    s3VerifyState.value = 'fail'
    s3VerifyError.value = e?.message || t('workspace.s3VerifyFailedGeneric')
  }
}

// ── New workspace modal ───────────────────────────────────────────────────────
const showNewWs = ref(false)
const newWs = ref({
  name: '',
  repoPath: '',
  mode: 'folder' as 'folder' | 'clone',
  gitUrl: '',
  clonePath: '',
  contentRoot: 'content',
  useGit: true,
  preset: 'multi-tenant' as WorkspacePreset,
})
const newWsBusy = ref(false)
const newWsError = ref<string | null>(null)

function openNewWs() {
  newWs.value = {
    name: '',
    repoPath: '',
    mode: 'folder',
    gitUrl: '',
    clonePath: '',
    contentRoot: 'content',
    useGit: true,
    preset: 'multi-tenant',
  }
  newWsError.value = null
  showNewWs.value = true
}

async function pickNewWsFolder() {
  const r = await workspaceApi.pickFolder()
  if (r?.ok && r.path) newWs.value.repoPath = r.path
}

// CLONE mode: the destination folder must NOT exist yet (git clone creates it).
// So the picker chooses the EXISTING CONTAINER folder, and we append the repo
// name derived from the GitHub URL (git@github.com:user/mi-repo.git → "mi-repo",
// https://github.com/user/mi-repo → "mi-repo"). If the URL can't yield a name
// yet, fall back to the workspace name in kebab-case, else "repo".
function repoNameFromGitUrl(url: string): string {
  const u = (url || '').trim()
  if (u) {
    // Take the last path segment after the final "/" or ":" and drop a ".git".
    const tail = u.replace(/[/:]+$/, '').split(/[/:]/).pop() || ''
    const name = slugify(tail.replace(/\.git$/i, ''))
    if (name) return name
  }
  return slugify(newWs.value.name) || 'repo'
}

async function pickNewWsClonePath() {
  const r = await workspaceApi.pickFolder()
  if (r?.ok && r.path) {
    const container = r.path.replace(/\/+$/, '')
    newWs.value.clonePath = `${container}/${repoNameFromGitUrl(newWs.value.gitUrl)}`
  }
}

async function createWorkspace() {
  newWsBusy.value = true
  newWsError.value = null
  try {
    let repoPath = newWs.value.repoPath.trim()
    // Clonar solo tiene sentido con git; un workspace sin git es una carpeta.
    if (newWs.value.useGit && newWs.value.mode === 'clone') {
      const r = await workspaceApi.clone(newWs.value.gitUrl.trim(), newWs.value.clonePath.trim())
      if (!r?.ok || !r.path) { newWsError.value = r?.error || t('workspace.cloneFailed'); return }
      repoPath = r.path
    }
    if (!repoPath) { newWsError.value = t('workspace.pickFolderOrClone'); return }
    const name = newWs.value.name.trim() || repoPath.split('/').pop() || 'Workspace'
    const preset = newWs.value.preset || 'multi-tenant'
    const id = addWorkspace({
      name,
      repoPath,
      contentRoot: newWs.value.contentRoot.trim() || 'content',
      useGit: newWs.value.useGit,
      preset,
      s3: {
        enabled: false,
        bucket: '',
        prefix: '',
        region: 'us-east-1',
        // Default DERIVADO del preset. `publishManifestUserSet:false` deja al
        // server reaplicar el default si el preset cambia más adelante.
        publishManifest: presetPublishManifestDefault(preset),
        publishManifestUserSet: false,
      },
    })
    showNewWs.value = false
    const r = await selectWorkspace(id)
    if (!r?.ok) { wsError.value = r?.error || t('workspace.hostRejected'); return }
    await refreshProjects()
  } finally { newWsBusy.value = false }
}
</script>

<template>
  <div class="selector">
    <header class="hero">
      <div class="hero-text">
        <!-- Brand con el mismo look serif de la landing (GitHub Pages):
             icono + "Parallax" seminegrita + "Editor" en itálica atenuada. -->
        <h1 class="title">
          <img class="brand-icon" src="/brand-icon.png" alt="" aria-hidden="true" />
          <span class="brand-name">Parallax&nbsp;<em>Editor</em></span>
          <span class="app-version" data-test="app-version">{{ t('selector.appVersionLabel', { version: APP_VERSION }) }}</span>
        </h1>
        <p class="subtitle">{{ t('selector.subtitle') }}</p>
      </div>
      <div class="hero-actions">
      </div>
    </header>

    <!-- Git setup banner (persistent until git is configured) -->
    <div v-if="wsState.gitConfigured === false" class="git-banner" data-test="git-config-banner">
      <strong>{{ t('workspace.gitBannerStrong') }}</strong>
      {{ t('workspace.gitBannerBody') }}
    </div>

    <!-- Workspace selector bar -->
    <div class="ws-bar" data-test="workspace-bar">
      <span class="ws-bar-label">{{ t('workspace.label') }}</span>
      <div class="ws-chips">
        <div
          v-for="w in wsState.list"
          :key="w.id"
          class="ws-chip"
          :class="{ active: w.id === wsState.activeId }"
          :data-test="`workspace-chip-${w.id}`"
        >
          <button class="ws-chip-name" type="button" @click="pickWorkspace(w.id)">{{ w.name }}</button>
          <button
            class="ws-gear"
            type="button"
            :data-test="`workspace-gear-${w.id}`"
            :aria-label="t('workspace.gearAria')"
            :title="t('workspace.gearTitle')"
            @click="router.push(`/workspace/${w.id}/settings`)"
          >&#9881;</button>
        </div>
        <button class="ws-new" type="button" data-test="workspace-new" @click="openNewWs">{{ t('workspace.new') }}</button>
      </div>
    </div>

    <div v-if="wsError" class="ws-err" data-test="workspace-error">{{ wsError }}</div>

    <div class="search-bar">
      <span class="search-icon" aria-hidden="true">&#x1F50D;</span>
      <input
        ref="searchInput"
        v-model="search"
        type="search"
        class="search-input"
        data-test="project-search"
        :placeholder="t('selector.searchPlaceholder')"
        :aria-label="t('selector.searchAria')"
        autocomplete="off"
      />
      <button v-if="search" type="button" class="search-clear" :aria-label="t('selector.searchClearAria')" @click="search = ''">&times;</button>
    </div>

    <div v-if="loading" class="loading">{{ t('selector.loading') }}</div>

    <template v-else>
      <!-- Home pin: solo en linked-home. Si hay home en el listado, se renderiza
           como card destacada con badge "Inicio". Si NO existe, se ofrece un CTA
           para crearlo (el slug `home` se sirve en /). -->
      <section
        v-if="activeWorkspace && isLinkedHome"
        class="project-group home-group"
        data-test="home-pin-section"
      >
        <div class="group-header home-header">
          <h2 class="home-badge">{{ t('workspace.homeCardBadge') }}</h2>
        </div>

        <div v-if="homeProject" class="cards">
          <ProjectCard
            :type="(activeWorkspace as Workspace).id"
            :project="homeProject"
            :deleting="deletingSlug === homeProject.slug"
            @open="openProject(homeProject.slug)"
            @duplicate="duplicate(homeProject.slug)"
            @remove="remove(homeProject.slug)"
          />
        </div>
        <div v-else class="home-empty" data-test="home-empty">
          <div class="home-empty-text">
            <strong>{{ t('workspace.homeCardEmptyTitle') }}</strong>
            <p>{{ t('workspace.homeCardEmptyBody') }}</p>
          </div>
          <button
            class="btn-create-home"
            data-test="home-create"
            :disabled="creating"
            @click="createHomeSite"
          >{{ creating ? t('workspace.homeCardCreating') : t('workspace.homeCardCreateCta') }}</button>
        </div>
      </section>

      <section class="project-group">
        <div class="group-header">
          <h2>{{ activeWorkspace?.name || t('selector.defaultGroup') }}</h2>
          <span class="group-count">{{ nonHomeProjects.length }}</span>
          <button class="btn-new" data-test="btn-new-project" :disabled="!activeWorkspace" @click="showCreate = true">{{ newProjectCtaText }}</button>
        </div>

        <div v-if="!activeWorkspace" class="empty">
          {{ t('selector.noWorkspaceSelected') }} <strong>{{ t('selector.noWorkspaceCta') }}</strong>.
        </div>
        <div v-else-if="nonHomeProjects.length === 0" class="empty">
          {{ t('selector.noProjectsInWs') }} <strong>{{ newProjectCtaText }}</strong>.
        </div>
        <div v-else-if="visibleProjects.length === 0" class="no-results" data-test="no-results">
          {{ t('selector.noResults', { q: search }) }}
        </div>
        <div v-else class="cards">
          <ProjectCard
            v-for="p in visibleProjects"
            :key="p.slug"
            :type="(activeWorkspace as Workspace).id"
            :project="p"
            :deleting="deletingSlug === p.slug"
            @open="openProject(p.slug)"
            @duplicate="duplicate(p.slug)"
            @remove="remove(p.slug)"
          />
        </div>
      </section>
    </template>

    <!-- Create project modal -->
    <Teleport to="body">
      <div v-if="showCreate" class="create-backdrop" @click.self="showCreate = false">
        <div class="create-dialog" role="dialog" :aria-label="t('selector.createDialogAria')" data-test="create-dialog">
          <header class="cd-head">
            <h3 data-test="create-dialog-title">{{ createDialogTitleText }}</h3>
            <button class="cd-close" :aria-label="t('selector.closeAria')" @click="showCreate = false">&times;</button>
          </header>
          <div class="cd-body">
            <label class="field-label" for="new-site-name">{{ t('selector.nameLabel') }}</label>
            <input
              id="new-site-name"
              ref="nameInput"
              v-model="newName"
              data-test="new-site-name"
              :placeholder="namePlaceholderText"
              @keydown.enter="createNew"
            />
            <div class="slug-caption">{{ t('selector.slugCaption') }} <code data-test="new-site-slug">{{ slugPreview || '—' }}</code></div>
            <p class="slug-hint">{{ t('selector.slugHint') }}</p>
          </div>
          <div class="dialog-actions">
            <button @click="showCreate = false">{{ t('common.cancel') }}</button>
            <button class="primary" data-test="new-site-create" :disabled="!slugPreview || creating" @click="createNew">
              {{ creating ? t('selector.creating') : t('selector.create2') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Workspace config modal -->
    <Teleport to="body">
      <div v-if="wsConfigId" class="create-backdrop" @click.self="wsConfigId = null">
        <div class="create-dialog wide" role="dialog" :aria-label="t('workspace.configureAria')" data-test="workspace-config">
          <header class="cd-head">
            <h3>{{ t('workspace.configureTitle') }}</h3>
            <button class="cd-close" :aria-label="t('selector.closeAria')" @click="wsConfigId = null">&times;</button>
          </header>
          <div class="cd-body">
            <!-- Preset: dos cards radio. Aparece arriba porque el resto del
                 modal (publishManifest default, copy del proyecto) depende de
                 esta elección. -->
            <section class="preset-section" data-test="ws-cfg-preset">
              <div class="preset-header">
                <h4>{{ t('workspace.presetSection') }}</h4>
                <button
                  type="button"
                  class="preset-help-btn"
                  data-test="ws-cfg-preset-help"
                  @click="showPresetExplain = true"
                >{{ t('workspace.presetExplainLink') }}</button>
              </div>
              <div class="preset-cards">
                <label
                  class="preset-card"
                  :class="{ selected: cfg.preset === 'linked-home' }"
                  data-test="ws-cfg-preset-linked-home"
                >
                  <input
                    type="radio"
                    name="ws-preset"
                    value="linked-home"
                    :checked="cfg.preset === 'linked-home'"
                    @change="onPresetChange('linked-home')"
                  />
                  <div class="preset-card-title">{{ t('workspace.presetLinkedHomeTitle') }}</div>
                  <div class="preset-card-desc">{{ t('workspace.presetLinkedHomeDesc') }}</div>
                </label>
                <label
                  class="preset-card"
                  :class="{ selected: cfg.preset === 'multi-tenant' }"
                  data-test="ws-cfg-preset-multi-tenant"
                >
                  <input
                    type="radio"
                    name="ws-preset"
                    value="multi-tenant"
                    :checked="cfg.preset === 'multi-tenant'"
                    @change="onPresetChange('multi-tenant')"
                  />
                  <div class="preset-card-title">{{ t('workspace.presetMultiTenantTitle') }}</div>
                  <div class="preset-card-desc">{{ t('workspace.presetMultiTenantDesc') }}</div>
                </label>
              </div>
            </section>

            <label class="field-label">{{ t('workspace.nameField') }}</label>
            <input v-model="cfg.name" data-test="ws-cfg-name" :placeholder="t('workspace.namePlaceholder')" />

            <label class="field-label">{{ t('workspace.repoField') }}</label>
            <div class="row-with-btn">
              <input v-model="cfg.repoPath" data-test="ws-cfg-repopath" :placeholder="t('workspace.repoPlaceholder')" />
              <button class="aux-btn" type="button" data-test="ws-cfg-pick" @click="pickRepoFolder">{{ t('workspace.pickFolder') }}</button>
            </div>

            <label class="check-row" style="margin-top:10px">
              <input type="checkbox" v-model="cfg.useGit" data-test="ws-cfg-usegit" />
              {{ t('workspace.useGit') }}
            </label>
            <p v-if="!cfg.useGit" class="ws-hint" data-test="ws-cfg-nogit-hint">
              {{ t('workspace.nogitHintConfig') }}
            </p>

            <template v-if="cfg.useGit">
              <label class="field-label">{{ t('workspace.gitRemoteField') }}</label>
              <input v-model="cfg.gitRemote" :placeholder="t('workspace.gitRemotePlaceholder')" />
            </template>

            <label class="field-label">{{ t('workspace.contentRootField') }}</label>
            <input v-model="cfg.contentRoot" data-test="ws-cfg-contentroot" :placeholder="t('workspace.contentRootPlaceholder')" />

            <div class="s3-section" v-if="cfg.s3">
              <h4>{{ t('workspace.s3Section') }}</h4>
              <label class="check-row">
                <input type="checkbox" v-model="cfg.s3.enabled" data-test="ws-cfg-s3-enabled" />
                {{ t('workspace.s3Enable') }}
              </label>
              <template v-if="cfg.s3.enabled">
                <label class="field-label">{{ t('workspace.s3BucketField') }}</label>
                <div class="bucket-combo">
                  <input
                    v-model="cfg.s3.bucket"
                    class="bucket-input"
                    data-test="ws-cfg-s3-bucket"
                    :placeholder="t('workspace.s3BucketPlaceholder')"
                    autocomplete="off"
                    spellcheck="false"
                    @input="onBucketInput"
                    @focus="onBucketFocus"
                    @blur="onBucketBlur"
                    @keydown="onBucketKeydown"
                  />
                  <ul
                    v-if="bucketOpen && filteredBuckets.length"
                    class="bucket-list"
                    data-test="ws-cfg-s3-bucket-list"
                  >
                    <li
                      v-for="(b, i) in filteredBuckets"
                      :key="b"
                      class="bucket-opt"
                      :class="{ active: i === bucketActiveIdx }"
                      @mousedown.prevent="pickBucket(b)"
                      @mouseenter="bucketActiveIdx = i"
                    >{{ b }}</li>
                  </ul>
                </div>
                <div class="bucket-create-row">
                  <button class="aux-btn" type="button" :disabled="wsBusy || !cfg.s3.bucket" @click="createS3Bucket">{{ t('workspace.s3CreateBucket') }}</button>
                  <span class="bucket-create-hint">{{ t('workspace.s3CreateBucketHint') }}</span>
                </div>

                <label class="field-label">{{ t('workspace.s3PrefixField') }}</label>
                <input v-model="cfg.s3.prefix" placeholder="" />

                <label class="field-label">{{ t('workspace.s3RegionField') }}</label>
                <input v-model="cfg.s3.region" :placeholder="t('workspace.s3RegionPlaceholder')" />
              </template>

              <label class="check-row manifest-row">
                <input
                  type="checkbox"
                  v-model="cfg.s3.publishManifest"
                  data-test="ws-cfg-s3-manifest"
                  @change="onPublishManifestToggle"
                />
                {{ t('workspace.s3Manifest') }}
                <HelpHint
                  :label="t('workspace.s3ManifestHelp')"
                  :text="t('workspace.s3ManifestHelpText')"
                />
              </label>

              <!-- ── Modo de credenciales S3 (Fase 3) ──────────────────────── -->
              <div class="s3-creds-section" data-test="ws-cfg-s3-creds-section">
                <div class="s3-creds-header">
                  <h5>{{ t('workspace.s3CredsTitle') }}</h5>
                  <button
                    type="button"
                    class="preset-help-btn"
                    data-test="ws-cfg-s3-policy-help"
                    @click="showS3PolicyHelp = true"
                  >{{ t('workspace.s3PolicyHelpLink') }}</button>
                </div>

                <label class="radio-row">
                  <input
                    type="radio"
                    name="ws-s3-mode"
                    value="system"
                    :checked="cfg.s3.credentialsMode !== 'explicit'"
                    data-test="ws-cfg-s3-creds-system"
                    @change="cfg.s3.credentialsMode = 'system'"
                  />
                  <span class="radio-label">
                    <strong>{{ t('workspace.s3CredsSystemTitle') }}</strong>
                    <span class="radio-desc">{{ t('workspace.s3CredsSystemDesc') }}</span>
                  </span>
                </label>
                <label class="radio-row">
                  <input
                    type="radio"
                    name="ws-s3-mode"
                    value="explicit"
                    :checked="cfg.s3.credentialsMode === 'explicit'"
                    data-test="ws-cfg-s3-creds-explicit"
                    @change="cfg.s3.credentialsMode = 'explicit'"
                  />
                  <span class="radio-label">
                    <strong>{{ t('workspace.s3CredsExplicitTitle') }}</strong>
                    <span class="radio-desc">{{ t('workspace.s3CredsExplicitDesc') }}</span>
                  </span>
                </label>

                <div v-if="cfg.s3.credentialsMode === 'explicit'" class="s3-creds-fields">
                  <p v-if="s3CredsHasStored && !s3CredsDirty" class="s3-creds-stored-note" data-test="ws-cfg-s3-creds-stored">
                    {{ t('workspace.s3CredsStoredNote') }}
                  </p>
                  <label class="field-label">{{ t('workspace.s3AccessKeyIdField') }}</label>
                  <input
                    v-model="s3Creds.accessKeyId"
                    type="text"
                    data-test="ws-cfg-s3-accesskeyid"
                    :placeholder="t('workspace.s3AccessKeyIdPlaceholder')"
                    autocomplete="off"
                    spellcheck="false"
                    @input="onS3CredsInput"
                  />
                  <label class="field-label">{{ t('workspace.s3SecretAccessKeyField') }}</label>
                  <div class="row-with-btn">
                    <input
                      v-model="s3Creds.secretAccessKey"
                      :type="s3ShowSecret ? 'text' : 'password'"
                      data-test="ws-cfg-s3-secretkey"
                      :placeholder="t('workspace.s3SecretAccessKeyPlaceholder')"
                      autocomplete="off"
                      spellcheck="false"
                      @input="onS3CredsInput"
                    />
                    <button
                      class="aux-btn"
                      type="button"
                      data-test="ws-cfg-s3-toggle-secret"
                      @click="s3ShowSecret = !s3ShowSecret"
                    >{{ s3ShowSecret ? t('workspace.s3HideSecret') : t('workspace.s3ShowSecret') }}</button>
                  </div>

                  <div class="s3-verify-row">
                    <button
                      type="button"
                      class="aux-btn"
                      data-test="ws-cfg-s3-verify"
                      :disabled="s3VerifyState === 'busy'"
                      @click="verifyS3Credentials"
                    >{{ s3VerifyState === 'busy' ? t('workspace.s3VerifyBusy') : t('workspace.s3VerifyCta') }}</button>
                    <span v-if="s3VerifyState === 'ok'" class="s3-verify-ok" data-test="ws-cfg-s3-verify-ok">✓ {{ t('workspace.s3VerifyOk') }}</span>
                    <span v-else-if="s3VerifyState === 'fail'" class="s3-verify-fail" data-test="ws-cfg-s3-verify-fail">✗ {{ s3VerifyError || t('workspace.s3VerifyFailedGeneric') }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- ── Git Authentication (Fase 4) — solo aparece si el workspace
                 usa git. Mismo patrón visual que el bloque S3 credentials. -->
            <div v-if="cfg.useGit && cfg.git" class="git-auth-section" data-test="ws-cfg-git-auth-section">
              <div class="git-auth-header">
                <h4>{{ t('workspace.gitAuthSection') }}</h4>
                <button
                  type="button"
                  class="preset-help-btn"
                  data-test="ws-cfg-git-pat-help"
                  @click="showGitPatHelp = true"
                >{{ t('workspace.gitPatHelpLink') }}</button>
              </div>

              <label class="radio-row">
                <input
                  type="radio"
                  name="ws-git-mode"
                  value="system"
                  :checked="cfg.git.authMode !== 'pat'"
                  data-test="ws-cfg-git-mode-system"
                  @change="cfg.git.authMode = 'system'"
                />
                <span class="radio-label">
                  <strong>{{ t('workspace.gitAuthSystemTitle') }}</strong>
                  <span class="radio-desc">{{ t('workspace.gitAuthSystemDesc') }}</span>
                </span>
              </label>
              <label class="radio-row">
                <input
                  type="radio"
                  name="ws-git-mode"
                  value="pat"
                  :checked="cfg.git.authMode === 'pat'"
                  data-test="ws-cfg-git-mode-pat"
                  @change="cfg.git.authMode = 'pat'"
                />
                <span class="radio-label">
                  <strong>{{ t('workspace.gitAuthPatTitle') }}</strong>
                  <span class="radio-desc">{{ t('workspace.gitAuthPatDesc') }}</span>
                </span>
              </label>

              <div v-if="cfg.git.authMode === 'pat'" class="git-pat-fields">
                <p v-if="gitCredsHasStored && !gitCredsDirty" class="s3-creds-stored-note" data-test="ws-cfg-git-pat-stored">
                  {{ t('workspace.gitPatStoredNote') }}
                </p>
                <label class="field-label">{{ t('workspace.gitProviderField') }}</label>
                <select v-model="cfg.git.provider" data-test="ws-cfg-git-provider">
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="bitbucket">Bitbucket</option>
                </select>
                <label class="field-label">{{ t('workspace.gitPatUsernameField') }}</label>
                <input
                  v-model="gitCreds.username"
                  type="text"
                  data-test="ws-cfg-git-pat-username"
                  :placeholder="t('workspace.gitPatUsernamePlaceholder')"
                  autocomplete="off"
                  spellcheck="false"
                  @input="onGitCredsInput"
                />
                <label class="field-label">{{ t('workspace.gitPatTokenField') }}</label>
                <div class="row-with-btn">
                  <input
                    v-model="gitCreds.token"
                    :type="gitShowToken ? 'text' : 'password'"
                    data-test="ws-cfg-git-pat-token"
                    :placeholder="t('workspace.gitPatTokenPlaceholder')"
                    autocomplete="off"
                    spellcheck="false"
                    @input="onGitCredsInput"
                  />
                  <button
                    class="aux-btn"
                    type="button"
                    data-test="ws-cfg-git-pat-toggle"
                    @click="gitShowToken = !gitShowToken"
                  >{{ gitShowToken ? t('workspace.s3HideSecret') : t('workspace.s3ShowSecret') }}</button>
                </div>
                <div class="s3-verify-row">
                  <button
                    type="button"
                    class="aux-btn"
                    data-test="ws-cfg-git-pat-verify"
                    :disabled="gitVerifyState === 'busy'"
                    @click="verifyGitCredentials"
                  >{{ gitVerifyState === 'busy' ? t('workspace.s3VerifyBusy') : t('workspace.gitPatVerifyCta') }}</button>
                  <span v-if="gitVerifyState === 'ok'" class="s3-verify-ok" data-test="ws-cfg-git-pat-verify-ok">✓ {{ t('workspace.gitPatVerifyOk') }}</span>
                  <span v-else-if="gitVerifyState === 'fail'" class="s3-verify-fail" data-test="ws-cfg-git-pat-verify-fail">✗ {{ gitVerifyError || t('workspace.gitPatVerifyFailedGeneric') }}</span>
                </div>
              </div>
            </div>

            <p v-if="wsModalError" class="ws-err">{{ wsModalError }}</p>
          </div>
          <div class="dialog-actions spread">
            <button class="danger" data-test="ws-cfg-delete" @click="deleteWorkspace">{{ t('workspace.removeBtn') }}</button>
            <span class="spacer" />
            <button @click="wsConfigId = null">{{ t('common.cancel') }}</button>
            <button class="primary" data-test="ws-cfg-save" :disabled="wsBusy" @click="saveConfig">
              {{ wsBusy ? t('workspace.saving') : t('workspace.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- New workspace modal -->
    <Teleport to="body">
      <div v-if="showNewWs" class="create-backdrop" @click.self="showNewWs = false">
        <div class="create-dialog wide" role="dialog" :aria-label="t('workspace.newAria')" data-test="new-workspace">
          <header class="cd-head">
            <h3>{{ t('workspace.newTitle') }}</h3>
            <button class="cd-close" :aria-label="t('selector.closeAria')" @click="showNewWs = false">&times;</button>
          </header>
          <div class="cd-body">
            <!-- Preset: misma elección que en el modal de config. Aparece al
                 inicio porque el resto del flujo (defaults de manifest, copy de
                 "Nuevo evento/sitio") depende de esto. -->
            <section class="preset-section" data-test="new-ws-preset">
              <div class="preset-header">
                <h4>{{ t('workspace.presetSection') }}</h4>
                <button
                  type="button"
                  class="preset-help-btn"
                  data-test="new-ws-preset-help"
                  @click="showPresetExplain = true"
                >{{ t('workspace.presetExplainLink') }}</button>
              </div>
              <div class="preset-cards">
                <label
                  class="preset-card"
                  :class="{ selected: newWs.preset === 'linked-home' }"
                  data-test="new-ws-preset-linked-home"
                >
                  <input
                    type="radio"
                    name="new-ws-preset"
                    value="linked-home"
                    :checked="newWs.preset === 'linked-home'"
                    @change="newWs.preset = 'linked-home'"
                  />
                  <div class="preset-card-title">{{ t('workspace.presetLinkedHomeTitle') }}</div>
                  <div class="preset-card-desc">{{ t('workspace.presetLinkedHomeDesc') }}</div>
                </label>
                <label
                  class="preset-card"
                  :class="{ selected: newWs.preset === 'multi-tenant' }"
                  data-test="new-ws-preset-multi-tenant"
                >
                  <input
                    type="radio"
                    name="new-ws-preset"
                    value="multi-tenant"
                    :checked="newWs.preset === 'multi-tenant'"
                    @change="newWs.preset = 'multi-tenant'"
                  />
                  <div class="preset-card-title">{{ t('workspace.presetMultiTenantTitle') }}</div>
                  <div class="preset-card-desc">{{ t('workspace.presetMultiTenantDesc') }}</div>
                </label>
              </div>
            </section>

            <label class="field-label">{{ t('workspace.nameWsField') }}</label>
            <input v-model="newWs.name" data-test="new-ws-name" :placeholder="t('workspace.nameWsPlaceholder')" />

            <label class="check-row" style="margin-top:10px">
              <input
                type="checkbox"
                v-model="newWs.useGit"
                data-test="new-ws-usegit"
                @change="!newWs.useGit && (newWs.mode = 'folder')"
              />
              {{ t('workspace.useGit') }}
            </label>
            <p v-if="!newWs.useGit" class="ws-hint" data-test="new-ws-nogit-hint">
              {{ t('workspace.nogitHintNew') }}
            </p>

            <!-- Clonar solo aplica con git; sin git el workspace es una carpeta. -->
            <div class="mode-tabs" v-if="newWs.useGit">
              <button :class="{ active: newWs.mode === 'folder' }" @click="newWs.mode = 'folder'" data-test="new-ws-mode-folder">{{ t('workspace.modeFolder') }}</button>
              <button :class="{ active: newWs.mode === 'clone' }" @click="newWs.mode = 'clone'" data-test="new-ws-mode-clone">{{ t('workspace.modeClone') }}</button>
            </div>

            <template v-if="newWs.mode === 'folder'">
              <label class="field-label">{{ t('workspace.repoField') }}</label>
              <div class="row-with-btn">
                <input v-model="newWs.repoPath" data-test="new-ws-repopath" :placeholder="t('workspace.repoPlaceholder')" />
                <button class="aux-btn" type="button" data-test="new-ws-repopath-pick" @click="pickNewWsFolder">{{ t('workspace.pickFolder') }}</button>
              </div>
            </template>
            <template v-else>
              <label class="field-label">{{ t('workspace.gitUrlField') }}</label>
              <input v-model="newWs.gitUrl" data-test="new-ws-giturl" :placeholder="t('workspace.gitRemotePlaceholder')" />
              <label class="field-label">{{ t('workspace.clonePathField') }}</label>
              <div class="row-with-btn">
                <input v-model="newWs.clonePath" data-test="new-ws-clonepath" :placeholder="t('workspace.repoPlaceholder')" />
                <button class="aux-btn" type="button" data-test="new-ws-clonepath-pick" @click="pickNewWsClonePath">{{ t('workspace.pickFolder') }}</button>
              </div>
              <p class="slug-hint">{{ t('workspace.cloneHint') }}</p>
            </template>

            <label class="field-label">{{ t('workspace.contentRootField') }}</label>
            <input v-model="newWs.contentRoot" :placeholder="t('workspace.contentRootPlaceholder')" />

            <p v-if="newWsError" class="ws-err">{{ newWsError }}</p>
          </div>
          <div class="dialog-actions">
            <button @click="showNewWs = false">{{ t('common.cancel') }}</button>
            <button class="primary" data-test="new-ws-create" :disabled="newWsBusy" @click="createWorkspace">
              {{ newWsBusy ? t('workspace.creatingWs') : t('workspace.createWs') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- S3 IAM policy help modal — abierto desde "¿qué permisos S3 necesito?" -->
    <Teleport to="body">
      <div v-if="showS3PolicyHelp" class="create-backdrop" @click.self="showS3PolicyHelp = false">
        <div class="create-dialog wide" role="dialog" :aria-label="t('workspace.s3PolicyHelpTitle')" data-test="s3-policy-help">
          <header class="cd-head">
            <h3>{{ t('workspace.s3PolicyHelpTitle') }}</h3>
            <button class="cd-close" :aria-label="t('selector.closeAria')" @click="showS3PolicyHelp = false">&times;</button>
          </header>
          <div class="cd-body">
            <p class="s3-help-intro">{{ t('workspace.s3PolicyHelpIntro') }}</p>
            <ol class="s3-help-steps">
              <li>{{ t('workspace.s3PolicyHelpStep1') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep2') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep3') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep4') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep5') }}</li>
            </ol>
            <p class="s3-help-policy-label">{{ t('workspace.s3PolicyHelpPolicyLabel') }}</p>
            <pre class="s3-help-policy" data-test="s3-policy-snippet">{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket"
    ],
    "Resource": [
      "arn:aws:s3:::TU-BUCKET",
      "arn:aws:s3:::TU-BUCKET/*"
    ]
  }]
}</pre>
            <p class="s3-help-note">{{ t('workspace.s3PolicyHelpNote') }}</p>
          </div>
          <div class="dialog-actions">
            <button class="primary" @click="showS3PolicyHelp = false">{{ t('common.close') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Git PAT help modal — body depende del provider seleccionado -->
    <Teleport to="body">
      <div v-if="showGitPatHelp" class="create-backdrop" @click.self="showGitPatHelp = false">
        <div class="create-dialog wide" role="dialog" :aria-label="t('workspace.gitPatHelpTitle')" data-test="git-pat-help">
          <header class="cd-head">
            <h3>{{ t('workspace.gitPatHelpTitle') }}</h3>
            <button class="cd-close" :aria-label="t('selector.closeAria')" @click="showGitPatHelp = false">&times;</button>
          </header>
          <div class="cd-body">
            <p class="s3-help-intro">{{ t('workspace.gitPatHelpIntro') }}</p>

            <!-- GitHub -->
            <section v-if="(cfg.git?.provider || 'github') === 'github'">
              <h4 class="git-pat-help-provider">GitHub</h4>
              <ol class="s3-help-steps">
                <li>{{ t('workspace.gitPatHelpGhStep1') }}</li>
                <li>{{ t('workspace.gitPatHelpGhStep2') }}</li>
                <li>{{ t('workspace.gitPatHelpGhStep3') }}</li>
                <li>{{ t('workspace.gitPatHelpGhStep4') }}</li>
              </ol>
              <p class="s3-help-note">{{ t('workspace.gitPatHelpGhNote') }}</p>
            </section>

            <!-- GitLab -->
            <section v-else-if="cfg.git?.provider === 'gitlab'">
              <h4 class="git-pat-help-provider">GitLab</h4>
              <ol class="s3-help-steps">
                <li>{{ t('workspace.gitPatHelpGlStep1') }}</li>
                <li>{{ t('workspace.gitPatHelpGlStep2') }}</li>
                <li>{{ t('workspace.gitPatHelpGlStep3') }}</li>
              </ol>
            </section>

            <!-- Bitbucket -->
            <section v-else-if="cfg.git?.provider === 'bitbucket'">
              <h4 class="git-pat-help-provider">Bitbucket</h4>
              <ol class="s3-help-steps">
                <li>{{ t('workspace.gitPatHelpBbStep1') }}</li>
                <li>{{ t('workspace.gitPatHelpBbStep2') }}</li>
                <li>{{ t('workspace.gitPatHelpBbStep3') }}</li>
              </ol>
            </section>

            <p class="s3-help-note">{{ t('workspace.gitPatHelpHttpsOnly') }}</p>
          </div>
          <div class="dialog-actions">
            <button class="primary" @click="showGitPatHelp = false">{{ t('common.close') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Preset explanation modal — shared between config + new-workspace modals -->
    <Teleport to="body">
      <div v-if="showPresetExplain" class="create-backdrop" @click.self="showPresetExplain = false">
        <div class="create-dialog" role="dialog" :aria-label="t('workspace.presetExplainTitle')" data-test="preset-explain">
          <header class="cd-head">
            <h3>{{ t('workspace.presetExplainTitle') }}</h3>
            <button class="cd-close" :aria-label="t('selector.closeAria')" @click="showPresetExplain = false">&times;</button>
          </header>
          <div class="cd-body">
            <p
              v-for="(para, i) in t('workspace.presetExplainBody').split('\n\n')"
              :key="i"
              class="preset-explain-p"
              v-html="para.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>')"
            />
          </div>
          <div class="dialog-actions">
            <button class="primary" @click="showPresetExplain = false">{{ t('common.close') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Dashboard ancho (1120px) — antes 760px: con el grid de cards el selector
   aprovecha la pantalla en vez de dejar dos mares de negro a los lados. */
.selector {
  height: 100vh; height: 100dvh; overflow-y: auto; padding: 48px 32px 80px;
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(90, 110, 160, 0.08), transparent 60%),
    #101014;
}
.selector > * { max-width: 1120px; margin-left: auto; margin-right: auto; }

.hero {
  margin-bottom: 22px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.hero-actions { flex-shrink: 0; }
/* Brand serif de la landing: Playfair Display (local, ver index.html),
   "Parallax" 600 + "Editor" italic 400 atenuado, con el icono al lado. */
.title { display: flex; align-items: center; gap: 13px; margin-bottom: 6px; }
.brand-icon { width: 38px; height: 38px; border-radius: 9px; display: block; }
.brand-name {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #f2efe8;
}
.brand-name em { font-style: italic; font-weight: 400; color: #b9b4a8; }
.subtitle { color: #8a8a8a; font-size: 14px; }
.loading { color: #888; padding: 24px 0; }

/* Git banner */
.git-banner {
  background: #3a2a16; border: 1px solid #6b4a1f; color: #f0d9a8;
  border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; font-size: 13px; line-height: 1.5;
}
.git-banner strong { color: #ffd98a; }

/* Workspace bar */
.ws-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.ws-bar-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; }
.ws-chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ws-chip {
  display: flex; align-items: center; background: #1f1f1f; border: 1px solid #333;
  border-radius: 999px; overflow: hidden;
}
.ws-chip.active { border-color: var(--accent); background: #2a2418; }
.ws-chip-name { background: none; border: none; color: #ddd; cursor: pointer; padding: 6px 10px 6px 14px; font-size: 13px; }
.ws-chip.active .ws-chip-name { color: #fff; font-weight: 600; }
.ws-gear { background: none; border: none; color: #999; cursor: pointer; padding: 7px 12px 7px 6px; font-size: 18px; line-height: 1; }
.ws-gear:hover { color: #fff; }
.ws-new {
  background: #2a2a2a; border: 1px dashed #4a4a4a; color: #cfcfcf; border-radius: 999px;
  padding: 6px 14px; font-size: 13px; cursor: pointer;
}
.ws-new:hover { border-color: var(--accent); color: #fff; }
.ws-err { color: #ff8a8a; font-size: 13px; margin-bottom: 14px; }

/* Search bar */
.search-bar {
  display: flex; align-items: center; gap: 8px; background: #17171c; border: 1px solid #2a2a32;
  border-radius: 10px; padding: 0 12px; margin-bottom: 36px; transition: border-color 0.15s;
}
.search-bar:focus-within { border-color: #3b82f6; }
.search-icon { font-size: 13px; opacity: 0.55; }
.search-input { flex: 1 1 auto; background: none; border: none; outline: none; color: #e8e8e8; font-size: 14px; padding: 11px 0; }
.search-input::placeholder { color: #6b6b6b; }
.search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
.search-clear { background: none; border: none; color: #888; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 4px; }
.search-clear:hover { color: #fff; }

/* Groups */
.project-group { margin-bottom: 34px; }
.group-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #282828; }
.group-header h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #c4c4c4; }
.group-count { font-size: 11px; font-weight: 600; color: #888; background: #262626; border-radius: 999px; padding: 1px 8px; }
.btn-new { margin-left: auto; background: #2a2a2a; border: 1px solid #3a3a3a; color: #e0e0e0; padding: 5px 13px; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.15s, border-color 0.15s; }
.btn-new:hover:not(:disabled) { background: #353535; border-color: #4a4a4a; }
.btn-new:disabled { opacity: 0.5; cursor: default; }

.empty { color: #777; font-size: 13px; padding: 6px 2px; }
.empty strong { color: #aaa; font-weight: 600; }
.no-results { color: #777; font-size: 13px; padding: 6px 2px; font-style: italic; }
/* Grid de cards con preview grande (ProjectCard vertical). auto-fill mantiene
   el tamaño de card estable aunque haya pocas. */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; }

/* Modals (shared) */
.create-backdrop { position: fixed; inset: 0; z-index: 100001; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; padding: 24px; }
.create-dialog { width: min(480px, 92vw); max-height: 86vh; display: flex; flex-direction: column; background: #252525; border: 1px solid #3a3a3a; border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6); overflow: hidden; }
.create-dialog.wide { width: min(560px, 94vw); }
.cd-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid #333; }
.cd-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.cd-close { background: none; border: none; color: #999; font-size: 24px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 4px; }
.cd-close:hover { color: #fff; background: #ffffff14; }
.cd-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 20px 24px; }
.field-label { display: block; font-size: 13px; color: #bbb; margin-bottom: 6px; margin-top: 12px; }
.field-label:first-child { margin-top: 0; }
.create-dialog input[type="text"], .create-dialog input:not([type]) { width: 100%; }
.create-dialog input { width: 100%; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; background: #1a1a1a; color: #e0e0e0; font-size: 14px; box-sizing: border-box; }
.slug-caption { font-size: 13px; color: #aaa; margin-top: 10px; }
.slug-caption code { color: #6aa9e9; font-family: monospace; background: #1a1a1a; padding: 2px 6px; border-radius: 4px; }
.slug-hint { font-size: 11px; color: #777; margin: 4px 0 0; }
.ws-hint { font-size: 12px; color: #9a9a9a; background: #232323; border: 1px solid #2e2e2e; border-radius: 8px; padding: 8px 10px; margin: 4px 0 6px; line-height: 1.5; }
.app-version { font-size: 12px; font-weight: 500; color: #6b7280; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; align-self: flex-end; margin-bottom: 4px; }
.row-with-btn { display: flex; gap: 8px; align-items: center; }
.row-with-btn input { flex: 1 1 auto; }
.aux-btn { background: #333; border: 1px solid #555; color: #e0e0e0; border-radius: 6px; padding: 9px 12px; cursor: pointer; font-size: 13px; white-space: nowrap; }
.aux-btn:hover:not(:disabled) { background: #3c3c3c; }
.aux-btn:disabled { opacity: 0.5; cursor: default; }
.s3-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #333; }
.s3-section h4 { margin: 0 0 8px; font-size: 13px; color: #c4c4c4; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #ccc; margin-bottom: 6px; }
.check-row input { width: auto; }
.manifest-row { margin-top: 14px; padding-top: 12px; border-top: 1px solid #2f2f2f; }

/* Bucket combobox (Arreglo 2): a text input with an anchored dropdown BELOW it.
   The list is absolutely positioned relative to .bucket-combo so it overlays
   the modal content (high z-index) instead of pushing/floating beside the
   input. "Crear bucket" is its OWN row under the input, never over the list. */
.bucket-combo { position: relative; }
.bucket-input { width: 100%; }
.bucket-list {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 100002; /* above the modal (.create-dialog) content */
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  background: #232323;
  border: 1px solid #4a4a4a;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
}
.bucket-opt {
  padding: 6px 9px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #d6d6d6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bucket-opt.active,
.bucket-opt:hover { background: var(--accent-soft, #2a2418); color: #fff; }
.bucket-create-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.bucket-create-hint { font-size: 11px; color: #777; line-height: 1.4; }
.mode-tabs { display: flex; gap: 6px; margin: 14px 0 4px; }
.mode-tabs button { flex: 1 1 auto; background: #2a2a2a; border: 1px solid #444; color: #bbb; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.mode-tabs button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 16px 24px; border-top: 1px solid #333; }
.dialog-actions.spread { justify-content: flex-start; }
.dialog-actions .spacer { flex: 1 1 auto; }
.dialog-actions button { padding: 8px 16px; border: 1px solid #555; border-radius: 6px; background: #333; color: #e0e0e0; cursor: pointer; }
.dialog-actions button:hover:not(:disabled) { background: #3c3c3c; }
.dialog-actions .danger { border-color: #7a3030; color: #ffb0b0; }
.dialog-actions .danger:hover { background: #5a2020; }
.dialog-actions .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); transition: background .12s ease; }
.dialog-actions .primary:hover:not(:disabled) { background: var(--accent-hover); }
.dialog-actions .primary:disabled { opacity: 0.5; cursor: default; }

/* ── Preset picker ─────────────────────────────────────────────────────────── */
.preset-section { margin-bottom: 18px; }
.preset-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 16px; }
.preset-header h4 { margin: 0; font-size: 13px; font-weight: 700; color: #c4c4c4; text-transform: uppercase; letter-spacing: 0.06em; }
.preset-help-btn {
  background: none; border: none; color: var(--accent); font-size: 12px;
  cursor: pointer; padding: 4px 6px; text-decoration: underline; text-underline-offset: 2px;
  flex-shrink: 0;
}
.preset-help-btn:hover { color: var(--accent-hover); }
.preset-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.preset-card {
  display: flex; flex-direction: column; gap: 4px;
  padding: 12px 14px; border: 1.5px solid #3a3a3a; border-radius: 10px;
  background: #1f1f1f; cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s;
  position: relative;
}
.preset-card input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.preset-card:hover { border-color: #5a5a5a; background: #232323; }
.preset-card.selected {
  border-color: var(--accent);
  background: linear-gradient(180deg, #2e2a1b 0%, #25210f 100%);
  box-shadow: 0 0 0 3px rgba(255, 213, 109, 0.12), inset 0 0 0 1px rgba(255, 213, 109, 0.25);
}
.preset-card.selected .preset-card-title { color: #ffe2a3; }
.preset-card-title { font-size: 13px; font-weight: 600; color: #e6e6e6; }
.preset-card-desc { font-size: 11px; color: #999; line-height: 1.45; }
.preset-explain-p { font-size: 13px; color: #d6d6d6; line-height: 1.55; margin: 0 0 12px; }
.preset-explain-p:last-child { margin-bottom: 0; }
.preset-explain-p strong { color: #fff; }
.preset-explain-p code { color: #6aa9e9; background: #1a1a1a; padding: 1px 6px; border-radius: 4px; font-family: monospace; font-size: 12px; }

/* ── Home pin ──────────────────────────────────────────────────────────────── */
.home-group { margin-bottom: 18px; }
.home-header { gap: 8px; }
.home-badge {
  font-size: 11px !important; font-weight: 700; color: var(--accent) !important;
  background: rgba(255, 213, 109, 0.08); border: 1px solid rgba(255, 213, 109, 0.25);
  padding: 2px 10px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.08em;
}
.home-empty {
  display: flex; align-items: center; gap: 16px; justify-content: space-between;
  padding: 14px 16px; border: 1px dashed #3a3a3a; border-radius: 10px;
  background: #1c1c1c;
}
.home-empty-text { flex: 1 1 auto; }
.home-empty-text strong { display: block; color: #e6e6e6; font-size: 14px; margin-bottom: 4px; }
.home-empty-text p { margin: 0; font-size: 12px; color: #999; line-height: 1.5; }
.btn-create-home {
  flex-shrink: 0;
  background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent);
  padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;
  transition: background .12s ease;
}
.btn-create-home:hover:not(:disabled) { background: var(--accent-hover); }
.btn-create-home:disabled { opacity: 0.5; cursor: default; }

/* ── S3 credentials section (Fase 3) ─────────────────────────────────────── */
.s3-creds-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #2f2f2f; }
.s3-creds-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.s3-creds-header h5 { margin: 0; font-size: 12px; font-weight: 700; color: #c4c4c4; text-transform: uppercase; letter-spacing: 0.06em; }
.radio-row { display: grid; grid-template-columns: 18px 1fr; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: background .15s, border-color .15s; }
.radio-row:hover { background: #1f1f1f; border-color: #333; }
.radio-row input[type="radio"] { margin-top: 2px; accent-color: var(--accent); }
.radio-row:has(input[type="radio"]:checked) { background: #1f1d12; border-color: rgba(255, 213, 109, 0.4); }
.radio-row:has(input[type="radio"]:checked) .radio-label strong { color: #ffe2a3; }
.radio-label { display: flex; flex-direction: column; gap: 2px; }
.radio-label strong { font-size: 13px; color: #e6e6e6; font-weight: 600; }
.radio-desc { font-size: 11px; color: #999; line-height: 1.45; }
.s3-creds-fields { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #333; }
.s3-creds-stored-note {
  font-size: 12px; color: #9ad8a3;
  background: #1d2a1f; border: 1px solid #2a4a30; padding: 8px 10px; border-radius: 6px;
  margin: 0 0 10px;
}
.s3-verify-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.s3-verify-ok { color: #6ad08c; font-size: 12px; }
.s3-verify-fail { color: #ff8a8a; font-size: 12px; }
.s3-help-intro { font-size: 13px; color: #d6d6d6; margin: 0 0 12px; line-height: 1.5; }
.s3-help-steps { padding-left: 18px; margin: 0 0 14px; color: #d6d6d6; }
.s3-help-steps li { margin-bottom: 6px; font-size: 13px; line-height: 1.5; }
.s3-help-policy-label { font-size: 12px; color: #aaa; margin: 8px 0 4px; }
.s3-help-policy {
  background: #1a1a1a; border: 1px solid #333; border-radius: 8px;
  padding: 12px 14px; color: #d6d6d6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  line-height: 1.5; overflow-x: auto;
  white-space: pre;
}
.s3-help-note { font-size: 12px; color: #888; line-height: 1.5; margin: 10px 0 0; }
.git-auth-section { margin-top: 18px; padding-top: 12px; border-top: 1px solid #333; }
.git-auth-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.git-auth-header h4 { margin: 0; font-size: 13px; font-weight: 700; color: #c4c4c4; text-transform: uppercase; letter-spacing: 0.06em; }
.git-pat-fields { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #333; }
.git-pat-help-provider { margin: 12px 0 8px; font-size: 14px; color: #e6e6e6; }
.create-dialog select { width: 100%; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; background: #1a1a1a; color: #e0e0e0; font-size: 14px; }
</style>
