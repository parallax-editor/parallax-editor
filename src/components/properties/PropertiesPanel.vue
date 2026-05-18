<script setup lang="ts">
import { computed } from 'vue'
import { state, getSelected, setAtPath, getAtPath } from '../../stores/editor'
import { ANCHOR_TYPES, SCROLL_BEHAVIORS, SEMANTIC_TAGS, SPLIT_MODES, TRIGGER_TYPES, ANIMATION_TYPES, EASING_PRESETS } from 'parallax-engine/schema'
import PropField from './PropField.vue'

const selected = computed(() => getSelected())

function updateProp(propName: string, value: any) {
  if (!state.selectedPath) return
  setAtPath(`${state.selectedPath}.${propName}`, value)
}

function updateNestedProp(baseProp: string, key: string, value: any) {
  if (!state.selectedPath) return
  const current = getAtPath(`${state.selectedPath}.${baseProp}`) || {}
  setAtPath(`${state.selectedPath}.${baseProp}`, { ...current, [key]: value })
}
</script>

<template>
  <div class="properties-panel">
    <div class="panel-header">Propiedades</div>

    <div v-if="!selected" class="empty-state">
      Selecciona un elemento para editar sus propiedades
    </div>

    <div v-else class="props-content">
      <div class="prop-section-title">{{ selected.type }}</div>

      <!-- Section props -->
      <template v-if="selected.type === 'section'">
        <PropField label="ID" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField label="Altura" :modelValue="selected.data.height" @update:modelValue="updateProp('height', $event)" />
        <PropField label="Scroll" :modelValue="selected.data.scrollBehavior" type="select" :options="[...SCROLL_BEHAVIORS]" @update:modelValue="updateProp('scrollBehavior', $event)" />
      </template>

      <!-- Layer props -->
      <template v-if="selected.type === 'layer'">
        <PropField label="ID" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField label="Depth" :modelValue="selected.data.depth" type="number" :min="-1" :max="1" :step="0.1" @update:modelValue="updateProp('depth', $event)" />
        <PropField label="Blur" :modelValue="selected.data.blur" type="number" :min="0" @update:modelValue="updateProp('blur', $event)" />
        <PropField label="Opacidad" :modelValue="selected.data.opacity" type="number" :min="0" :max="1" :step="0.1" @update:modelValue="updateProp('opacity', $event)" />
        <PropField label="3D" :modelValue="selected.data.perspective3d" type="checkbox" @update:modelValue="updateProp('perspective3d', $event)" />
        <PropField label="Blend" :modelValue="selected.data.blendMode || ''" @update:modelValue="updateProp('blendMode', $event || undefined)" />
      </template>

      <!-- Element common props -->
      <template v-if="selected.type === 'element'">
        <PropField label="ID" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField label="Tipo" :modelValue="selected.data.type" type="text" />

        <div class="prop-group-title">Posicion</div>
        <PropField label="X" :modelValue="selected.data.position?.x" type="number" @update:modelValue="updateNestedProp('position', 'x', $event)" />
        <PropField label="Y" :modelValue="selected.data.position?.y" type="number" @update:modelValue="updateNestedProp('position', 'y', $event)" />

        <div class="prop-group-title">Tamano</div>
        <PropField label="Ancho" :modelValue="selected.data.size?.width" @update:modelValue="updateNestedProp('size', 'width', $event)" />
        <PropField label="Alto" :modelValue="selected.data.size?.height" @update:modelValue="updateNestedProp('size', 'height', $event)" />

        <div class="prop-group-title">Estilo</div>
        <PropField label="Anchor" :modelValue="selected.data.anchor" type="select" :options="[...ANCHOR_TYPES]" @update:modelValue="updateProp('anchor', $event)" />
        <PropField label="Opacidad" :modelValue="selected.data.opacity" type="number" :min="0" :max="1" :step="0.1" @update:modelValue="updateProp('opacity', $event)" />
        <PropField label="Rotacion" :modelValue="selected.data.rotation" type="number" @update:modelValue="updateProp('rotation', $event)" />
        <PropField label="Visible" :modelValue="selected.data.visible" type="checkbox" @update:modelValue="updateProp('visible', $event)" />
        <PropField label="Interactivo" :modelValue="selected.data.interactive" type="checkbox" @update:modelValue="updateProp('interactive', $event)" />

        <!-- Type-specific -->
        <template v-if="selected.data.type === 'png'">
          <div class="prop-group-title">PNG</div>
          <PropField label="Src" :modelValue="selected.data.src" @update:modelValue="updateProp('src', $event)" />
          <PropField label="Alt" :modelValue="selected.data.alt || ''" @update:modelValue="updateProp('alt', $event)" />
        </template>

        <template v-if="selected.data.type === 'text'">
          <div class="prop-group-title">Texto</div>
          <PropField label="Contenido" :modelValue="selected.data.content" type="textarea" @update:modelValue="updateProp('content', $event)" />
          <PropField label="Fuente" :modelValue="selected.data.font || ''" @update:modelValue="updateProp('font', $event)" />
          <PropField label="Tamano" :modelValue="selected.data.fontSize || ''" @update:modelValue="updateProp('fontSize', $event)" />
          <PropField label="Peso" :modelValue="selected.data.fontWeight || 400" type="number" @update:modelValue="updateProp('fontWeight', $event)" />
          <PropField label="Color" :modelValue="selected.data.color || '#000'" type="color" @update:modelValue="updateProp('color', $event)" />
          <PropField label="Tag" :modelValue="selected.data.semanticTag" type="select" :options="[...SEMANTIC_TAGS]" @update:modelValue="updateProp('semanticTag', $event)" />
          <PropField label="Split" :modelValue="selected.data.splitMode || 'none'" type="select" :options="[...SPLIT_MODES]" @update:modelValue="updateProp('splitMode', $event)" />
          <PropField label="Stagger" :modelValue="selected.data.staggerDelay || 0" type="number" :min="0" @update:modelValue="updateProp('staggerDelay', $event)" />
        </template>

        <!-- Link -->
        <div class="prop-group-title">Link</div>
        <PropField label="URL" :modelValue="selected.data.link?.href || ''" @update:modelValue="updateNestedProp('link', 'href', $event)" />
        <PropField label="Target" :modelValue="selected.data.link?.target || '_blank'" type="select" :options="['_blank', '_self']" @update:modelValue="updateNestedProp('link', 'target', $event)" />

        <!-- Animations summary -->
        <div class="prop-group-title">Animaciones ({{ selected.data.animations?.length || 0 }})</div>
        <div v-for="(anim, i) in (selected.data.animations || [])" :key="i" class="anim-summary">
          <span class="anim-type">{{ anim.type }}</span>
          <span class="anim-trigger">{{ anim.trigger }}</span>
          <span class="anim-values">{{ anim.from }}→{{ anim.to }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.properties-panel { background: #1e1e1e; font-size: 13px; }
.panel-header { padding: 10px 12px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #333; }
.empty-state { padding: 24px 12px; color: #666; text-align: center; font-size: 12px; }
.props-content { padding: 8px 12px; }
.prop-section-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; text-transform: capitalize; }
.prop-group-title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 12px; margin-bottom: 4px; padding-top: 8px; border-top: 1px solid #333; }
.anim-summary { display: flex; gap: 8px; padding: 3px 0; font-size: 11px; }
.anim-type { color: #6cb3ff; }
.anim-trigger { color: #888; }
.anim-values { color: #666; font-family: monospace; }
</style>
