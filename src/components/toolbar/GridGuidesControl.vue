<script setup lang="ts">
// "Grid y guías ▾" — un popover sencillo (pensado para Daniela, no técnica) que
// agrupa los ajustes de la cuadrícula y las guías:
//   • Mostrar grid        → state.gridVisible  (solo la cuadrícula visible)
//   • Tamaño de celda      → state.gridPercent  (Fina / Media / Gruesa)
//   • Ajustar a la grid    → state.snapToGrid   (los elementos saltan a la grid)
//   • Guías inteligentes   → state.smartGuides  (las líneas moradas de alineación)
// Cada cambio se persiste de inmediato y POR PROYECTO (persistGridGuias →
// clave parallax-editor:grid-guias:<tipo>:<slug>). El popover se cierra al
// hacer clic fuera o con Esc.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  state,
  persistGridGuias,
  GRID_PERCENT_MIN,
  GRID_PERCENT_MAX,
} from '../../stores/editor'
import HelpHint from '../properties/HelpHint.vue'

// Ayuda por control (formato seguro que HelpHint renderiza: **negrita**, etc.).
const HELP = {
  gridVisible:
    'Muestra una **cuadrícula** sobre el lienzo para alinear elementos a ojo. Es solo una ayuda de edición — **no se publica** en el sitio.',
  cellSize:
    'Qué tan **fina o gruesa** es la cuadrícula. *Fina* = más líneas (más precisión); *Gruesa* = menos líneas. También define el paso del **Ajustar a la grid**.',
  snap:
    'Cuando está activo, al mover o redimensionar un elemento **se pega** a las líneas de la grid, para alineaciones exactas.',
  smartGuides:
    'Las **guías moradas** que aparecen al mover un elemento: muestran cuándo queda **alineado o centrado** respecto a los demás. Ayudan a ubicar sin usar grid.',
}

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}
function close() {
  open.value = false
}

// Cerrar al hacer clic fuera del control.
function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  const root = rootRef.value
  if (root && !root.contains(e.target as Node)) close()
}
// Cerrar con Escape.
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    close()
    ;(rootRef.value?.querySelector('.gg-trigger') as HTMLElement | null)?.focus()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})

function onToggleGridVisible(e: Event) {
  state.gridVisible = (e.target as HTMLInputElement).checked
  persistGridGuias()
}
function onToggleSnap(e: Event) {
  state.snapToGrid = (e.target as HTMLInputElement).checked
  persistGridGuias()
}
function onToggleSmartGuides(e: Event) {
  state.smartGuides = (e.target as HTMLInputElement).checked
  persistGridGuias()
}

// Tamaño de celda como 3 presets simples mapeados a % del lienzo.
// Fina = 3%, Media = 5%, Gruesa = 10% (todos dentro del rango permitido).
const SIZE_PRESETS: { value: number; label: string }[] = [
  { value: 3, label: 'Fina' },
  { value: 5, label: 'Media' },
  { value: 10, label: 'Gruesa' },
]
function clampPct(n: number): number {
  return Math.min(GRID_PERCENT_MAX, Math.max(GRID_PERCENT_MIN, n))
}
function onPickSize(value: number) {
  state.gridPercent = clampPct(value)
  persistGridGuias()
}
function onSlideSize(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v)) {
    state.gridPercent = clampPct(v)
    persistGridGuias()
  }
}
</script>

<template>
  <div ref="rootRef" class="gg-control">
    <button
      type="button"
      class="gg-trigger"
      :class="{ active: state.gridVisible || state.snapToGrid }"
      data-test="grid-guides-trigger"
      :aria-expanded="open"
      aria-haspopup="true"
      title="Grid y guías: cuadrícula, ajuste y guías de alineación"
      @click="toggle"
    >
      Grid y guías
      <span class="gg-caret" aria-hidden="true">▾</span>
    </button>

    <div
      v-if="open"
      class="gg-popover"
      role="dialog"
      aria-label="Grid y guías"
      data-test="grid-guides-popover"
    >
      <div class="gg-row gg-toggle">
        <label class="gg-toggle-label">
          <input
            type="checkbox"
            :checked="state.gridVisible"
            data-test="grid-visible-toggle"
            @change="onToggleGridVisible"
          />
          <span>Mostrar grid</span>
        </label>
        <HelpHint :text="HELP.gridVisible" label="Mostrar grid" />
      </div>

      <div
        class="gg-row gg-size"
        :class="{ disabled: !state.gridVisible }"
        data-test="grid-cell-size"
      >
        <span class="gg-size-head">
          <span class="gg-size-label">Tamaño de celda</span>
          <HelpHint :text="HELP.cellSize" label="Tamaño de celda" />
        </span>
        <div class="gg-presets" role="group" aria-label="Tamaño de celda">
          <button
            v-for="p in SIZE_PRESETS"
            :key="p.value"
            type="button"
            class="gg-preset"
            :class="{ active: state.gridPercent === p.value }"
            :disabled="!state.gridVisible"
            :data-test="`grid-cell-size-${p.label.toLowerCase()}`"
            @click="onPickSize(p.value)"
          >{{ p.label }}</button>
        </div>
        <input
          class="gg-slider"
          type="range"
          :min="GRID_PERCENT_MIN"
          :max="GRID_PERCENT_MAX"
          step="1"
          :value="state.gridPercent"
          :disabled="!state.gridVisible"
          data-test="grid-cell-size-slider"
          aria-label="Tamaño de celda en porcentaje"
          @input="onSlideSize"
        />
        <span class="gg-pct">{{ state.gridPercent }}%</span>
      </div>

      <div class="gg-sep" />

      <div class="gg-row gg-toggle">
        <label class="gg-toggle-label">
          <input
            type="checkbox"
            :checked="state.snapToGrid"
            data-test="grid-snap-toggle"
            @change="onToggleSnap"
          />
          <span>Ajustar a la grid</span>
        </label>
        <HelpHint :text="HELP.snap" label="Ajustar a la grid" />
      </div>

      <div class="gg-row gg-toggle">
        <label class="gg-toggle-label">
          <input
            type="checkbox"
            :checked="state.smartGuides"
            data-test="smartguides-toggle"
            @change="onToggleSmartGuides"
          />
          <span>Guías inteligentes</span>
        </label>
        <HelpHint :text="HELP.smartGuides" label="Guías inteligentes" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.gg-control { position: relative; display: inline-flex; }
.gg-trigger {
  display: inline-flex; align-items: center; gap: 5px;
  background: #333; border: 1px solid #444; color: #ccc;
  height: 24px; padding: 0 10px; border-radius: 4px; cursor: pointer;
  font-size: 12px; font-weight: 600;
}
.gg-trigger:hover { background: #444; color: #fff; }
.gg-trigger.active { border-color: var(--accent-strong, #0a84ff); color: #fff; }
.gg-caret { font-size: 10px; opacity: 0.8; }

/* Popover painted ABOVE the canvas: the toolbar is position:relative; z-index:100,
   so an absolutely-positioned child sits over the canvas/guides below. */
.gg-popover {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 200;
  min-width: 230px; background: #2b2b2b; border: 1px solid #444;
  border-radius: 8px; padding: 10px; box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  display: flex; flex-direction: column; gap: 8px;
}
.gg-row { display: flex; align-items: center; }
.gg-toggle { justify-content: space-between; gap: 6px; color: #ddd; font-size: 12px; }
.gg-toggle-label { display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1 1 auto; min-width: 0; }
.gg-toggle-label input { accent-color: var(--accent-strong, #0a84ff); }
.gg-size-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.gg-size { flex-direction: column; align-items: stretch; gap: 6px; }
.gg-size.disabled { opacity: 0.45; }
.gg-size-label { color: #aaa; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
.gg-presets { display: flex; gap: 4px; }
.gg-preset {
  flex: 1; background: #333; border: 1px solid #444; color: #bbb;
  padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;
}
.gg-preset:hover:not(:disabled) { background: #404040; color: #fff; }
.gg-preset.active { background: var(--accent, #0a84ff); border-color: var(--accent, #0a84ff); color: var(--accent-fg, #fff); }
.gg-preset:disabled { cursor: default; }
.gg-size .gg-slider { width: 100%; accent-color: var(--accent-strong, #0a84ff); }
.gg-pct { align-self: flex-end; color: #888; font-family: monospace; font-size: 11px; }
.gg-sep { height: 1px; background: #444; margin: 2px 0; }
</style>
