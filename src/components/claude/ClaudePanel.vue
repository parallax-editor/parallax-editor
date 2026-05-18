<script setup lang="ts">
import { ref } from 'vue'
import { claudeApi } from '../../composables/useApi'
import { state } from '../../stores/editor'

const emit = defineEmits<{ reload: [] }>()
const prompt = ref('')
const output = ref('')
const loading = ref(false)
const error = ref('')

async function askClaude() {
  if (!prompt.value.trim() || !state.projectType || !state.slug) return
  loading.value = true
  error.value = ''
  output.value = ''

  const repoBase = state.projectType === 'eventos'
    ? '../daniela-reyes-eventos'
    : '../daniela-reyes-site'

  const result = await claudeApi.run(
    `${prompt.value.trim()} (archivo: content/${state.slug}/site.json)`,
    repoBase,
  )

  loading.value = false
  if (result.error) {
    error.value = result.error
  }
  output.value = result.output || ''

  // Reload the site since Claude may have modified the file
  emit('reload')
}
</script>

<template>
  <div class="claude-panel">
    <div class="claude-input">
      <input
        v-model="prompt"
        placeholder="Pedile algo a Claude... (ej: 'haz el fondo mas oscuro')"
        @keydown.enter="askClaude"
        :disabled="loading"
      />
      <button @click="askClaude" :disabled="loading || !prompt.trim()">
        {{ loading ? '...' : 'Enviar' }}
      </button>
    </div>
    <div v-if="loading" class="claude-loading">Claude esta trabajando...</div>
    <div v-if="error" class="claude-error">{{ error }}</div>
    <pre v-if="output" class="claude-output">{{ output }}</pre>
  </div>
</template>

<style scoped>
.claude-panel { padding: 12px; }
.claude-input { display: flex; gap: 8px; }
.claude-input input { flex: 1; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; color: #e0e0e0; padding: 8px 12px; font-size: 13px; }
.claude-input button { background: #0066cc; border: none; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; white-space: nowrap; }
.claude-input button:disabled { opacity: 0.5; }
.claude-loading { color: #f90; font-size: 12px; margin-top: 8px; }
.claude-error { color: #f66; font-size: 12px; margin-top: 8px; }
.claude-output { background: #111; padding: 8px; border-radius: 4px; font-size: 11px; color: #aaa; margin-top: 8px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; }
</style>
