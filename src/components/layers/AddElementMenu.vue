<script setup lang="ts">
import { addElement, resolveAddElementLayerPath, type ElementKind } from '../../stores/editor'

const emit = defineEmits<{ close: [] }>()

interface TypeOption {
  kind: ElementKind
  label: string
  icon: string
  hint: string
}

// UI types map to schema element types: texto→text, imagen→png,
// video→video, audio→audio, formulario→component/FormBlock.
const TYPES: TypeOption[] = [
  { kind: 'text', label: 'Texto', icon: 'T', hint: 'Título o párrafo' },
  { kind: 'png', label: 'Imagen', icon: '\u{1F5BC}', hint: 'PNG / imagen' },
  { kind: 'video', label: 'Video', icon: '\u{25B6}', hint: 'Clip de video' },
  { kind: 'audio', label: 'Audio', icon: '\u{1F50A}', hint: 'Pista de audio' },
  { kind: 'form', label: 'Formulario', icon: '\u{1F4DD}', hint: 'Formulario / RSVP' },
]

function pick(kind: ElementKind) {
  const layerPath = resolveAddElementLayerPath()
  if (!layerPath) return
  addElement(layerPath, kind)
  emit('close')
}
</script>

<template>
  <div class="add-element-menu">
    <div class="aem-header">
      <span>Agregar elemento</span>
      <button class="aem-close" @click="emit('close')" aria-label="Cerrar">&times;</button>
    </div>
    <div class="aem-list">
      <button
        v-for="t in TYPES"
        :key="t.kind"
        class="aem-item"
        :data-test="`add-element-${t.kind}`"
        @click="pick(t.kind)"
        :aria-label="`Agregar ${t.label}`"
      >
        <span class="aem-icon" v-html="t.icon" />
        <span class="aem-text">
          <span class="aem-label">{{ t.label }}</span>
          <span class="aem-hint">{{ t.hint }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.add-element-menu {
  position: absolute;
  top: 0;
  left: 0;
  width: 220px;
  height: 100%;
  background: #232323;
  border-right: 1px solid #333;
  z-index: 50;
  display: flex;
  flex-direction: column;
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.4);
}
.aem-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  border-bottom: 1px solid #333;
}
.aem-close {
  background: none;
  border: none;
  color: #888;
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.aem-close:hover { color: #fff; }
.aem-list { padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.aem-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  color: #ddd;
  cursor: pointer;
  text-align: left;
}
.aem-item:hover { background: #0066cc; border-color: #0066cc; color: #fff; }
.aem-icon { font-size: 18px; width: 24px; text-align: center; }
.aem-text { display: flex; flex-direction: column; }
.aem-label { font-size: 13px; font-weight: 600; }
.aem-hint { font-size: 11px; opacity: 0.6; }
</style>
