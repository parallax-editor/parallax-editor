<script setup lang="ts">
// "Grid y guías ▾" — un popover sencillo (pensado para usuario no técnico) que
// agrupa los ajustes de la cuadrícula y las guías:
//   • Mostrar grid        → state.gridVisible  (solo la cuadrícula visible)
//   • Tamaño de celda      → state.gridPercent  (Fina / Media / Gruesa)
//   • Ajustar a la grid    → state.snapToGrid   (los elementos saltan a la grid)
//   • Guías inteligentes   → state.smartGuides  (las líneas moradas de alineación)
// Cada cambio se persiste de inmediato y POR PROYECTO (persistGridGuias →
// clave parallax-editor:grid-guias:<tipo>:<slug>). El popover se cierra al
// hacer clic fuera o con Esc.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  state,
  persistGridGuias,
  GRID_PERCENT_MIN,
  GRID_PERCENT_MAX,
} from '../../stores/editor'
import HelpHint from '../properties/HelpHint.vue'

const { t } = useI18n()

// Ayuda por control (formato seguro que HelpHint renderiza: **negrita**, etc.).
const HELP = computed(() => ({
  gridVisible: t('gridGuides.helpVisible'),
  cellSize: t('gridGuides.helpCellSize'),
  snap: t('gridGuides.helpSnap'),
  smartGuides: t('gridGuides.helpSmart'),
}))

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
// Teleported popover lives on <body>, so .contains(target) against rootRef
// will always say "outside" → the click-outside handler closed the popover
// the instant the user pressed any control inside it. Track the popover
// element via a ref and check BOTH when deciding "click outside".
const popoverRef = ref<HTMLElement | null>(null)
// Teleport the popover to <body> so it escapes the toolbar's stacking
// context (the toolbar has z-index:100 which makes it a stacking root —
// any z-index inside it is bounded by 100, so a child at 11000 still
// loses to siblings like SelectionOverlay at 10000 in another context).
// Reading the trigger's bounding rect each open lets the popover sit
// just below the button as before.
const popoverPos = ref({ top: 0, left: 0 })
function updatePopoverPos() {
  const root = rootRef.value
  if (!root) return
  const r = root.getBoundingClientRect()
  popoverPos.value = { top: r.bottom + 6, left: r.left }
}

function toggle() {
  open.value = !open.value
  if (open.value) nextTick(updatePopoverPos)
}
function close() {
  open.value = false
}

// Cerrar al hacer clic fuera del control.
function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  const root = rootRef.value
  const pop = popoverRef.value
  const target = e.target as Node
  const insideRoot = !!root && root.contains(target)
  const insidePop = !!pop && pop.contains(target)
  if (!insideRoot && !insidePop) close()
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
  window.addEventListener('resize', updatePopoverPos)
  window.addEventListener('scroll', updatePopoverPos, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', updatePopoverPos)
  window.removeEventListener('scroll', updatePopoverPos, true)
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
const SIZE_PRESETS = computed<{ value: number; label: string; testKey: string }[]>(() => [
  { value: 3, label: t('gridGuides.presetFine'), testKey: 'fina' },
  { value: 5, label: t('gridGuides.presetMedium'), testKey: 'media' },
  { value: 10, label: t('gridGuides.presetCoarse'), testKey: 'gruesa' },
])
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
      :title="t('gridGuides.triggerTitle')"
      @click="toggle"
    >
      {{ t('gridGuides.trigger') }}
      <span class="gg-caret" aria-hidden="true">▾</span>
    </button>

    <Teleport to="body">
    <div
      v-if="open"
      ref="popoverRef"
      class="gg-popover"
      role="dialog"
      :aria-label="t('gridGuides.trigger')"
      data-test="grid-guides-popover"
      :style="{ top: popoverPos.top + 'px', left: popoverPos.left + 'px' }"
    >
      <div class="gg-row gg-toggle">
        <label class="gg-toggle-label">
          <input
            type="checkbox"
            :checked="state.gridVisible"
            data-test="grid-visible-toggle"
            @change="onToggleGridVisible"
          />
          <span>{{ t('gridGuides.showGrid') }}</span>
        </label>
        <HelpHint :text="HELP.gridVisible" :label="t('gridGuides.showGrid')" />
      </div>

      <div
        class="gg-row gg-size"
        :class="{ disabled: !state.gridVisible }"
        data-test="grid-cell-size"
      >
        <span class="gg-size-head">
          <span class="gg-size-label">{{ t('gridGuides.cellSize') }}</span>
          <HelpHint :text="HELP.cellSize" :label="t('gridGuides.cellSize')" />
        </span>
        <div class="gg-presets" role="group" :aria-label="t('gridGuides.cellSize')">
          <button
            v-for="p in SIZE_PRESETS"
            :key="p.value"
            type="button"
            class="gg-preset"
            :class="{ active: state.gridPercent === p.value }"
            :disabled="!state.gridVisible"
            :data-test="`grid-cell-size-${p.testKey}`"
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
          :aria-label="t('gridGuides.cellSizePct')"
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
          <span>{{ t('gridGuides.snap') }}</span>
        </label>
        <HelpHint :text="HELP.snap" :label="t('gridGuides.snap')" />
      </div>

      <div class="gg-row gg-toggle">
        <label class="gg-toggle-label">
          <input
            type="checkbox"
            :checked="state.smartGuides"
            data-test="smartguides-toggle"
            @change="onToggleSmartGuides"
          />
          <span>{{ t('gridGuides.smart') }}</span>
        </label>
        <HelpHint :text="HELP.smartGuides" :label="t('gridGuides.smart')" />
      </div>
    </div>
    </Teleport>
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
  position: fixed; z-index: 100000;
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
