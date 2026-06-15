<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { gitApi, publishApi, type GitStatusCommit, type DeploySidecar } from '../../composables/useApi'
import { state } from '../../stores/editor'
import { activeWorkspace } from '../../stores/workspaces'
import { validateSite } from '@parallax-editor/parallax-engine/schema'
import { useDialog } from '../../composables/useDialog'
import { usePanelScroll } from '../../composables/usePanelScroll'
import { resolveS3Credentials } from '../../composables/useS3CredentialsResolver'
import { resolveGitCredentials } from '../../composables/useGitCredentialsResolver'
import { useI18n } from 'vue-i18n'

const dialog = useDialog()
const { t } = useI18n()
// Lenis (engine) registra un wheel NO-pasivo en window y preventDefault'ea TODO,
// así que el overflow nativo no scrollea con la rueda. usePanelScroll detiene el
// wheel en captura (sin preventDefault) para que el elemento sí scrollee. Una
// instancia para el panel y otra para el modal de diff (cada una liga 1 elemento).
const { panelScrollRef: gitScrollRef } = usePanelScroll()
const { panelScrollRef: diffScrollRef } = usePanelScroll()

const emit = defineEmits<{ close: []; reload: [] }>()

const loading = ref(false)
// Carga inicial del panel (status de git + estado de deploy). El botón Publicar
// NO se muestra hasta que esto sea true, para no ofrecer publicar con datos a
// medias (p.ej. deploy aún null haría parecer "no publicado" antes de tiempo).
const ready = ref(false)
const pushResult = ref('')
// Pending-to-push commits (ahead of origin) + last 5 commits on origin/main.
const pending = ref<GitStatusCommit[]>([])
const originRecent = ref<GitStatusCommit[]>([])
// Hard schema errors that BLOCK a publish (GAP7 / PLAN §9/§14). Shown in the
// panel in Spanish; the push only proceeds once the site is valid.
const validationErrors = ref<string[]>([])
// Fase 3: S3 deploy state read from the slug's .deploy.json sidecar.
const deploy = ref<DeploySidecar | null>(null)

// El botón Publicar DENTRO del panel se habilita solo si hay ALGO que publicar:
// commits pendientes por subir, o un sitio que aún no está en S3 (primera
// publicación). Si no hay pendientes y ya está publicado → nada que hacer →
// deshabilitado. (El botón de la barra superior siempre abre el panel.)
// git opcional: un workspace sin git no tiene historial de commits; Publicar
// solo sube a S3 (o se deshabilita si no hay S3).
const noGit = computed(() => activeWorkspace.value?.useGit === false)
const hasS3 = computed(() => !!activeWorkspace.value?.s3?.enabled)
const canPublish = computed(() => {
  if (!state.site || loading.value) return false
  if (noGit.value) return hasS3.value // sin git: publicar = subir a S3
  return pending.value.length > 0 || !deploy.value?.deployed
})

const deployLabel = computed(() => {
  if (!deploy.value?.deployed) return 'No publicado en S3'
  const d = Date.parse(deploy.value.lastDeployedAt)
  const when = Number.isFinite(d) ? new Date(d).toLocaleString('es-ES') : deploy.value.lastDeployedAt
  return `Publicado en S3 · ${when}`
})

async function loadStatus() {
  if (!state.projectType) return
  try {
    const s = await gitApi.status(state.projectType, state.slug || undefined)
    pending.value = s?.pending || []
    originRecent.value = s?.originRecent || []
  } catch {
    pending.value = []
    originRecent.value = []
  }
  await loadDeploy()
  // Status + deploy ya cargados → ahora sí se puede mostrar el botón Publicar.
  ready.value = true
}

async function loadDeploy() {
  if (!state.projectType || !state.slug) { deploy.value = null; return }
  try {
    const r = await publishApi.status(state.projectType, state.slug)
    deploy.value = r?.deploy ?? null
  } catch {
    deploy.value = null
  }
}

// Refresh whenever a save/commit happened (store nonce bumped in
// EditorView.save) so pending/remote lists aren't stale after autosave/save.
watch(() => state.gitLogNonce, loadStatus)

// Short relative date ("hace 3 h") from an ISO/git date string. Best-effort.
function relativeDate(raw: string): string {
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.round(diff / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return `hace ${d} d`
}

async function publish() {
  if (!state.projectType || loading.value) return

  // ── Pre-publish schema validation (PLAN §9/§14) ────────────────────────
  // "Si hay errores graves, el botón Publicar los muestra antes de hacer
  // push." Reuse the engine's validateSite over the CURRENT in-memory site
  // (same validator the store uses on load). Hard errors → BLOCK the push and
  // list them; nothing is pushed. A clean site proceeds (with the existing
  // confirm()).
  validationErrors.value = []
  if (!state.site) {
    validationErrors.value = ['No hay un proyecto abierto para publicar.']
    return
  }
  const result = validateSite(state.site)
  if (!result.ok) {
    validationErrors.value = result.errors.map((e) =>
      e.path ? `${e.path}: ${e.message}` : e.message,
    )
    pushResult.value = ''
    return // BLOCKED — do not push.
  }

  if (!state.slug) {
    validationErrors.value = ['No hay un proyecto abierto para publicar.']
    return
  }
  // ── Preset multi-tenant: og:image requerido para WhatsApp ─────────────────
  // Los workspaces multi-tenant se comparten exclusivamente por mensaje (WhatsApp
  // / iMessage). Sin og:image el preview sale vacío y la invitación parece rota.
  // Avisamos antes del push para que el usuario pueda agregarla, pero no
  // bloqueamos (puede querer publicar igual para iterar). El preset puede venir
  // undefined en workspaces existentes en localStorage → cae a multi-tenant.
  const preset = activeWorkspace.value?.preset || 'multi-tenant'
  if (preset === 'multi-tenant') {
    const og = state.site?.meta?.ogImage
    if (!og || !String(og).trim()) {
      const okOg = await dialog.confirm({
        title: t('workspace.publishOgImageMissingTitle'),
        message: t('workspace.publishOgImageMissingBody'),
        confirmText: t('workspace.publishOgImageMissingConfirm'),
      })
      if (!okOg) return
    }
  }
  const ok = await dialog.confirm({
    title: 'Publicar cambios',
    message: 'Publicar cambios? Esto hará git push y, si está configurado, subirá el sitio a S3.',
    confirmText: 'Publicar',
  })
  if (!ok) return
  loading.value = true
  pushResult.value = 'Publicando… (push + sincronización con S3)'
  try {
    // Hidrata las creds explícitas desde el Keychain SOLO si el workspace lo
    // pidió. En modo 'system' devuelve undefined y el server usa la cadena por
    // defecto. Si el workspace está en 'explicit' pero el secreto no se puede
    // recuperar (p.ej. el usuario nunca lo guardó), devolvemos `null` y el
    // publish dejaría que la SDK intente; mejor avisar.
    const creds = await resolveS3Credentials(state.projectType, activeWorkspace.value?.s3)
    if (activeWorkspace.value?.s3?.credentialsMode === 'explicit' && !creds) {
      pushResult.value = `Error: ${t('workspace.publishMissingStoredCreds')}`
      loading.value = false
      return
    }
    // Mismo gate para PAT: si el workspace está en authMode='pat' pero no hay
    // PAT guardado, mejor avisar antes que dejar que git pida password en una
    // terminal que el usuario no ve.
    const gitAuth = await resolveGitCredentials(state.projectType, activeWorkspace.value?.git)
    if (activeWorkspace.value?.git?.authMode === 'pat' && !gitAuth) {
      pushResult.value = `Error: ${t('workspace.publishMissingStoredGitPat')}`
      loading.value = false
      return
    }
    const r = await publishApi.run(state.projectType, state.slug, creds, gitAuth)
    if (!r.ok) {
      pushResult.value = `Error: ${r.error || 'no se pudo publicar'}`
    } else {
      const parts: string[] = []
      if (r.pushed) parts.push('Push exitoso')
      if (r.s3?.ok) parts.push(`S3: ${r.s3.uploaded ?? 0} archivos subidos, ${r.s3.deleted ?? 0} eliminados`)
      if (r.warning) parts.push(r.warning)
      pushResult.value = parts.join(' · ') || 'Publicado'
    }
  } catch (e: any) {
    pushResult.value = `Error: ${e.message}`
  }
  loading.value = false
  await loadStatus()
  // Refresh the TOOLBAR's "Publicar (N)" button too: it reads ahead-count on
  // its own and only re-fetches when gitLogNonce bumps. Without this the button
  // kept showing a pending count after a successful push until a full refresh.
  state.gitLogNonce++
}

// ─── Diff por commit (modal "ver qué se hizo commit") ──────────────────────────
const diffOpen = ref(false)
const diffLoading = ref(false)
const diffText = ref('')
const diffError = ref('')
const diffEntry = ref<GitStatusCommit | null>(null)

async function openDiff(entry: GitStatusCommit) {
  if (!state.projectType || !entry?.hash) return
  diffEntry.value = entry
  diffOpen.value = true
  diffLoading.value = true
  diffText.value = ''
  diffError.value = ''
  try {
    const r = await gitApi.show(state.projectType, entry.hash)
    if (r.ok && r.diff != null) diffText.value = r.diff
    else diffError.value = r.error || 'No se pudo obtener el diff.'
  } catch (e: any) {
    diffError.value = e?.message || 'No se pudo obtener el diff.'
  } finally {
    diffLoading.value = false
  }
}
function closeDiff() { diffOpen.value = false }

// Snapshot revert (Phase 6). Brings the entire content/<slug>/ folder to the
// state it had at <hash>. NOT a git revert — files end up in the working tree
// and the user reviews + commits with Cmd+S. Confirms before applying because
// it overwrites images/site.json/etc. for the active site (other slugs and the
// rest of the repo are untouched).
const restoring = ref(false)
const restoreNote = ref('')
async function restoreSnapshot(entry: GitStatusCommit) {
  if (!state.projectType || !state.slug || !entry?.hash) return
  if (restoring.value) return
  const short = entry.hash.slice(0, 7)
  const ok = await dialog.confirm({
    title: t('git.restoreTitle'),
    message:
      `${t('git.restoreConfirm')} (${state.slug} · ${short} · "${entry.message}")`,
    confirmText: t('git.restoreTitle'),
    cancelText: t('common.cancel'),
    danger: true,
  })
  if (!ok) return
  restoring.value = true
  restoreNote.value = ''
  try {
    const r = await gitApi.restoreSnapshot(state.projectType, entry.hash, state.slug)
    if (!r.ok) {
      restoreNote.value = r.error || t('git.restoreError')
      return
    }
    restoreNote.value = t('git.restoreSuccess', {
      restored: r.restored ?? 0,
      removed: r.removed ?? 0,
    })
    // Force the editor to reload from disk NOW. The chokidar watcher would
    // eventually broadcast `file-changed` for the restored site.json (which
    // also triggers `applyExternalChange`), but a restore can rewrite many
    // files in rapid succession and chokidar's `awaitWriteFinish` (500ms
    // stability + FS event latency) makes that path unreliable — the user
    // would see "restored OK" on the panel while the canvas kept rendering
    // the PREVIOUS site state ("el modal dice restaurado pero el editor
    // sigue igual"). Emitting reload here closes that gap: the parent fetches
    // site.json synchronously, replaces state.site, and the canvas repaints.
    // assetsNonce++ busts the URL cache for any images that the restore
    // brought back to a different version (same name, different bytes).
    state.assetsNonce++
    state.gitLogNonce++
    emit('reload')
  } catch (e: any) {
    restoreNote.value = e?.message || t('git.restoreError')
  } finally {
    restoring.value = false
  }
}

// Clasifica cada línea del `git show` para colorear el diff (+/-/hunk/meta).
const diffLines = computed(() =>
  diffText.value.split('\n').map((text) => {
    let kind = 'ctx'
    if (text.startsWith('+++') || text.startsWith('---')) kind = 'meta'
    else if (text.startsWith('+')) kind = 'add'
    else if (text.startsWith('-')) kind = 'del'
    else if (text.startsWith('@@')) kind = 'hunk'
    else if (
      /^(diff |index |commit |Author:|Date:|Binary files|new file|deleted file|rename )/.test(text)
    ) kind = 'meta'
    return { text, kind }
  }),
)

onMounted(loadStatus)
</script>

<template>
  <div class="git-panel" data-test="git-panel" :ref="gitScrollRef">
    <div class="git-header">
      <span class="git-title">{{ t('git.panelTitle') }}</span>
      <div class="git-header-actions">
        <span v-if="!ready" class="git-loading" data-test="git-loading">{{ t('common.loading') }}</span>
        <button v-else class="publish-btn" data-test="git-publish" @click="publish" :disabled="!canPublish">
          {{ loading ? t('git.publishing') : t('git.panelTitle') }}
        </button>
        <button
          class="git-close"
          data-test="git-close"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >&times;</button>
      </div>
    </div>

    <!-- S3 deploy status badge (Fase 3) -->
    <div
      class="s3-badge"
      :class="{ deployed: deploy?.deployed }"
      data-test="s3-deploy-badge"
    >
      <span class="s3-dot" :class="{ on: deploy?.deployed }" />
      {{ deployLabel }}
    </div>

    <div
      v-if="validationErrors.length"
      class="validation-block"
      data-test="git-validation-errors"
    >
      <div class="vb-title">{{ t('git.validationTitle') }}</div>
      <ul class="vb-list">
        <li v-for="(e, i) in validationErrors" :key="i">{{ e }}</li>
      </ul>
      <div class="vb-hint">{{ t('git.validationHint') }}</div>
    </div>

    <div v-if="pushResult" class="push-result" data-test="git-result">{{ pushResult }}</div>

    <!-- Workspace sin git: no hay historial de commits; Publicar solo sube a S3. -->
    <div v-if="noGit" class="nogit-note" data-test="git-nogit-note">
      {{ hasS3 ? t('git.nogitNoteWithS3') : t('git.nogitNoteWithoutS3') }}
    </div>

    <template v-if="!noGit">
    <!-- (a) Cambios locales que aún no están en el sitio publicado -->
    <div class="git-section">
      <div class="section-title">{{ t('git.pending') }}</div>
      <div class="git-log">
        <div
          v-for="entry in pending"
          :key="entry.hash"
          class="log-entry clickable"
          data-test="git-pending-entry"
          role="button"
          tabindex="0"
          :title="t('git.seeChanges')"
          @click="openDiff(entry)"
          @keydown.enter="openDiff(entry)"
        >
          <span class="log-hash">{{ entry.hash?.slice(0, 7) }}</span>
          <span class="log-msg" :title="entry.message">{{ entry.message }}</span>
          <span class="log-date">{{ relativeDate(entry.date) }}</span>
          <button
            class="restore-btn"
            data-test="git-restore-pending"
            :disabled="restoring || !state.slug"
            :title="t('git.restoreTooltip')"
            @click.stop="restoreSnapshot(entry)"
          >&#x21BA;</button>
        </div>
        <div v-if="!ready" class="empty loading-row"><span class="mini-spinner" /> {{ t('git.loading') }}</div>
        <div v-else-if="pending.length === 0" class="empty">{{ t('git.noPending') }}</div>
      </div>
    </div>

    <!-- (b) Lo último que ya está en el remoto -->
    <div class="git-section">
      <div class="section-title">{{ t('git.remote') }}</div>
      <div class="git-log">
        <div
          v-for="entry in originRecent"
          :key="entry.hash"
          class="log-entry clickable"
          data-test="git-origin-entry"
          role="button"
          tabindex="0"
          :title="t('git.seeChanges')"
          @click="openDiff(entry)"
          @keydown.enter="openDiff(entry)"
        >
          <span class="log-hash">{{ entry.hash?.slice(0, 7) }}</span>
          <span class="log-msg" :title="entry.message">{{ entry.message }}</span>
          <span class="log-date">{{ relativeDate(entry.date) }}</span>
          <button
            class="restore-btn"
            data-test="git-restore-origin"
            :disabled="restoring || !state.slug"
            :title="t('git.restoreTooltip')"
            @click.stop="restoreSnapshot(entry)"
          >&#x21BA;</button>
        </div>
        <div v-if="!ready" class="empty loading-row"><span class="mini-spinner" /> {{ t('common.loading') }}</div>
        <div v-else-if="originRecent.length === 0" class="empty">{{ t('git.noRemote') }}</div>
        <div v-if="restoreNote" class="restore-note" data-test="git-restore-note">{{ restoreNote }}</div>
      </div>
    </div>
    </template>

    <!-- Modal de diff (Teleport a <body>: dentro del panel, su position:fixed
         quedaba atrapado por el ancestro con overflow → no respetaba el viewport
         ni scrolleaba. Teleportado mide contra el viewport y el body scrollea). -->
    <Teleport to="body">
    <div
      v-if="diffOpen"
      class="diff-overlay"
      data-test="git-diff-modal"
      @click.self="closeDiff"
    >
      <div class="diff-modal" role="dialog" aria-modal="true" :aria-label="t('git.diffModalAria')">
        <div class="diff-head">
          <div class="diff-titlewrap">
            <code class="diff-hash">{{ diffEntry?.hash?.slice(0, 7) }}</code>
            <span class="diff-msg" :title="diffEntry?.message">{{ diffEntry?.message }}</span>
          </div>
          <button class="diff-close" :title="t('common.close')" :aria-label="t('common.close')" @click="closeDiff">&times;</button>
        </div>
        <div class="diff-body" :ref="diffScrollRef">
          <div v-if="diffLoading" class="diff-state">{{ t('git.diffLoading') }}</div>
          <div v-else-if="diffError" class="diff-state error">{{ diffError }}</div>
          <div v-else class="diff-pre" data-test="git-diff-content">
            <div
              v-for="(l, i) in diffLines"
              :key="i"
              class="diff-line"
              :class="l.kind"
            >{{ l.text || ' ' }}</div>
          </div>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* El panel ocupa la altura del bottom-panel y hace scroll interno (antes no
   tenía altura ni overflow → se desbordaba y el scroll no servía). */
.git-panel { padding: 12px; height: 100%; box-sizing: border-box; overflow-y: auto; overflow-x: hidden; }
/* Header pegado arriba para que "Publicar" no se vaya con el scroll. */
.git-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; position: sticky; top: -12px; padding-top: 4px; background: #1e1e1e; z-index: 2; }
.git-title { font-weight: 600; font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Acciones nunca se encogen → el botón "Publicar" no se corta. */
.git-header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.git-close {
  background: none; border: none; color: #999; font-size: 20px; line-height: 1;
  cursor: pointer; padding: 0 4px; border-radius: 4px;
}
.git-close:hover { color: #fff; background: #ffffff14; }
.publish-btn { background: #2ea043; border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; }
.publish-btn:disabled { opacity: 0.5; cursor: default; }
.git-loading { color: #888; font-size: 12px; font-style: italic; }
.s3-badge {
  display: flex; align-items: center; gap: 7px; font-size: 11px; color: #999;
  background: #1f1f1f; border: 1px solid #333; border-radius: 6px;
  padding: 5px 9px; margin-bottom: 8px;
}
.s3-badge.deployed { color: #b6e3c0; border-color: #2c5a38; background: #16241a; }
.s3-dot { width: 7px; height: 7px; border-radius: 50%; background: #666; flex-shrink: 0; }
.s3-dot.on { background: #2ea043; }
.validation-block { background: #2a1414; border: 1px solid #6b2020; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
.vb-title { color: #f88; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.vb-list { margin: 0; padding-left: 16px; max-height: 90px; overflow-y: auto; }
.vb-list li { color: #e7a; font-size: 11px; line-height: 1.5; }
.vb-hint { color: #b88; font-size: 11px; margin-top: 4px; }
.push-result { font-size: 11px; color: #f90; margin-bottom: 8px; white-space: pre-wrap; }
.git-section { margin-bottom: 10px; }
.section-title { color: #888; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
/* Sin scroll interno propio: el panel entero scrollea (un solo scroll, no anidado). */
.git-log {}
.log-entry { display: flex; gap: 8px; align-items: center; padding: 3px 0; font-size: 12px; min-width: 0; }
.log-hash { color: var(--accent-strong); font-family: monospace; flex-shrink: 0; }
/* min-width:0 → el mensaje largo se recorta con ellipsis en vez de ensanchar
   la fila (lo que empujaba el header y cortaba el botón "Publicar"). */
.log-msg { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.log-date { color: #777; font-size: 11px; flex-shrink: 0; }
.log-entry.clickable { cursor: pointer; border-radius: 4px; padding-left: 4px; padding-right: 4px; }
.log-entry.clickable:hover { background: #2a2a2a; }
.log-entry.clickable:focus-visible { outline: 1px solid var(--accent-strong); }
/* Restaurar (snapshot revert) — tiny icon at the row's right edge, becomes
   visible on hover so it doesn't compete with the date for attention. */
.restore-btn {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  width: 22px; height: 22px;
  color: #aaa;
  font-size: 13px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.log-entry.clickable:hover .restore-btn,
.restore-btn:focus-visible { opacity: 1; }
.restore-btn:hover { background: #2f2f2f; color: #fff; border-color: var(--accent-strong); }
.restore-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.restore-note {
  margin-top: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: #d6d6d6;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
}

.empty.loading-row { display: flex; align-items: center; gap: 8px; }
.mini-spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid #3a3a3a; border-top-color: var(--accent-strong);
  display: inline-block; animation: git-spin 0.7s linear infinite; flex-shrink: 0;
}
@keyframes git-spin { to { transform: rotate(360deg); } }

/* ── Modal de diff por commit ─────────────────────────────────────────────── */
.diff-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100000;
  padding: 24px;
}
.diff-modal {
  width: min(900px, 100%);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
  border: 1px solid #3a3a3a;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.diff-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #2e2e2e;
  flex-shrink: 0; /* el header no se encoge; el body es el que scrollea */
}
.diff-titlewrap { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.diff-hash { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--accent-strong); flex-shrink: 0; }
.diff-msg { font-size: 13px; color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-close { background: none; border: none; color: #999; font-size: 22px; line-height: 1; cursor: pointer; }
.diff-close:hover { color: #fff; }
/* flex:1 + min-height:0 → el body OCUPA el espacio restante y SCROLLEA dentro
   del modal (sin min-height:0 un hijo flex no se encoge bajo su contenido y no
   aparece el scroll). */
.diff-body { flex: 1; min-height: 0; overflow: auto; padding: 0; scrollbar-color: #3a3a3a #161616; }
/* Barra de scroll oscura (acorde al tema), no la gris del SO. */
.diff-body::-webkit-scrollbar { width: 11px; height: 11px; }
.diff-body::-webkit-scrollbar-track { background: #161616; }
.diff-body::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 8px; border: 2px solid #161616; }
.diff-body::-webkit-scrollbar-thumb:hover { background: #4d4d4d; }
.nogit-note { font-size: 12px; color: #9a9a9a; background: #232323; border: 1px solid #2e2e2e; border-radius: 8px; padding: 10px 12px; margin: 8px 0; line-height: 1.5; }
.diff-state { padding: 24px; color: #9a9a9a; font-size: 13px; }
.diff-state.error { color: #ff7676; }
.diff-pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  padding: 8px 0;
}
.diff-line { white-space: pre; padding: 0 14px; }
.diff-line.add { background: rgba(52, 211, 153, 0.12); color: #8ee6b8; }
.diff-line.del { background: rgba(248, 113, 113, 0.12); color: #f3a0a0; }
.diff-line.hunk { color: #7fa8d6; }
.diff-line.meta { color: #8a8a8a; }
.diff-line.ctx { color: #c8c8c8; }
.empty { color: #666; font-size: 12px; }
</style>
