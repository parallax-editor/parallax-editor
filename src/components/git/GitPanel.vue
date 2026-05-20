<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { gitApi, type GitStatusCommit } from '../../composables/useApi'
import { state } from '../../stores/editor'
import { validateSite } from 'parallax-engine/schema'

const emit = defineEmits<{ close: [] }>()

const loading = ref(false)
const pushResult = ref('')
// Pending-to-push commits (ahead of origin) + last 5 commits on origin/main.
const pending = ref<GitStatusCommit[]>([])
const originRecent = ref<GitStatusCommit[]>([])
// Hard schema errors that BLOCK a publish (GAP7 / PLAN §9/§14). Shown in the
// panel in Spanish; the push only proceeds once the site is valid.
const validationErrors = ref<string[]>([])

const canPublish = computed(() => pending.value.length > 0 && !loading.value)

async function loadStatus() {
  if (!state.projectType) return
  try {
    const s = await gitApi.status(state.projectType)
    pending.value = s?.pending || []
    originRecent.value = s?.originRecent || []
  } catch {
    pending.value = []
    originRecent.value = []
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

  if (!confirm('Publicar cambios? Esto hara git push al repositorio remoto.')) return
  loading.value = true
  pushResult.value = ''
  try {
    const r = await gitApi.push(state.projectType)
    pushResult.value = r.result || 'Push exitoso'
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

onMounted(loadStatus)
</script>

<template>
  <div class="git-panel" data-test="git-panel">
    <div class="git-header">
      <span class="git-title">Publicar</span>
      <div class="git-header-actions">
        <button class="publish-btn" data-test="git-publish" @click="publish" :disabled="!canPublish">
          {{ loading ? 'Publicando...' : 'Publicar' }}
        </button>
        <!-- Close X: the toolbar "Publicar" button disables itself once there's
             nothing pending, so it can't toggle the panel shut — this X always can. -->
        <button
          class="git-close"
          data-test="git-close"
          title="Cerrar"
          aria-label="Cerrar"
          @click="emit('close')"
        >&times;</button>
      </div>
    </div>

    <div
      v-if="validationErrors.length"
      class="validation-block"
      data-test="git-validation-errors"
    >
      <div class="vb-title">No se puede publicar: hay errores en el proyecto</div>
      <ul class="vb-list">
        <li v-for="(e, i) in validationErrors" :key="i">{{ e }}</li>
      </ul>
      <div class="vb-hint">Corrige estos errores y vuelve a intentar.</div>
    </div>

    <div v-if="pushResult" class="push-result" data-test="git-result">{{ pushResult }}</div>

    <!-- (a) Cambios locales que aún no están en el sitio publicado -->
    <div class="git-section">
      <div class="section-title">Pendientes por publicar</div>
      <div class="git-log">
        <div
          v-for="entry in pending"
          :key="entry.hash"
          class="log-entry"
          data-test="git-pending-entry"
        >
          <span class="log-hash">{{ entry.hash?.slice(0, 7) }}</span>
          <span class="log-msg" :title="entry.message">{{ entry.message }}</span>
          <span class="log-date">{{ relativeDate(entry.date) }}</span>
        </div>
        <div v-if="pending.length === 0" class="empty">No hay cambios pendientes</div>
      </div>
    </div>

    <!-- (b) Lo último que ya está en el remoto -->
    <div class="git-section">
      <div class="section-title">En el remoto (origin/main)</div>
      <div class="git-log">
        <div
          v-for="entry in originRecent"
          :key="entry.hash"
          class="log-entry"
          data-test="git-origin-entry"
        >
          <span class="log-hash">{{ entry.hash?.slice(0, 7) }}</span>
          <span class="log-msg" :title="entry.message">{{ entry.message }}</span>
          <span class="log-date">{{ relativeDate(entry.date) }}</span>
        </div>
        <div v-if="originRecent.length === 0" class="empty">Sin información del remoto</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-panel { padding: 12px; }
.git-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.git-title { font-weight: 600; font-size: 13px; }
.git-header-actions { display: flex; align-items: center; gap: 8px; }
.git-close {
  background: none; border: none; color: #999; font-size: 20px; line-height: 1;
  cursor: pointer; padding: 0 4px; border-radius: 4px;
}
.git-close:hover { color: #fff; background: #ffffff14; }
.publish-btn { background: #2ea043; border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; }
.publish-btn:disabled { opacity: 0.5; cursor: default; }
.validation-block { background: #2a1414; border: 1px solid #6b2020; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
.vb-title { color: #f88; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.vb-list { margin: 0; padding-left: 16px; max-height: 90px; overflow-y: auto; }
.vb-list li { color: #e7a; font-size: 11px; line-height: 1.5; }
.vb-hint { color: #b88; font-size: 11px; margin-top: 4px; }
.push-result { font-size: 11px; color: #f90; margin-bottom: 8px; white-space: pre-wrap; }
.git-section { margin-bottom: 10px; }
.section-title { color: #888; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
.git-log { max-height: 110px; overflow-y: auto; }
.log-entry { display: flex; gap: 8px; align-items: center; padding: 3px 0; font-size: 12px; }
.log-hash { color: var(--accent-strong); font-family: monospace; flex-shrink: 0; }
.log-msg { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.log-date { color: #777; font-size: 11px; flex-shrink: 0; }
.empty { color: #666; font-size: 12px; }
</style>
