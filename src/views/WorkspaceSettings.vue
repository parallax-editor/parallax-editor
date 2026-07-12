<script setup lang="ts">
/**
 * WorkspaceSettings — pantalla dedicada de configuración del workspace.
 *
 * Reemplaza el modal in-line del selector que enterraba las secciones de
 * credenciales bajo el scroll y era imposible de encontrar cuando alguien
 * (Daniela) llegaba nueva al app. Ahora existe una ruta permanente
 * `/workspace/:id/settings` con 3 tabs claras: General, Publicación (S3),
 * Autenticación Git. Se llega desde:
 *   • el engranaje del chip del workspace en el selector,
 *   • el menú nativo Ventana → Configurar workspace,
 *   • el badge del toolbar del editor cuando falta config (Bloque B++).
 *
 * NO duplica lógica: la carga/persistencia/validación vive en
 * `useWorkspaceForm.ts` (compartida con el modal). Aquí sólo va el layout,
 * las tabs, el header con estado del server, y los modales de ayuda.
 */

import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { workspaceApi, s3Api, type WorkspaceStatus } from '../composables/useApi'
import { useWorkspaceForm, pickFolder } from '../composables/useWorkspaceForm'
import { wsState, activeWorkspace, loadWorkspaces, removeWorkspace } from '../stores/workspaces'
import { useSecrets, secretKeys } from '../composables/useSecrets'
import { useDialog } from '../composables/useDialog'
import HelpHint from '../components/properties/HelpHint.vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const dialog = useDialog()
const secrets = useSecrets()
const form = useWorkspaceForm({ t })

// Tab activa. Se puede llegar directo a una tab via `?tab=s3|git|general`
// para que el badge del toolbar del editor lleve directo al bloque relevante.
const tab = ref<'general' | 's3' | 'git'>((route.query.tab as any) || 'general')
watch(() => route.query.tab, (v) => { if (v === 'general' || v === 's3' || v === 'git') tab.value = v })

const workspaceId = computed(() => String(route.params.id || ''))

// Estado del server (endpoint /api/workspaces/:id/status). Aparece en el
// header como badges para que el usuario vea INMEDIATAMENTE qué está mal:
// "S3 sin credenciales guardadas", "Git remoto SSH pero configuraste PAT", etc.
const status = ref<WorkspaceStatus | null>(null)
const statusLoading = ref(false)
async function refreshStatus() {
  if (!workspaceId.value) return
  statusLoading.value = true
  try {
    status.value = await workspaceApi.status(workspaceId.value)
    // Un workspace legacy (creado antes del feature preset) tenía gitRemote
    // vacío en localStorage — el server SÍ lo conoce leyendo `git remote
    // get-url origin` del repo real. Hidratamos el campo aquí para no
    // engañar al usuario con "sin remoto" cuando el repo sí lo tiene.
    if (status.value?.ok) {
      form.hydrateGitRemoteFromServer(status.value.git?.remoteUrl)
    }
  } catch {
    status.value = null
  } finally {
    statusLoading.value = false
  }
}

// Bucket combobox (mismo patrón del modal viejo — dropdown anclado).
const bucketSuggestions = ref<string[]>([])
async function loadBuckets() {
  try {
    const r = await s3Api.buckets()
    if (r?.ok && Array.isArray(r.buckets)) bucketSuggestions.value = r.buckets
  } catch { /* offline / no creds → deja vacío */ }
}
const bucketOpen = ref(false)
const bucketActiveIdx = ref(-1)
const filteredBuckets = computed<string[]>(() => {
  const q = (form.cfg.value?.s3?.bucket || '').trim().toLowerCase()
  const list = bucketSuggestions.value
  if (!q) return list.slice(0, 50)
  return list.filter((b) => b.toLowerCase().includes(q)).slice(0, 50)
})
function pickBucket(name: string) {
  if (form.cfg.value?.s3) form.cfg.value.s3.bucket = name
  bucketOpen.value = false
  bucketActiveIdx.value = -1
}
function onBucketKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); bucketOpen.value = true; bucketActiveIdx.value = Math.min(bucketActiveIdx.value + 1, filteredBuckets.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); bucketActiveIdx.value = Math.max(bucketActiveIdx.value - 1, -1) }
  else if (e.key === 'Enter') {
    if (bucketOpen.value && bucketActiveIdx.value >= 0 && filteredBuckets.value[bucketActiveIdx.value]) {
      e.preventDefault(); pickBucket(filteredBuckets.value[bucketActiveIdx.value])
    } else { bucketOpen.value = false }
  }
  else if (e.key === 'Escape') { bucketOpen.value = false; bucketActiveIdx.value = -1 }
}
async function onPickRepo() {
  const p = await pickFolder()
  if (p && form.cfg.value) form.cfg.value.repoPath = p
}
async function createS3Bucket() {
  const s3 = form.cfg.value?.s3
  if (!s3?.bucket) return
  form.wsBusy.value = true
  try {
    const r = await s3Api.createBucket(s3.bucket, s3.region || 'us-east-1')
    if (!r?.ok) form.wsError.value = r?.error || t('workspace.s3CreateBucketFailed')
    else await loadBuckets()
  } finally { form.wsBusy.value = false }
}

// Modales de ayuda (mismos textos i18n que el modal viejo, reusados).
const showS3PolicyHelp = ref(false)
const showGitPatHelp = ref(false)
const showPresetExplain = ref(false)

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (showS3PolicyHelp.value) { e.stopPropagation(); showS3PolicyHelp.value = false; return }
  if (showGitPatHelp.value) { e.stopPropagation(); showGitPatHelp.value = false; return }
  if (showPresetExplain.value) { e.stopPropagation(); showPresetExplain.value = false; return }
}

async function onSave() {
  const r = await form.saveWorkspace()
  if (r.ok) {
    await refreshStatus()
    // No navegamos automáticamente; la pantalla de settings persiste. El usuario
    // vuelve al selector via el botón "Volver" o al editor via el chip activo.
  }
}
async function onDelete() {
  if (!form.cfg.value) return
  const ok = await dialog.confirm({
    title: t('workspace.removeConfirmTitle'),
    message: t('workspace.removeConfirmMessage'),
    confirmText: t('workspace.removeConfirmCta'),
    danger: true,
  })
  if (!ok) return
  const id = form.cfg.value.id
  // Limpia secretos huérfanos antes de quitar del store.
  try { await secrets.delete(secretKeys.s3(id)) } catch { /* best-effort */ }
  try { await secrets.delete(secretKeys.git(id)) } catch { /* best-effort */ }
  removeWorkspace(id)
  router.replace('/')
}

onMounted(async () => {
  document.addEventListener('keydown', onKey, true)
  if (!wsState.loaded) await loadWorkspaces()
  form.loadWorkspace(workspaceId.value)
  await Promise.all([loadBuckets(), refreshStatus()])
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

// Badges de estado para el header — decisiones de "por qué Publicar no
// funcionaría ahora" que el usuario ve SIN necesidad de abrir Doctor.
const s3Badge = computed<{ kind: 'ok' | 'warn' | 'off'; label: string }>(() => {
  const s = status.value?.s3
  if (!s?.enabled) return { kind: 'off', label: t('wsSettings.badgeS3Off') }
  if (s.credentialsMode === 'explicit' && !form.s3CredsHasStored.value) {
    return { kind: 'warn', label: t('wsSettings.badgeS3Missing') }
  }
  return { kind: 'ok', label: s.credentialsMode === 'explicit' ? t('wsSettings.badgeS3Keychain') : t('wsSettings.badgeS3System') }
})
const gitBadge = computed<{ kind: 'ok' | 'warn' | 'off'; label: string }>(() => {
  const g = status.value?.git
  if (!g?.useGit) return { kind: 'off', label: t('wsSettings.badgeGitOff') }
  if (g.authMode === 'pat') {
    if (!form.gitCredsHasStored.value) return { kind: 'warn', label: t('wsSettings.badgeGitPatMissing') }
    if (g.remoteUrl && !g.remoteIsHttps) return { kind: 'warn', label: t('wsSettings.badgeGitPatOnSsh') }
    return { kind: 'ok', label: t('wsSettings.badgeGitKeychain') }
  }
  return { kind: 'ok', label: t('wsSettings.badgeGitSystem') }
})

function goBack() { router.push('/') }
</script>

<template>
  <div class="settings-page" data-test="workspace-settings">
    <header class="page-header">
      <!-- Fila 1: Back + Title/Subtitle. Los badges ahora viven en una fila
           debajo para que el título tenga espacio y no se corte con nombres
           largos (feedback Josh: "muy apretado"). -->
      <div class="page-header-row">
        <button class="back-btn" type="button" @click="goBack" data-test="wsSettings-back">← {{ t('wsSettings.back') }}</button>
        <div class="page-title">
          <h1>{{ form.cfg.value?.name || workspaceId }}</h1>
          <p class="page-subtitle">{{ t('wsSettings.subtitle') }}</p>
        </div>
      </div>
      <!-- Fila 2: Badges de estado. -->
      <div class="header-badges" v-if="status?.ok">
        <span :class="['badge', s3Badge.kind]" data-test="wsSettings-badge-s3">S3 · {{ s3Badge.label }}</span>
        <span :class="['badge', gitBadge.kind]" data-test="wsSettings-badge-git">Git · {{ gitBadge.label }}</span>
      </div>
    </header>

    <nav class="tabs">
      <button :class="['tab', { active: tab === 'general' }]" @click="tab = 'general'" data-test="wsSettings-tab-general">{{ t('wsSettings.tabGeneral') }}</button>
      <button :class="['tab', { active: tab === 's3' }]" @click="tab = 's3'" data-test="wsSettings-tab-s3">{{ t('wsSettings.tabS3') }}</button>
      <button :class="['tab', { active: tab === 'git' }]" @click="tab = 'git'" data-test="wsSettings-tab-git" :disabled="form.cfg.value?.useGit === false">{{ t('wsSettings.tabGit') }}</button>
    </nav>

    <div v-if="form.wsError.value" class="ws-err" data-test="wsSettings-error">{{ form.wsError.value }}</div>
    <!-- Banner de aviso: workspace legacy sin preset. Amarillo (warn) para
         diferenciarlo de un error rojo. Guardar queda deshabilitado hasta que
         el usuario elija un preset (belt & suspenders con el guard del
         composable en saveWorkspace). -->
    <div
      v-if="form.presetMissingAtLoad.value && !form.cfg.value?.preset"
      class="ws-warn"
      data-test="wsSettings-preset-warning"
    >
      ⚠️ {{ t('workspace.presetMissingWarning') }}
    </div>

    <!-- ── TAB: GENERAL ────────────────────────────────────────────────── -->
    <section v-if="tab === 'general' && form.cfg.value" class="tab-body">
      <!-- Preset picker (mismos cards que el modal viejo) -->
      <div class="field-group">
        <div class="field-group-head">
          <h3>{{ t('workspace.presetSection') }}</h3>
          <button type="button" class="link-btn" @click="showPresetExplain = true">{{ t('workspace.presetExplainLink') }}</button>
        </div>
        <div class="preset-cards">
          <label class="preset-card" :class="{ selected: form.cfg.value.preset === 'linked-home' }">
            <input type="radio" name="ws-preset" value="linked-home" :checked="form.cfg.value.preset === 'linked-home'" @change="form.onPresetChange('linked-home')" />
            <div class="preset-title">{{ t('workspace.presetLinkedHomeTitle') }}</div>
            <div class="preset-desc">{{ t('workspace.presetLinkedHomeDesc') }}</div>
          </label>
          <label class="preset-card" :class="{ selected: form.cfg.value.preset === 'multi-tenant' }">
            <input type="radio" name="ws-preset" value="multi-tenant" :checked="form.cfg.value.preset === 'multi-tenant'" @change="form.onPresetChange('multi-tenant')" />
            <div class="preset-title">{{ t('workspace.presetMultiTenantTitle') }}</div>
            <div class="preset-desc">{{ t('workspace.presetMultiTenantDesc') }}</div>
          </label>
        </div>
      </div>

      <div class="field-group">
        <label class="field-label">{{ t('workspace.nameField') }}</label>
        <input v-model="form.cfg.value.name" data-test="wsSettings-name" :placeholder="t('workspace.namePlaceholder')" />

        <label class="field-label">{{ t('workspace.repoField') }}</label>
        <div class="row-with-btn">
          <input v-model="form.cfg.value.repoPath" data-test="wsSettings-repopath" :placeholder="t('workspace.repoPlaceholder')" />
          <button class="aux-btn" type="button" @click="onPickRepo">{{ t('workspace.pickFolder') }}</button>
        </div>

        <label class="check-row">
          <input type="checkbox" v-model="form.cfg.value.useGit" data-test="wsSettings-usegit" />
          {{ t('workspace.useGit') }}
        </label>
        <p v-if="!form.cfg.value.useGit" class="ws-hint">{{ t('workspace.nogitHintConfig') }}</p>

        <template v-if="form.cfg.value.useGit">
          <label class="field-label">{{ t('workspace.gitRemoteField') }}</label>
          <input v-model="form.cfg.value.gitRemote" :placeholder="t('workspace.gitRemotePlaceholder')" />
        </template>

        <label class="field-label">{{ t('workspace.contentRootField') }}</label>
        <input v-model="form.cfg.value.contentRoot" data-test="wsSettings-contentroot" :placeholder="t('workspace.contentRootPlaceholder')" />
      </div>
    </section>

    <!-- ── TAB: S3 ─────────────────────────────────────────────────────── -->
    <section v-if="tab === 's3' && form.cfg.value?.s3" class="tab-body">
      <div class="field-group">
        <label class="check-row">
          <input type="checkbox" v-model="form.cfg.value.s3.enabled" data-test="wsSettings-s3-enabled" />
          {{ t('workspace.s3Enable') }}
        </label>
        <template v-if="form.cfg.value.s3.enabled">
          <label class="field-label">{{ t('workspace.s3BucketField') }}</label>
          <div class="bucket-combo">
            <input
              v-model="form.cfg.value.s3.bucket"
              class="bucket-input"
              data-test="wsSettings-s3-bucket"
              :placeholder="t('workspace.s3BucketPlaceholder')"
              autocomplete="off"
              spellcheck="false"
              @focus="bucketOpen = true"
              @blur="setTimeout(() => bucketOpen = false, 150)"
              @input="bucketOpen = true; bucketActiveIdx = -1"
              @keydown="onBucketKeydown"
            />
            <ul v-if="bucketOpen && filteredBuckets.length" class="bucket-list">
              <li
                v-for="(b, i) in filteredBuckets"
                :key="b"
                :class="['bucket-opt', { active: i === bucketActiveIdx }]"
                @mousedown.prevent="pickBucket(b)"
                @mouseenter="bucketActiveIdx = i"
              >{{ b }}</li>
            </ul>
          </div>
          <div class="row-with-btn tight">
            <button class="aux-btn" type="button" :disabled="form.wsBusy.value || !form.cfg.value.s3.bucket" @click="createS3Bucket">{{ t('workspace.s3CreateBucket') }}</button>
            <span class="bucket-hint">{{ t('workspace.s3CreateBucketHint') }}</span>
          </div>
          <label class="field-label">{{ t('workspace.s3PrefixField') }}</label>
          <input v-model="form.cfg.value.s3.prefix" placeholder="" />
          <label class="field-label">{{ t('workspace.s3RegionField') }}</label>
          <input v-model="form.cfg.value.s3.region" :placeholder="t('workspace.s3RegionPlaceholder')" />
          <label class="check-row">
            <input type="checkbox" v-model="form.cfg.value.s3.publishManifest" data-test="wsSettings-s3-manifest" @change="form.onPublishManifestToggle" />
            {{ t('workspace.s3Manifest') }}
            <HelpHint :label="t('workspace.s3ManifestHelp')" :text="t('workspace.s3ManifestHelpText')" />
          </label>
        </template>
      </div>

      <!-- Credenciales -->
      <div class="field-group" v-if="form.cfg.value.s3.enabled">
        <div class="field-group-head">
          <h3>{{ t('workspace.s3CredsTitle') }}</h3>
          <button type="button" class="link-btn" @click="showS3PolicyHelp = true">{{ t('workspace.s3PolicyHelpLink') }}</button>
        </div>
        <label class="radio-row">
          <input type="radio" name="s3-mode" value="system" :checked="form.cfg.value.s3.credentialsMode !== 'explicit'" data-test="wsSettings-s3-creds-system" @change="form.cfg.value.s3.credentialsMode = 'system'" />
          <span class="radio-label">
            <strong>{{ t('workspace.s3CredsSystemTitle') }}</strong>
            <span class="radio-desc">{{ t('workspace.s3CredsSystemDesc') }}</span>
          </span>
        </label>
        <label class="radio-row">
          <input type="radio" name="s3-mode" value="explicit" :checked="form.cfg.value.s3.credentialsMode === 'explicit'" data-test="wsSettings-s3-creds-explicit" @change="form.cfg.value.s3.credentialsMode = 'explicit'" />
          <span class="radio-label">
            <strong>{{ t('workspace.s3CredsExplicitTitle') }}</strong>
            <span class="radio-desc">{{ t('workspace.s3CredsExplicitDesc') }}</span>
          </span>
        </label>

        <div v-if="form.cfg.value.s3.credentialsMode === 'explicit'" class="creds-fields">
          <p v-if="form.s3CredsHasStored.value && !form.s3CredsDirty.value" class="stored-note" data-test="wsSettings-s3-stored">
            {{ t('workspace.s3CredsStoredNote') }}
          </p>
          <label class="field-label">{{ t('workspace.s3AccessKeyIdField') }}</label>
          <input v-model="form.s3Creds.value.accessKeyId" type="text" data-test="wsSettings-s3-akid" :placeholder="t('workspace.s3AccessKeyIdPlaceholder')" autocomplete="off" spellcheck="false" @input="form.onS3CredsInput" />
          <label class="field-label">{{ t('workspace.s3SecretAccessKeyField') }}</label>
          <div class="row-with-btn">
            <input v-model="form.s3Creds.value.secretAccessKey" :type="form.s3ShowSecret.value ? 'text' : 'password'" data-test="wsSettings-s3-secret" :placeholder="t('workspace.s3SecretAccessKeyPlaceholder')" autocomplete="off" spellcheck="false" @input="form.onS3CredsInput" />
            <button class="aux-btn" type="button" @click="form.s3ShowSecret.value = !form.s3ShowSecret.value">{{ form.s3ShowSecret.value ? t('workspace.s3HideSecret') : t('workspace.s3ShowSecret') }}</button>
          </div>
        </div>

        <!-- Botón Verificar acceso: ahora SIEMPRE visible dentro del grupo de
             credenciales (system o explicit). En system prueba la cadena por
             defecto del servidor; en explicit exige que el user tipee creds
             primero. Ambos casos requieren bucket configurado. -->
        <div class="verify-row" v-if="form.cfg.value.s3.enabled">
          <button type="button" class="aux-btn" data-test="wsSettings-s3-verify" :disabled="form.s3VerifyState.value === 'busy' || !form.cfg.value.s3.bucket" @click="form.verifyS3Credentials">{{ form.s3VerifyState.value === 'busy' ? t('workspace.s3VerifyBusy') : t('workspace.s3VerifyCta') }}</button>
          <span v-if="form.s3VerifyState.value === 'ok'" class="verify-ok">✓ {{ t('workspace.s3VerifyOk') }}</span>
          <span v-else-if="form.s3VerifyState.value === 'fail'" class="verify-fail">✗ {{ form.s3VerifyError.value || t('workspace.s3VerifyFailedGeneric') }}</span>
        </div>
      </div>
    </section>

    <!-- ── TAB: GIT ────────────────────────────────────────────────────── -->
    <section v-if="tab === 'git' && form.cfg.value?.useGit && form.cfg.value.git" class="tab-body">
      <div class="field-group">
        <div class="field-group-head">
          <h3>{{ t('workspace.gitAuthSection') }}</h3>
          <button type="button" class="link-btn" @click="showGitPatHelp = true">{{ t('workspace.gitPatHelpLink') }}</button>
        </div>

        <div v-if="status?.git?.remoteUrl" class="git-remote-info" data-test="wsSettings-git-remote">
          <div class="remote-label">{{ t('wsSettings.gitRemoteLabel') }}</div>
          <div class="remote-url">
            <code>{{ status.git.remoteUrl }}</code>
            <span v-if="status.git.remoteIsHttps" class="tag ok">HTTPS ✓</span>
            <span v-else class="tag warn">SSH</span>
          </div>
        </div>

        <label class="radio-row">
          <input type="radio" name="git-mode" value="system" :checked="form.cfg.value.git.authMode !== 'pat'" data-test="wsSettings-git-system" @change="form.cfg.value.git.authMode = 'system'" />
          <span class="radio-label">
            <strong>{{ t('workspace.gitAuthSystemTitle') }}</strong>
            <span class="radio-desc">{{ t('workspace.gitAuthSystemDesc') }}</span>
          </span>
        </label>
        <label class="radio-row">
          <input type="radio" name="git-mode" value="pat" :checked="form.cfg.value.git.authMode === 'pat'" data-test="wsSettings-git-pat" @change="form.cfg.value.git.authMode = 'pat'" />
          <span class="radio-label">
            <strong>{{ t('workspace.gitAuthPatTitle') }}</strong>
            <span class="radio-desc">{{ t('workspace.gitAuthPatDesc') }}</span>
          </span>
        </label>

        <div v-if="form.cfg.value.git.authMode === 'pat'" class="creds-fields">
          <p v-if="form.gitCredsHasStored.value && !form.gitCredsDirty.value" class="stored-note" data-test="wsSettings-git-stored">
            {{ t('workspace.gitPatStoredNote') }}
          </p>
          <label class="field-label">{{ t('workspace.gitProviderField') }}</label>
          <select v-model="form.cfg.value.git.provider" data-test="wsSettings-git-provider">
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="bitbucket">Bitbucket</option>
          </select>
          <label class="field-label">{{ t('workspace.gitPatUsernameField') }}</label>
          <input v-model="form.gitCreds.value.username" type="text" data-test="wsSettings-git-user" :placeholder="t('workspace.gitPatUsernamePlaceholder')" autocomplete="off" spellcheck="false" @input="form.onGitCredsInput" />
          <label class="field-label">{{ t('workspace.gitPatTokenField') }}</label>
          <div class="row-with-btn">
            <input v-model="form.gitCreds.value.token" :type="form.gitShowToken.value ? 'text' : 'password'" data-test="wsSettings-git-token" :placeholder="t('workspace.gitPatTokenPlaceholder')" autocomplete="off" spellcheck="false" @input="form.onGitCredsInput" />
            <button class="aux-btn" type="button" @click="form.gitShowToken.value = !form.gitShowToken.value">{{ form.gitShowToken.value ? t('workspace.s3HideSecret') : t('workspace.s3ShowSecret') }}</button>
          </div>
          <div class="verify-row">
            <button type="button" class="aux-btn" data-test="wsSettings-git-verify" :disabled="form.gitVerifyState.value === 'busy'" @click="form.verifyGitCredentials">{{ form.gitVerifyState.value === 'busy' ? t('workspace.s3VerifyBusy') : t('workspace.gitPatVerifyCta') }}</button>
            <span v-if="form.gitVerifyState.value === 'ok'" class="verify-ok">✓ {{ t('workspace.gitPatVerifyOk') }}</span>
            <span v-else-if="form.gitVerifyState.value === 'fail'" class="verify-fail">✗ {{ form.gitVerifyError.value || t('workspace.gitPatVerifyFailedGeneric') }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Footer con acciones ─────────────────────────────────────────── -->
    <footer class="page-footer" v-if="form.cfg.value">
      <button class="danger-btn" type="button" data-test="wsSettings-delete" @click="onDelete">{{ t('workspace.removeBtn') }}</button>
      <div class="spacer" />
      <button class="ghost-btn" type="button" @click="goBack">{{ t('common.cancel') }}</button>
      <button
        class="primary-btn"
        type="button"
        data-test="wsSettings-save"
        :disabled="form.wsBusy.value || (form.presetMissingAtLoad.value && !form.cfg.value?.preset)"
        :title="form.presetMissingAtLoad.value && !form.cfg.value?.preset ? t('workspace.presetMissingWarning') : undefined"
        @click="onSave"
      >
        {{ form.wsBusy.value ? t('workspace.saving') : t('workspace.save') }}
      </button>
    </footer>

    <!-- Modales de ayuda — reusa las mismas i18n keys que el modal viejo. -->
    <Teleport to="body">
      <div v-if="showPresetExplain" class="create-backdrop" @click.self="showPresetExplain = false">
        <div class="create-dialog" role="dialog">
          <header class="cd-head"><h3>{{ t('workspace.presetExplainTitle') }}</h3><button class="cd-close" @click="showPresetExplain = false">&times;</button></header>
          <div class="cd-body">
            <p v-for="(p, i) in t('workspace.presetExplainBody').split('\n\n')" :key="i" class="explain-p"
              v-html="p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>')" />
          </div>
          <div class="dialog-actions"><button class="primary-btn" @click="showPresetExplain = false">{{ t('common.close') }}</button></div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showS3PolicyHelp" class="create-backdrop" @click.self="showS3PolicyHelp = false">
        <div class="create-dialog wide" role="dialog">
          <header class="cd-head"><h3>{{ t('workspace.s3PolicyHelpTitle') }}</h3><button class="cd-close" @click="showS3PolicyHelp = false">&times;</button></header>
          <div class="cd-body">
            <p class="explain-p">{{ t('workspace.s3PolicyHelpIntro') }}</p>
            <ol class="help-steps">
              <li>{{ t('workspace.s3PolicyHelpStep1') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep2') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep3') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep4') }}</li>
              <li>{{ t('workspace.s3PolicyHelpStep5') }}</li>
            </ol>
            <p class="explain-p">{{ t('workspace.s3PolicyHelpPolicyLabel') }}</p>
            <pre class="policy-block">{
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
            <p class="explain-note">{{ t('workspace.s3PolicyHelpNote') }}</p>
          </div>
          <div class="dialog-actions"><button class="primary-btn" @click="showS3PolicyHelp = false">{{ t('common.close') }}</button></div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="showGitPatHelp" class="create-backdrop" @click.self="showGitPatHelp = false">
        <div class="create-dialog wide" role="dialog">
          <header class="cd-head"><h3>{{ t('workspace.gitPatHelpTitle') }}</h3><button class="cd-close" @click="showGitPatHelp = false">&times;</button></header>
          <div class="cd-body">
            <p class="explain-p">{{ t('workspace.gitPatHelpIntro') }}</p>
            <section v-if="(form.cfg.value?.git?.provider || 'github') === 'github'">
              <h4 class="help-provider">GitHub</h4>
              <ol class="help-steps">
                <li>{{ t('workspace.gitPatHelpGhStep1') }}</li>
                <li>{{ t('workspace.gitPatHelpGhStep2') }}</li>
                <li>{{ t('workspace.gitPatHelpGhStep3') }}</li>
                <li>{{ t('workspace.gitPatHelpGhStep4') }}</li>
              </ol>
              <p class="explain-note">{{ t('workspace.gitPatHelpGhNote') }}</p>
            </section>
            <section v-else-if="form.cfg.value?.git?.provider === 'gitlab'">
              <h4 class="help-provider">GitLab</h4>
              <ol class="help-steps">
                <li>{{ t('workspace.gitPatHelpGlStep1') }}</li>
                <li>{{ t('workspace.gitPatHelpGlStep2') }}</li>
                <li>{{ t('workspace.gitPatHelpGlStep3') }}</li>
              </ol>
            </section>
            <section v-else-if="form.cfg.value?.git?.provider === 'bitbucket'">
              <h4 class="help-provider">Bitbucket</h4>
              <ol class="help-steps">
                <li>{{ t('workspace.gitPatHelpBbStep1') }}</li>
                <li>{{ t('workspace.gitPatHelpBbStep2') }}</li>
                <li>{{ t('workspace.gitPatHelpBbStep3') }}</li>
              </ol>
            </section>
            <p class="explain-note">{{ t('workspace.gitPatHelpHttpsOnly') }}</p>
          </div>
          <div class="dialog-actions"><button class="primary-btn" @click="showGitPatHelp = false">{{ t('common.close') }}</button></div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* CUARTO INTENT — la causa raíz: `index.html` fija `body { overflow: hidden }`
   para la app de paneles del editor, así que la pantalla de settings no tenía
   NINGÚN contenedor scrollable (ni body, ni ella misma). El contenido más allá
   del viewport quedaba invisible → "el scroll de esto no funciona" (tercera vez).
   Fix: la propia `.settings-page` se vuelve el scroll container ocupando toda
   la altura del viewport. El footer sigue FIXED al viewport, y el padding-bottom
   grande (160px) reserva espacio para que el último campo no quede tapado.
   Centramos con box interno para conservar el max-width del contenido. */
.settings-page { height: 100vh; overflow-y: auto; overflow-x: hidden; max-width: 800px; margin: 0 auto; padding: 40px 24px 160px; color: #e0e0e0; box-sizing: border-box; }
/* Cabecera en 3 bandas verticales para respirar (feedback Josh "muy apretado"):
   1) botón Volver (con aire), 2) título+subtítulo, 3) badges. */
.page-header { display: flex; flex-direction: column; gap: 18px; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #2a2a2a; }
.page-header-row { display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
.back-btn { background: #1a1a1a; border: 1px solid #2a2a2a; color: #9ab; font-size: 13px; cursor: pointer; padding: 8px 14px; border-radius: 6px; transition: background .15s, color .15s, border-color .15s; }
.back-btn:hover { background: #232323; color: #fff; border-color: #3a3a3a; }
.page-title { display: flex; flex-direction: column; gap: 6px; }
.page-title h1 { font-size: 24px; margin: 0; letter-spacing: -0.01em; }
.page-subtitle { font-size: 13px; color: #8a8a8a; margin: 0; }
.header-badges { display: flex; gap: 8px; flex-wrap: wrap; }
.badge { font-size: 11px; padding: 4px 10px; border-radius: 999px; font-weight: 600; letter-spacing: 0.01em; }
.badge.ok { background: rgba(88, 190, 105, 0.15); color: #6ad08c; border: 1px solid rgba(88, 190, 105, 0.35); }
.badge.warn { background: rgba(230, 175, 75, 0.15); color: #ffb663; border: 1px solid rgba(230, 175, 75, 0.35); }
.badge.off { background: #22221a; color: #888; border: 1px solid #333; }

.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid #2a2a2a; }
.tab { background: none; border: none; color: #999; font-size: 14px; padding: 10px 16px; cursor: pointer; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; }
.tab:hover { color: #ccc; }
.tab.active { color: #fff; border-bottom-color: var(--accent); }
.tab:disabled { color: #555; cursor: default; }

.tab-body { display: flex; flex-direction: column; gap: 24px; }
.field-group { background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 8px; }
.field-group-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.field-group-head h3 { margin: 0; font-size: 13px; font-weight: 700; color: #c4c4c4; text-transform: uppercase; letter-spacing: 0.06em; }
.link-btn { background: none; border: none; color: var(--accent); font-size: 12px; cursor: pointer; padding: 4px 6px; text-decoration: underline; text-underline-offset: 2px; }
.link-btn:hover { color: var(--accent-hover); }

.field-label { display: block; font-size: 13px; color: #bbb; margin: 12px 0 6px; }
.settings-page input:not([type=checkbox]):not([type=radio]),
.settings-page select { width: 100%; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; background: #101010; color: #e0e0e0; font-size: 14px; box-sizing: border-box; }
.row-with-btn { display: flex; gap: 8px; align-items: center; }
.row-with-btn.tight { margin-top: 6px; }
.row-with-btn input { flex: 1; }
.aux-btn { background: #333; border: 1px solid #555; color: #e0e0e0; border-radius: 6px; padding: 9px 12px; cursor: pointer; font-size: 13px; white-space: nowrap; }
.aux-btn:hover:not(:disabled) { background: #3c3c3c; }
.aux-btn:disabled { opacity: 0.5; cursor: default; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #ccc; margin: 8px 0; cursor: pointer; }
.check-row input { width: auto; }
.ws-hint { font-size: 12px; color: #9a9a9a; background: #232323; border: 1px solid #2e2e2e; border-radius: 8px; padding: 8px 10px; line-height: 1.5; margin: 4px 0; }
.ws-err { background: #3a1a1a; border: 1px solid #6b2a2a; color: #ff9d9d; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; }
.ws-warn { background: #2e2916; border: 1px solid #5b4c1e; color: #ffd98a; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; line-height: 1.5; }

.preset-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.preset-card { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border: 1.5px solid #3a3a3a; border-radius: 10px; background: #1f1f1f; cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s; position: relative; }
.preset-card input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.preset-card:hover { border-color: #5a5a5a; background: #232323; }
.preset-card.selected { border-color: var(--accent); background: linear-gradient(180deg, #2e2a1b 0%, #25210f 100%); box-shadow: 0 0 0 3px rgba(255, 213, 109, 0.12), inset 0 0 0 1px rgba(255, 213, 109, 0.25); }
.preset-card.selected .preset-title { color: #ffe2a3; }
.preset-title { font-size: 13px; font-weight: 600; color: #e6e6e6; }
.preset-desc { font-size: 11px; color: #999; line-height: 1.45; }

.radio-row { display: grid; grid-template-columns: 18px 1fr; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: background .15s, border-color .15s; margin: 4px 0; }
.radio-row:hover { background: #1f1f1f; border-color: #333; }
.radio-row input[type="radio"] { margin-top: 2px; accent-color: var(--accent); }
.radio-row:has(input[type="radio"]:checked) { background: #1f1d12; border-color: rgba(255, 213, 109, 0.4); }
.radio-row:has(input[type="radio"]:checked) .radio-label strong { color: #ffe2a3; }
.radio-label { display: flex; flex-direction: column; gap: 3px; }
.radio-label strong { font-size: 13px; color: #e6e6e6; font-weight: 600; }
.radio-desc { font-size: 11px; color: #999; line-height: 1.45; }
.creds-fields { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #333; }
.stored-note { font-size: 12px; color: #9ad8a3; background: #1d2a1f; border: 1px solid #2a4a30; padding: 8px 10px; border-radius: 6px; margin: 0 0 12px; }
.verify-row { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.verify-ok { color: #6ad08c; font-size: 12px; }
.verify-fail { color: #ff8a8a; font-size: 12px; }

.git-remote-info { background: #17170f; border: 1px solid #2a2a1a; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; }
.remote-label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
.remote-url { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.remote-url code { color: #d6d6d6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.tag { font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
.tag.ok { background: rgba(88, 190, 105, 0.15); color: #6ad08c; }
.tag.warn { background: rgba(230, 175, 75, 0.15); color: #ffb663; }

.bucket-combo { position: relative; }
.bucket-input { width: 100%; }
.bucket-list { position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 100002; margin: 0; padding: 4px; list-style: none; max-height: 200px; overflow-y: auto; background: #232323; border: 1px solid #4a4a4a; border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55); }
.bucket-opt { padding: 6px 9px; border-radius: 4px; cursor: pointer; font-size: 13px; color: #d6d6d6; }
.bucket-opt.active, .bucket-opt:hover { background: var(--accent-soft, #2a2418); color: #fff; }
.bucket-hint { font-size: 11px; color: #777; }

/* Footer FIXED (no sticky) — pegado al bottom del viewport, ancho igual al
   `.settings-page`, y el contenido del body reserva 160px de padding-bottom.
   Con sticky el footer participaba del flow y su margen impedía scrollear
   hasta ver el último input; con fixed queda fuera del flow y jamás tapa. */
.page-footer {
  position: fixed; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; gap: 10px;
  padding: 16px 24px; border-top: 1px solid #2a2a2a;
  background: rgba(15, 15, 15, 0.92);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  z-index: 50;
}
/* Contenido del footer alineado a la caja de 800px del body para que los
   botones no queden pegados a los bordes del viewport en pantallas anchas. */
.page-footer > * { max-width: none; }
.page-footer::before, .page-footer::after { content: ''; flex: 1 1 auto; }
.page-footer::before { max-width: calc((100% - 800px) / 2); }
.page-footer::after { max-width: calc((100% - 800px) / 2); }
.page-footer .spacer { flex: 1; }
.danger-btn { padding: 9px 16px; border: 1px solid #7a3030; background: #22161a; color: #ffb0b0; border-radius: 8px; cursor: pointer; }
.danger-btn:hover { background: #5a2020; }
.ghost-btn { padding: 9px 16px; border: 1px solid #444; background: #1a1a1a; color: #ddd; border-radius: 8px; cursor: pointer; }
.ghost-btn:hover { background: #222; }
.primary-btn { padding: 9px 22px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); border-radius: 8px; cursor: pointer; font-weight: 600; }
.primary-btn:hover:not(:disabled) { background: var(--accent-hover); }
.primary-btn:disabled { opacity: 0.5; cursor: default; }

/* Modales de ayuda (mismos estilos aliviados que los de ProjectSelector) */
.create-backdrop { position: fixed; inset: 0; z-index: 100001; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; padding: 24px; }
.create-dialog { width: min(480px, 92vw); max-height: 86vh; display: flex; flex-direction: column; background: #252525; border: 1px solid #3a3a3a; border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6); overflow: hidden; }
.create-dialog.wide { width: min(560px, 94vw); }
.cd-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid #333; }
.cd-head h3 { margin: 0; font-size: 16px; font-weight: 700; color: #f0f0f0; }
.cd-close { background: none; border: none; color: #999; font-size: 24px; line-height: 1; cursor: pointer; padding: 0 4px; }
.cd-body { flex: 1; overflow-y: auto; padding: 20px 24px; }
.explain-p { font-size: 13px; color: #d6d6d6; line-height: 1.55; margin: 0 0 12px; }
.explain-p strong { color: #fff; }
.explain-p code { color: #6aa9e9; background: #1a1a1a; padding: 1px 6px; border-radius: 4px; font-family: monospace; font-size: 12px; }
.explain-note { font-size: 12px; color: #888; line-height: 1.5; margin: 10px 0 0; }
.help-steps { padding-left: 18px; margin: 0 0 14px; }
.help-steps li { margin-bottom: 6px; font-size: 13px; line-height: 1.5; color: #d6d6d6; }
.help-provider { margin: 12px 0 8px; font-size: 14px; color: #e6e6e6; }
.policy-block { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; color: #d6d6d6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; white-space: pre; }
.dialog-actions { display: flex; justify-content: flex-end; padding: 16px 24px; border-top: 1px solid #333; }
</style>
