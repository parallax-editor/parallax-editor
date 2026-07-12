<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { nextTick } from 'vue'
import {
  state,
  isDirty,
  zoomIn,
  zoomOut,
  zoomToFit,
  isIndependent,
  enableIndependentViews,
  setOverview,
  consumePreOverviewScroll,
  setAutosave,
  setFreezeAnims,
  restartPreview,
} from '../../stores/editor'
import { openLivePreview } from '../../composables/useLivePreview'
import { claudeApi, gitApi } from '../../composables/useApi'
import { useDialog } from '../../composables/useDialog'
import { useI18n } from 'vue-i18n'
// Publish-readiness (Bloque B): calcula si el botón Publicar debería estar
// disabled porque faltan credenciales configuradas para el workspace activo.
// El resultado del composable es reactivo — se refresca al cambiar de
// workspace o al volver de la pantalla de settings.
import { usePublishReadiness } from '../../composables/usePublishReadiness'
import { activeWorkspace } from '../../stores/workspaces'
import { useRouter } from 'vue-router'

const dialog = useDialog()
const { t } = useI18n()
import MobileSizeControl from './MobileSizeControl.vue'
import GridGuidesControl from './GridGuidesControl.vue'

// ── Claude button availability ───────────────────────────────────────────────
// The "Claude" button is only usable when the `claude` CLI is installed on this
// machine. We fetch the server-cached status once on mount; while unknown the
// button stays enabled (optimistic, current behavior), and is disabled only if
// the server reports it's missing (with a clear Spanish tooltip).
const claudeAvailable = ref(true)
const claudeTitle = computed(() =>
  claudeAvailable.value ? t('toolbar.askClaude') : t('toolbar.claudeUnavailable'),
)

// ── Publicar (git) button state ──────────────────────────────────────────────
// Comportamiento actualizado (v0.2.0):
//   • Si el workspace declaró credenciales explícitas Y no hay secreto guardado
//     en el Keychain → el botón se DESHABILITA con tooltip diagnóstico y click
//     lleva a /workspace/:id/settings?tab=s3 (o git). Bloqueo temprano — evita
//     que el panel Publicar se abra en vano y confunda.
//   • Si todo está OK, el botón sigue abriendo el panel normalmente.
// Antes se abría siempre y el usuario descubría el error DESPUÉS de pulsar.
const gitAhead = ref(0)
const router = useRouter()
const publishReady = usePublishReadiness()
const publishTitle = computed(() => {
  if (publishReady.blockedReason.value) return publishReady.blockedReason.value
  return gitAhead.value > 0
    ? `Ver commits y publicar (${gitAhead.value} pendiente${gitAhead.value === 1 ? '' : 's'})`
    : 'Ver commits y la última publicación'
})
function onPublishClick() {
  if (publishReady.blockedReason.value) {
    const ws = activeWorkspace.value
    if (ws) router.push(`/workspace/${ws.id}/settings?tab=${publishReady.suggestedTab.value}`)
    return
  }
  emit('toggle-git')
}

async function refreshGitStatus() {
  if (!state.projectType) return
  try {
    // Scope by slug so the toolbar "Publicar (N)" badge counts only commits
    // that touched the open site, matching what the GitPanel lists.
    const s = await gitApi.status(state.projectType, state.slug || undefined)
    gitAhead.value = s?.ahead || 0
  } catch {
    gitAhead.value = 0
  }
}

onMounted(async () => {
  try {
    const s = await claudeApi.status()
    claudeAvailable.value = !!s?.available
  } catch {
    // Status endpoint unreachable → leave the button enabled (optimistic).
    claudeAvailable.value = true
  }
  refreshGitStatus()
})

// Refresh the publish state after each save/commit (nonce bumped on save).
watch(() => state.gitLogNonce, refreshGitStatus)

const emit = defineEmits<{
  save: []
  close: []
  'toggle-claude': []
  'toggle-git': []
}>()

function onToggleFreezeAnims(e: Event) {
  setFreezeAnims((e.target as HTMLInputElement).checked)
}
function onToggleAutosave(e: Event) {
  setAutosave((e.target as HTMLInputElement).checked)
}

// Grid / guías ahora viven en su propio popover (GridGuidesControl), que
// muta el store y persiste cada cambio.

const zoomPercent = computed(() => Math.round(state.canvasZoom * 100))

function fit() {
  const canvas = document.querySelector('.editor-canvas') as HTMLElement | null
  zoomToFit(canvas?.clientWidth || 0, canvas?.clientHeight || 0)
}

// "Vista completa" toggle. The store owns the snapshot/fit/restore math; the
// toolbar just supplies the live DOM measurements (canvas size + the inner
// scroller's painted height & current scroll) since only the DOM knows how the
// engine's `vh` sections actually resolved. Restoring the inner scroll on exit
// is best-effort and done after the frame shrinks back (nextTick).
async function onToggleOverview(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  const canvas = document.querySelector('.editor-canvas') as HTMLElement | null
  const scroller = document.querySelector('.preview-scroll') as HTMLElement | null
  const cw = canvas?.clientWidth || 0
  const ch = canvas?.clientHeight || 0
  if (on) {
    setOverview(true, cw, ch, {
      measuredHeight: scroller?.scrollHeight || 0,
      scrollTop: scroller?.scrollTop || 0,
      scrollLeft: scroller?.scrollLeft || 0,
    })
  } else {
    // disableOverview restores zoom/pan and keeps the saved inner-scroll in
    // state.preOverview until consumed; apply it once the artboard is back to
    // its device size and the scroller can take the offset again.
    setOverview(false, cw, ch)
    await nextTick()
    const snap = consumePreOverviewScroll()
    const sc = document.querySelector('.preview-scroll') as HTMLElement | null
    if (snap && sc) {
      sc.scrollTop = snap.scrollTop
      sc.scrollLeft = snap.scrollLeft
    }
  }
}

// ── Vista en vivo ───────────────────────────────────────────────────────────
// Opens a NEW SAME-ORIGIN tab (the editor's own /live route on :3000) that
// renders the REAL engine <ParallaxSite> of the CURRENT project — INCLUDING
// unsaved in-memory changes — at full screen with NO editor chrome and NO
// save/commit. Zero dependency on the eventos/site dev servers: the doc is
// handed over tab→tab (localStorage snapshot for first paint + per-project
// BroadcastChannel for live updates) and assets come from the editor's own
// /content route. See composables/useLivePreview.ts + views/LivePreview.vue.
const livePreviewEnabled = computed(
  () => !!state.projectType && !!state.slug,
)

const livePreviewTitle = computed(() =>
  livePreviewEnabled.value
    ? 'Abre una demo en vivo del proyecto actual en una pestaña nueva, a ' +
      'pantalla completa — incluye los cambios sin guardar. No necesitas ' +
      'guardar ni publicar.'
    : 'Abre un proyecto para ver la vista en vivo',
)

function onOpenLivePreview() {
  openLivePreview()
}

async function onEnableIndependent() {
  if (isIndependent.value) return
  const ok = await dialog.confirm({
    title: t('splitDevicesDialog.title'),
    message: t('splitDevicesDialog.message'),
    confirmText: 'Continuar',
  })
  if (ok) enableIndependentViews()
}
</script>

<template>
  <div class="toolbar">
    <!-- Row 1 — identidad + acciones -->
    <div class="toolbar-row toolbar-row-top">
      <div class="row-group identity">
        <button class="tool-btn" @click="emit('close')" :title="t('toolbar.backToProjects')">&larr;</button>
        <span class="project-name">{{ state.slug }}</span>
        <span v-if="isDirty" class="dirty-dot" :title="t('toolbar.unsavedDot')">*</span>
      </div>

      <div class="row-group actions">
        <button
          class="live-btn"
          data-test="live-preview"
          :disabled="!livePreviewEnabled"
          :title="livePreviewTitle"
          :aria-label="t('toolbar.livePreviewAria')"
          @click="onOpenLivePreview"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="live-label">{{ t('toolbar.livePreview') }}</span>
        </button>
        <button
          class="tool-btn"
          data-test="toggle-claude"
          @click="emit('toggle-claude')"
          :disabled="!claudeAvailable"
          :title="claudeTitle"
        >Claude</button>
        <button
          class="tool-btn"
          :class="{ 'publish-blocked': publishReady.blockedReason.value }"
          data-test="toggle-git"
          @click="onPublishClick"
          :title="publishTitle"
        >{{ t('toolbar.publish') }}{{ publishReady.blockedReason.value ? ' 🔒' : (gitAhead > 0 ? ` (${gitAhead})` : '') }}</button>
        <button class="save-btn" data-test="save" @click="emit('save')" :disabled="!isDirty" :title="t('toolbar.save') + ' (Cmd+S)'">{{ t('toolbar.save') }}</button>
      </div>
    </div>

    <!-- Row 2 — herramientas del lienzo -->
    <div class="toolbar-row toolbar-row-tools">
      <div class="row-group">
        <button
          :class="['tool-btn', 'icon-btn', { active: state.tool === 'select' }]"
          @click="state.tool = 'select'"
          :title="t('toolbar.toolSelect')"
          :aria-label="t('toolbar.toolSelect')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M5 3l13 7-5.5 1.5L9.5 18 5 3z"
              fill="currentColor"
              stroke="currentColor"
              stroke-width="1"
              stroke-linejoin="round"
            />
          </svg>
          <span class="tool-label">{{ t('toolbar.selectLabel') }}</span>
        </button>
        <button
          :class="['tool-btn', 'icon-btn', { active: state.tool === 'hand' }]"
          @click="state.tool = 'hand'"
          :title="t('toolbar.toolHand')"
          :aria-label="t('toolbar.toolHand')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M8 11V5.5a1.5 1.5 0 0 1 3 0V10m0 0V4.5a1.5 1.5 0 0 1 3 0V10m0 0V5.5a1.5 1.5 0 0 1 3 0V13m0-2.5a1.5 1.5 0 0 1 3 0V16a6 6 0 0 1-6 6h-2a6 6 0 0 1-5.3-3.2l-2.4-4.4a1.6 1.6 0 0 1 2.7-1.7L8 13.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="tool-label">{{ t('toolbar.handLabel') }}</span>
        </button>
      </div>

      <span class="separator" />

      <div class="row-group">
        <button
          :class="['device-btn', { active: state.deviceMode === 'desktop' }]"
          @click="state.deviceMode = 'desktop'"
          :title="isIndependent ? t('toolbar.editDesktopTitle') : t('toolbar.desktop')"
          data-test="device-desktop"
        >&#x1F4BB;</button>
        <button
          :class="['device-btn', { active: state.deviceMode === 'mobile' }]"
          @click="state.deviceMode = 'mobile'"
          :title="isIndependent ? t('toolbar.editMobileTitle') : t('toolbar.mobile')"
          data-test="device-mobile"
        >&#x1F4F1;</button>

        <!-- Tamaño del lienzo móvil configurable (#90). Solo afecta a móvil;
             se habilita cuando el dispositivo activo es Móvil. -->
        <MobileSizeControl :disabled="state.deviceMode !== 'mobile'" />

        <!-- Mode + active-view indicator. Compartido = one shared tree (legacy);
             Independiente = two separate trees, the device toggle picks which
             one you edit. -->
        <span
          v-if="isIndependent"
          class="view-badge view-badge-indep"
          data-test="view-mode-indicator"
          :data-active-view="state.deviceMode"
          :title="`${t('toolbar.independentBadge')} — ${state.deviceMode === 'mobile' ? t('toolbar.mobile') : t('toolbar.desktop')}`"
        >{{ t('toolbar.independentBadge') }} · {{ state.deviceMode === 'mobile' ? t('toolbar.mobile') : t('toolbar.desktop') }}</span>
        <button
          v-else
          class="view-badge view-badge-shared"
          data-test="enable-independent-views"
          :title="t('toolbar.splitDevicesTitle')"
          @click="onEnableIndependent"
        >{{ t('toolbar.sharedBadge') }}</button>
      </div>

      <span class="separator" />

      <div class="row-group">
        <div class="zoom-control">
          <button class="zoom-btn" @click="zoomOut" :title="t('toolbar.zoomOut')" :aria-label="t('toolbar.zoomOutAria')">&minus;</button>
          <button class="zoom-label" @click="fit" :title="t('toolbar.zoomFit')" :aria-label="t('toolbar.zoomFitAria')">{{ zoomPercent }}%</button>
          <button class="zoom-btn" @click="zoomIn" :title="t('toolbar.zoomIn')" :aria-label="t('toolbar.zoomInAria')">+</button>
        </div>
      </div>

      <span class="separator" />

      <div class="row-group">
        <div class="mode-toggle" role="group" :aria-label="t('toolbar.viewModeAria')">
          <button
            :class="['mode-btn', { active: state.previewMode === 'edit' }]"
            @click="state.previewMode = 'edit'"
            :title="t('toolbar.editModeTitle')"
          >{{ t('toolbar.editMode') }}</button>
          <button
            :class="['mode-btn', { active: state.previewMode === 'preview' }]"
            @click="state.previewMode = 'preview'"
            :title="t('toolbar.previewModeTitle')"
          >{{ t('toolbar.previewMode') }}</button>
        </div>

        <button
          class="restart-btn"
          @click="restartPreview"
          :title="t('toolbar.restartAnimations')"
          :aria-label="t('toolbar.restartAnimations')"
          data-test="preview-restart"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path
              d="M20 11a8 8 0 1 0-.6 3M20 5v6h-6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <span class="separator" />

      <div class="row-group">
        <label
          class="snap-toggle"
          :title="t('toolbar.overviewTitle')"
        >
          <input
            type="checkbox"
            :checked="state.overviewMode"
            @change="onToggleOverview"
            data-test="overview-toggle"
          />
          {{ t('toolbar.overview') }}
        </label>

        <label
          v-if="state.previewMode === 'edit'"
          class="snap-toggle"
          :title="t('toolbar.freezeAnimsTitle')"
        >
          <input
            type="checkbox"
            :checked="state.freezeAnims"
            @change="onToggleFreezeAnims"
            data-test="freeze-anims-toggle"
          />
          {{ t('toolbar.freezeAnims') }}
        </label>

        <GridGuidesControl />

        <label
          class="snap-toggle"
          :title="t('toolbar.autosaveTitle')"
        >
          <input
            type="checkbox"
            :checked="state.autosave"
            @change="onToggleAutosave"
            data-test="autosave-toggle"
          />
          {{ t('toolbar.autosave') }}
        </label>
        <span
          v-if="state.autosave && state.autosaveStatus !== 'idle'"
          class="autosave-status"
          :data-state="state.autosaveStatus"
          data-test="autosave-status"
        >{{ state.autosaveStatus === 'saving' ? t('toolbar.saving') : t('toolbar.saved') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Two-row toolbar: Row 1 = identidad + acciones, Row 2 = herramientas. The
   editor layout is a flex column, so a taller toolbar is fine. */
/* position+z-index so toolbar dropdowns (size menu, etc.) paint ABOVE the
   canvas and its guides/selection overlay (a later sibling that would otherwise
   cover a dropdown opening down into the canvas — Image #65). */
.toolbar { display: flex; flex-direction: column; background: #252525; border-bottom: 1px solid #333; font-size: 13px; flex-shrink: 0; position: relative; z-index: 100; }
.toolbar-row { display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 40px; }
.toolbar-row-top { justify-content: space-between; border-bottom: 1px solid #2f2f2f; }
.toolbar-row-tools { flex-wrap: wrap; padding-top: 6px; padding-bottom: 6px; row-gap: 6px; }
.row-group { display: flex; align-items: center; gap: 8px; }
.row-group.actions { gap: 8px; }
.project-name { font-weight: 600; }
.dirty-dot { color: #f90; font-size: 18px; }
.tool-btn { background: #333; border: 1px solid #444; color: #ccc; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: background .12s ease, border-color .12s ease; }
.tool-btn:hover:not(:disabled) { background: #444; }
.tool-btn:disabled { opacity: 0.4; cursor: default; }
.tool-btn.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.tool-btn.active:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.tool-btn.active:active { background: var(--accent); }
.tool-btn.active:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
.icon-btn { display: inline-flex; align-items: center; gap: 6px; }
.icon-btn svg { display: block; }
.tool-label { font-size: 12px; font-weight: 600; }
.device-btn { background: none; border: none; font-size: 16px; cursor: pointer; opacity: 0.5; padding: 2px 4px; }
.device-btn.active { opacity: 1; }
.view-badge { font-size: 11px; font-weight: 600; border-radius: 4px; padding: 3px 8px; cursor: pointer; border: 1px solid #444; }
.view-badge-shared { background: #2a2a2a; color: #aaa; }
.view-badge-shared:hover { background: #383838; color: #ddd; }
.view-badge-indep { background: #6b3fa0; color: #fff; border-color: #6b3fa0; cursor: default; }
.separator { width: 1px; height: 20px; background: #444; }
.zoom-control { display: flex; align-items: center; gap: 2px; }
.zoom-btn { background: #333; border: 1px solid #444; color: #ccc; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center; }
.zoom-btn:hover { background: #444; }
.zoom-label { color: #aaa; font-family: monospace; min-width: 48px; text-align: center; background: none; border: none; cursor: pointer; padding: 4px 4px; border-radius: 4px; font-size: 12px; }
.zoom-label:hover { background: #333; color: #fff; }
.mode-toggle { display: flex; border: 1px solid #444; border-radius: 4px; overflow: hidden; }
.mode-btn { background: #333; border: none; color: #aaa; padding: 4px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
.mode-btn + .mode-btn { border-left: 1px solid #444; }
.mode-btn:hover { background: #3d3d3d; color: #ddd; }
.mode-btn.active { background: #2a7d2a; color: #fff; }
.restart-btn { background: #333; border: 1px solid #444; color: #ccc; width: 26px; height: 24px; border-radius: 4px; cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.restart-btn:hover { background: #444; color: #fff; }
.restart-btn svg { display: block; }
.live-btn { display: inline-flex; align-items: center; gap: 6px; background: #333; border: 1px solid #444; color: #ccc; height: 24px; padding: 0 10px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
.live-btn:hover:not(:disabled) { background: #444; color: #fff; }
.live-btn:disabled { opacity: 0.4; cursor: default; }
.live-btn svg { display: block; }
.live-label { font-size: 12px; font-weight: 600; }
.snap-toggle { display: flex; align-items: center; gap: 4px; color: #888; cursor: pointer; font-size: 12px; }
.snap-toggle input { accent-color: var(--accent-strong); }
.autosave-status { font-size: 11px; color: #2a7d2a; min-width: 64px; }
.autosave-status[data-state='saving'] { color: #c9a227; }
.save-btn { background: var(--accent); border: none; color: var(--accent-fg); padding: 5px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: background .12s ease; }
.save-btn:hover:not(:disabled) { background: var(--accent-hover); }
.save-btn:active:not(:disabled) { background: var(--accent); }
.save-btn:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
.save-btn:disabled { opacity: 0.4; cursor: default; }
.tool-btn.publish-blocked { opacity: 0.6; border-color: rgba(230, 175, 75, 0.5); color: #ffb663; }
.tool-btn.publish-blocked:hover { background: rgba(230, 175, 75, 0.1); }
</style>
