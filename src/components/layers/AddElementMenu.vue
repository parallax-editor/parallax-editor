<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  addElement,
  addCustomComponent,
  resolveAddElementLayerPath,
  customComponents,
  type ElementKind,
} from '../../stores/editor'

const { t } = useI18n()

const emit = defineEmits<{ close: [] }>()

interface TypeOption {
  kind: ElementKind
  label: string
  icon: string
  hint: string
}

// UI types map to schema element types: texto→text, imagen→png,
// video→video, audio→audio, formulario→component/FormBlock. Labels and hints
// are pulled from i18n so they re-evaluate when the locale changes.
const TYPES = computed<TypeOption[]>(() => [
  { kind: 'text', label: t('layers.typeText'), icon: 'T', hint: t('layers.typeTextHint') },
  { kind: 'png', label: t('layers.typeImage'), icon: '\u{1F5BC}', hint: t('layers.typeImageHint') },
  { kind: 'gif', label: t('layers.typeGif'), icon: '\u{1F39E}', hint: t('layers.typeGifHint') },
  { kind: 'video', label: t('layers.typeVideo'), icon: '\u{25B6}', hint: t('layers.typeVideoHint') },
  { kind: 'audio', label: t('layers.typeAudio'), icon: '\u{1F50A}', hint: t('layers.typeAudioHint') },
  { kind: 'form', label: t('layers.typeForm'), icon: '\u{1F4DD}', hint: t('layers.typeFormHint') },
])

function pick(kind: ElementKind) {
  const layerPath = resolveAddElementLayerPath()
  if (!layerPath) return
  addElement(layerPath, kind)
  emit('close')
}

// Custom components registered for this project (parallax.config.ts in the
// neighbor repo). Empty on `eventos` (built-ins only) → the group is hidden.
// FormBlock keeps its dedicated "Formulario" path above (filtered out of
// customComponents in the store).
function pickComponent(name: string) {
  const layerPath = resolveAddElementLayerPath()
  if (!layerPath) return
  addCustomComponent(layerPath, name)
  emit('close')
}
</script>

<template>
  <div class="add-element-menu">
    <div class="aem-header">
      <span>{{ t('layers.addElementMenuTitle') }}</span>
      <button class="aem-close" @click="emit('close')" :aria-label="t('common.close')">&times;</button>
    </div>
    <div class="aem-list">
      <button
        v-for="opt in TYPES"
        :key="opt.kind"
        class="aem-item"
        :data-test="`add-element-${opt.kind}`"
        @click="pick(opt.kind)"
        :aria-label="t('layers.addNamed', { name: opt.label })"
      >
        <span class="aem-icon" v-html="opt.icon" />
        <span class="aem-text">
          <span class="aem-label">{{ opt.label }}</span>
          <span class="aem-hint">{{ opt.hint }}</span>
        </span>
      </button>

      <!-- Custom components registered via the neighbor repo's
           parallax.config.ts (GAP1 / PLAN §13). Hidden when none are
           registered for this project type (e.g. eventos). -->
      <template v-if="customComponents.length">
        <div class="aem-group-title" data-test="add-element-components-group">
          {{ t('layers.customComponentsGroup') }}
        </div>
        <button
          v-for="c in customComponents"
          :key="c.name"
          class="aem-item"
          :data-test="`add-element-component-${c.name}`"
          @click="pickComponent(c.name)"
          :aria-label="t('layers.addNamed', { name: c.label })"
        >
          <span class="aem-icon">&#x1F9E9;</span>
          <span class="aem-text">
            <span class="aem-label">{{ c.label }}</span>
            <span class="aem-hint">{{ c.description || c.name }}</span>
          </span>
        </button>
      </template>
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
.aem-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  min-height: 0;
}
.aem-group-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #777;
  padding: 10px 4px 2px;
  border-top: 1px solid #333;
  margin-top: 4px;
}
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
.aem-item:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.aem-icon { font-size: 18px; width: 24px; text-align: center; }
.aem-text { display: flex; flex-direction: column; min-width: 0; }
.aem-label { font-size: 13px; font-weight: 600; }
.aem-hint {
  font-size: 11px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
