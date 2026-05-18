<script setup lang="ts">
import { computed } from 'vue'
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
} from '../../stores/editor'

const emit = defineEmits<{
  save: []
  close: []
  'toggle-claude': []
  'toggle-git': []
}>()

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

function onEnableIndependent() {
  if (isIndependent.value) return
  const ok = window.confirm(
    'Vas a separar escritorio y móvil en dos configuraciones independientes.\n\n' +
      'Móvil empieza como copia de escritorio (con los ajustes móviles aplicados) ' +
      'y desde ahora podrás editarlos por separado.\n\n' +
      'Puedes deshacer con Cmd+Z. ¿Continuar?',
  )
  if (ok) enableIndependentViews()
}
</script>

<template>
  <div class="toolbar">
    <div class="toolbar-left">
      <button class="tool-btn" @click="emit('close')" title="Volver a proyectos">&larr;</button>
      <span class="project-name">{{ state.slug }}</span>
      <span v-if="isDirty" class="dirty-dot" title="Cambios sin guardar">*</span>
    </div>

    <div class="toolbar-center">
      <button
        :class="['tool-btn', 'icon-btn', { active: state.tool === 'select' }]"
        @click="state.tool = 'select'"
        title="Seleccionar (V)"
        aria-label="Seleccionar (V)"
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
        <span class="tool-label">Seleccionar</span>
      </button>
      <button
        :class="['tool-btn', 'icon-btn', { active: state.tool === 'hand' }]"
        @click="state.tool = 'hand'"
        title="Mano (H)"
        aria-label="Mano (H)"
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
        <span class="tool-label">Mano</span>
      </button>

      <span class="separator" />

      <button
        :class="['device-btn', { active: state.deviceMode === 'desktop' }]"
        @click="state.deviceMode = 'desktop'"
        :title="isIndependent ? 'Editar configuración de Escritorio' : 'Escritorio'"
        data-test="device-desktop"
      >&#x1F4BB;</button>
      <button
        :class="['device-btn', { active: state.deviceMode === 'mobile' }]"
        @click="state.deviceMode = 'mobile'"
        :title="isIndependent ? 'Editar configuración de Móvil' : 'Móvil'"
        data-test="device-mobile"
      >&#x1F4F1;</button>

      <!-- Mode + active-view indicator. Compartido = one shared tree (legacy);
           Independiente = two separate trees, the device toggle picks which
           one you edit. -->
      <span
        v-if="isIndependent"
        class="view-badge view-badge-indep"
        data-test="view-mode-indicator"
        :data-active-view="state.deviceMode"
        :title="`Configuración independiente — editando ${state.deviceMode === 'mobile' ? 'Móvil' : 'Escritorio'}`"
      >Independiente · {{ state.deviceMode === 'mobile' ? 'Móvil' : 'Escritorio' }}</span>
      <button
        v-else
        class="view-badge view-badge-shared"
        data-test="enable-independent-views"
        title="Separar escritorio y móvil en configuraciones independientes"
        @click="onEnableIndependent"
      >Compartido — Separar móvil/escritorio</button>

      <span class="separator" />

      <div class="zoom-control">
        <button class="zoom-btn" @click="zoomOut" title="Alejar (Cmd -)" aria-label="Alejar">&minus;</button>
        <button class="zoom-label" @click="fit" title="Ajustar a la pantalla (Cmd 0)" aria-label="Ajustar a la pantalla">{{ zoomPercent }}%</button>
        <button class="zoom-btn" @click="zoomIn" title="Acercar (Cmd +)" aria-label="Acercar">+</button>
      </div>

      <span class="separator" />

      <div class="mode-toggle" role="group" aria-label="Modo de vista">
        <button
          :class="['mode-btn', { active: state.previewMode === 'edit' }]"
          @click="state.previewMode = 'edit'"
          title="Edicion: mover elementos, animaciones en pausa"
        >Edicion</button>
        <button
          :class="['mode-btn', { active: state.previewMode === 'preview' }]"
          @click="state.previewMode = 'preview'"
          title="Preview: reproduce animaciones y parallax"
        >Preview</button>
      </div>

      <span class="separator" />

      <label
        class="snap-toggle"
        title="Ver toda la composición de una vez, a escala (sin desplazarte por las secciones)"
      >
        <input
          type="checkbox"
          :checked="state.overviewMode"
          @change="onToggleOverview"
          data-test="overview-toggle"
        />
        Vista completa
      </label>

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
.snap-toggle { display: flex; align-items: center; gap: 4px; color: #888; cursor: pointer; font-size: 12px; }
.snap-toggle input { accent-color: #0066cc; }
.save-btn { background: #0066cc; border: none; color: #fff; padding: 4px 14px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; }
.save-btn:disabled { opacity: 0.4; cursor: default; }
</style>
