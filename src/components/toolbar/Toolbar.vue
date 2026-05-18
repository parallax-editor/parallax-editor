<script setup lang="ts">
import { computed } from 'vue'
import { state, isDirty, VIEWPORTS } from '../../stores/editor'

const emit = defineEmits<{
  save: []
  close: []
  'toggle-claude': []
  'toggle-git': []
}>()

const zoomPercent = computed(() => Math.round(state.canvasZoom * 100))
</script>

<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <button class="tool-btn" @click="emit('close')" title="Volver a proyectos">&larr;</button>
      <span class="project-name">{{ state.slug }}</span>
      <span v-if="isDirty" class="dirty-dot" title="Cambios sin guardar">*</span>
    </div>

    <div class="toolbar-center">
      <button :class="['tool-btn', { active: state.tool === 'select' }]" @click="state.tool = 'select'" title="Seleccionar (V)">V</button>
      <button :class="['tool-btn', { active: state.tool === 'hand' }]" @click="state.tool = 'hand'" title="Mano (H)">H</button>

      <span class="separator" />

      <button :class="['device-btn', { active: state.deviceMode === 'desktop' }]" @click="state.deviceMode = 'desktop'" title="Desktop">&#x1F4BB;</button>
      <button :class="['device-btn', { active: state.deviceMode === 'mobile' }]" @click="state.deviceMode = 'mobile'" title="Mobile">&#x1F4F1;</button>

      <span class="separator" />

      <span class="zoom-label">{{ zoomPercent }}%</span>

      <span class="separator" />

      <label class="snap-toggle">
        <input type="checkbox" v-model="state.snapToGrid" />
        Grid
      </label>
    </div>

    <div class="toolbar-right">
      <button class="tool-btn" @click="emit('toggle-claude')" title="Preguntarle a Claude">Claude</button>
      <button class="tool-btn" @click="emit('toggle-git')" title="Git / Publicar">Git</button>
      <button class="save-btn" @click="emit('save')" :disabled="!isDirty" title="Guardar (Cmd+S)">Guardar</button>
    </div>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 12px; background: #252525; border-bottom: 1px solid #333; font-size: 13px; flex-shrink: 0; }
.toolbar-left, .toolbar-center, .toolbar-right { display: flex; align-items: center; gap: 8px; }
.project-name { font-weight: 600; }
.dirty-dot { color: #f90; font-size: 18px; }
.tool-btn { background: #333; border: 1px solid #444; color: #ccc; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
.tool-btn:hover { background: #444; }
.tool-btn.active { background: #0066cc; border-color: #0066cc; color: #fff; }
.device-btn { background: none; border: none; font-size: 16px; cursor: pointer; opacity: 0.5; padding: 2px 4px; }
.device-btn.active { opacity: 1; }
.separator { width: 1px; height: 20px; background: #444; }
.zoom-label { color: #888; font-family: monospace; min-width: 40px; text-align: center; }
.snap-toggle { display: flex; align-items: center; gap: 4px; color: #888; cursor: pointer; font-size: 12px; }
.snap-toggle input { accent-color: #0066cc; }
.save-btn { background: #0066cc; border: none; color: #fff; padding: 4px 14px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; }
.save-btn:disabled { opacity: 0.4; cursor: default; }
</style>
