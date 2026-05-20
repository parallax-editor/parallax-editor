<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { gitApi } from '../../composables/useApi'
import { state } from '../../stores/editor'
import { validateSite } from 'parallax-engine/schema'

// EditorView owns loadProject(); after a revert (history rewrite of the
// content repo) we ask it to reload so the canvas reflects the reverted file.
const emit = defineEmits<{ reload: [] }>()

const log = ref<{ hash: string; message: string; date: string }[]>([])
const loading = ref(false)
const reverting = ref('')
const pushResult = ref('')
// Hard schema errors that BLOCK a publish (GAP7 / PLAN §9/§14). Shown in the
// panel in Spanish; the push only proceeds once the site is valid.
const validationErrors = ref<string[]>([])

async function loadLog() {
  if (!state.projectType) return
  log.value = await gitApi.log(state.projectType)
}

// Refresh the log whenever a save/commit happened (store nonce bumped in
// EditorView.save) so the history isn't stale after autosave/manual save.
watch(() => state.gitLogNonce, loadLog)

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
  loadLog()
}

async function revertTo(hash: string) {
  if (!state.projectType || reverting.value) return
  if (!confirm('¿Revertir a este punto? Se perderán los cambios posteriores.')) return
  reverting.value = hash
  pushResult.value = ''
  try {
    const r = await gitApi.revert(state.projectType, hash)
    pushResult.value = r.result || 'Revertido'
  } catch (e: any) {
    pushResult.value = `Error: ${e.message}`
  }
  reverting.value = ''
  await loadLog()
  // Reload the project so the canvas shows the reverted site.json.
  emit('reload')
}

onMounted(loadLog)
</script>

<template>
  <div class="git-panel" data-test="git-panel">
    <div class="git-header">
      <span class="git-title">Historial</span>
      <button class="publish-btn" data-test="git-publish" @click="publish" :disabled="loading">
        {{ loading ? 'Publicando...' : 'Publicar' }}
      </button>
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

    <div class="git-log">
      <div v-for="entry in log" :key="entry.hash" class="log-entry" data-test="git-log-entry">
        <span class="log-hash">{{ entry.hash?.slice(0, 7) }}</span>
        <span class="log-msg" :title="entry.message">{{ entry.message }}</span>
        <button
          class="revert-btn"
          data-test="git-revert"
          :disabled="!!reverting"
          @click="revertTo(entry.hash)"
          title="Revertir a este punto"
        >
          {{ reverting === entry.hash ? '...' : 'Revertir' }}
        </button>
      </div>
      <div v-if="log.length === 0" class="empty">Sin commits</div>
    </div>
  </div>
</template>

<style scoped>
.git-panel { padding: 12px; }
.git-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.git-title { font-weight: 600; font-size: 13px; }
.publish-btn { background: #2ea043; border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; }
.publish-btn:disabled { opacity: 0.5; }
.validation-block { background: #2a1414; border: 1px solid #6b2020; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
.vb-title { color: #f88; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.vb-list { margin: 0; padding-left: 16px; max-height: 90px; overflow-y: auto; }
.vb-list li { color: #e7a; font-size: 11px; line-height: 1.5; }
.vb-hint { color: #b88; font-size: 11px; margin-top: 4px; }
.push-result { font-size: 11px; color: #f90; margin-bottom: 8px; white-space: pre-wrap; }
.git-log { max-height: 130px; overflow-y: auto; }
.log-entry { display: flex; gap: 8px; align-items: center; padding: 3px 0; font-size: 12px; }
.log-hash { color: var(--accent-strong); font-family: monospace; flex-shrink: 0; }
.log-msg { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.revert-btn { background: #3a3a3a; border: 1px solid #555; color: #ddd; font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer; flex-shrink: 0; }
.revert-btn:hover { background: #5a2a2a; border-color: #844; color: #fff; }
.revert-btn:disabled { opacity: 0.5; cursor: default; }
.empty { color: #666; font-size: 12px; }
</style>
