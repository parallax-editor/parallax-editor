<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { gitApi } from '../../composables/useApi'
import { state } from '../../stores/editor'

const log = ref<{ hash: string; message: string; date: string }[]>([])
const loading = ref(false)
const pushResult = ref('')

async function loadLog() {
  if (!state.projectType) return
  log.value = await gitApi.log(state.projectType)
}

async function publish() {
  if (!state.projectType) return
  if (!confirm('Publicar cambios? Esto hara git push al repositorio remoto.')) return
  loading.value = true
  pushResult.value = ''
  try {
    const result = await gitApi.push(state.projectType)
    pushResult.value = result.result || 'Push exitoso'
  } catch (e: any) {
    pushResult.value = `Error: ${e.message}`
  }
  loading.value = false
  loadLog()
}

onMounted(loadLog)
</script>

<template>
  <div class="git-panel">
    <div class="git-header">
      <span class="git-title">Historial</span>
      <button class="publish-btn" @click="publish" :disabled="loading">
        {{ loading ? 'Publicando...' : 'Publicar' }}
      </button>
    </div>
    <div v-if="pushResult" class="push-result">{{ pushResult }}</div>
    <div class="git-log">
      <div v-for="entry in log" :key="entry.hash" class="log-entry">
        <span class="log-hash">{{ entry.hash?.slice(0, 7) }}</span>
        <span class="log-msg">{{ entry.message }}</span>
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
.push-result { font-size: 11px; color: #f90; margin-bottom: 8px; }
.git-log { max-height: 130px; overflow-y: auto; }
.log-entry { display: flex; gap: 8px; padding: 3px 0; font-size: 12px; }
.log-hash { color: #6cb3ff; font-family: monospace; flex-shrink: 0; }
.log-msg { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: #666; font-size: 12px; }
</style>
