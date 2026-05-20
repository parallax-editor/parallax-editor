<script setup lang="ts">
import { computed, ref } from 'vue'
import HelpHint from './HelpHint.vue'

/**
 * Friendly font-size control for text elements.
 *
 * The schema keeps `fontSize` as a free string (often a responsive
 * `clamp(min, vw, max)` so text scales between mobile and desktop). That raw
 * string is meaningless to a non-technical user, so this control exposes a
 * simple "px on desktop" stepper + named presets, and emits a sensible
 * responsive `clamp(...)` value. Any incoming value (clamp / px / rem / vw /
 * empty) is parsed to a single representative "desktop px" number for display;
 * editing replaces it with a fresh clamp built from that number.
 *
 * An "avanzado" expander still exposes the raw CSS string for power users.
 */
const props = defineProps<{ modelValue: string | undefined; help?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const PRESETS: { key: string; label: string; px: number }[] = [
  { key: 'pequeno', label: 'Pequeño', px: 18 },
  { key: 'mediano', label: 'Mediano', px: 28 },
  { key: 'grande', label: 'Grande', px: 44 },
  { key: 'titulo', label: 'Título', px: 72 },
]

const MIN_PX = 8
const MAX_PX = 200

// ── Parse any incoming fontSize string → representative "desktop" px ─────────
function parsePx(v: string | undefined): number {
  if (!v || typeof v !== 'string') return 28
  const s = v.trim()
  // clamp(min, preferred, max) → use the MAX (the desktop end).
  const clampM = s.match(/clamp\(([^)]*)\)/i)
  if (clampM) {
    const parts = clampM[1].split(',').map((p) => p.trim())
    const maxPart = parts[2] ?? parts[parts.length - 1]
    const n = unitToPx(maxPart)
    if (n != null) return clamp(n)
  }
  const n = unitToPx(s)
  if (n != null) return clamp(n)
  return 28
}

// Convert a single CSS length token to an approximate px number.
function unitToPx(token: string): number | null {
  const t = token.trim()
  let m = t.match(/^(-?\d*\.?\d+)px$/i)
  if (m) return Math.round(parseFloat(m[1]))
  m = t.match(/^(-?\d*\.?\d+)rem$/i)
  if (m) return Math.round(parseFloat(m[1]) * 16)
  m = t.match(/^(-?\d*\.?\d+)em$/i)
  if (m) return Math.round(parseFloat(m[1]) * 16)
  // vw: approximate against a ~1440px desktop artboard.
  m = t.match(/^(-?\d*\.?\d+)vw$/i)
  if (m) return Math.round((parseFloat(m[1]) / 100) * 1440)
  m = t.match(/^(-?\d*\.?\d+)$/)
  if (m) return Math.round(parseFloat(m[1]))
  return null
}

function clamp(n: number): number {
  return Math.min(MAX_PX, Math.max(MIN_PX, Math.round(n)))
}

// ── Build a responsive clamp from a single desktop px target ────────────────
// Keeps text readable on mobile (never below ~62% of desktop, floor 14px)
// while scaling up via vw to the desktop target.
function buildClamp(px: number): string {
  const p = clamp(px)
  const minPx = Math.max(14, Math.round(p * 0.62))
  // vw tuned so the preferred size hits ~p px around a 1440px viewport.
  const vw = Math.round(((p / 1440) * 100) * 10) / 10
  return `clamp(${minPx}px, ${vw}vw, ${p}px)`
}

const currentPx = computed(() => parsePx(props.modelValue))

// Filled-track look (matches NumberSlider / RangeSlider): % left of the thumb.
const fillPct = computed(() => {
  const range = MAX_PX - MIN_PX
  const p = ((currentPx.value - MIN_PX) / range) * 100
  return Math.max(0, Math.min(100, p))
})

const isResponsive = computed(() =>
  typeof props.modelValue === 'string' && /clamp\(/i.test(props.modelValue),
)

const activePreset = computed(() =>
  PRESETS.find((p) => Math.abs(p.px - currentPx.value) <= 2)?.key ?? null,
)

function setPx(px: number) {
  emit('update:modelValue', buildClamp(px))
}

function onStepper(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  setPx(v)
}

function onSlider(e: Event) {
  setPx(Number((e.target as HTMLInputElement).value))
}

// ── Advanced raw editor ─────────────────────────────────────────────────────
const showRaw = ref(false)
function onRaw(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="fs-field" data-test="fontsize-field">
    <div class="fs-row">
      <label class="field-label">Tamaño</label>
      <div class="fs-presets">
        <button
          v-for="p in PRESETS"
          :key="p.key"
          type="button"
          class="fs-preset"
          :class="{ active: activePreset === p.key }"
          :data-test="`fontsize-preset-${p.key}`"
          @click="setPx(p.px)"
        >{{ p.label }}</button>
      </div>
      <HelpHint
        v-if="help"
        :text="help"
        label="Tamaño"
      />
    </div>

    <div class="fs-row fs-fine">
      <input
        class="fs-slider"
        type="range"
        :min="MIN_PX"
        :max="MAX_PX"
        step="1"
        :value="currentPx"
        :style="{ '--pct': fillPct + '%' }"
        data-test="fontsize-slider"
        aria-label="Tamaño del texto"
        @input="onSlider"
      />
      <input
        class="fs-num"
        type="number"
        :min="MIN_PX"
        :max="MAX_PX"
        step="1"
        :value="currentPx"
        data-test="fontsize-number"
        aria-label="Tamaño del texto en px"
        @input="onStepper"
      />
      <span class="fs-unit">px</span>
    </div>

    <div class="fs-meta">
      <span data-test="fontsize-readable">{{ currentPx }} px en pantalla grande</span>
      <span v-if="isResponsive" class="fs-tag">· se adapta a móvil</span>
      <button
        type="button"
        class="fs-adv-toggle"
        data-test="fontsize-advanced-toggle"
        :aria-expanded="showRaw"
        @click="showRaw = !showRaw"
      >{{ showRaw ? 'ocultar' : 'avanzado' }}</button>
    </div>

    <div v-if="showRaw" class="fs-raw">
      <input
        class="field-input"
        type="text"
        :value="modelValue || ''"
        data-test="fontsize-raw-input"
        aria-label="Valor CSS de tamaño (avanzado)"
        @input="onRaw"
      />
    </div>
  </div>
</template>

<style scoped>
.fs-field { padding: 4px 0; }
.fs-row { display: flex; align-items: center; gap: 8px; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.fs-presets { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
.fs-preset {
  background: #2a2a2a; border: 1px solid #444; color: #bbb;
  font-size: 10px; padding: 3px 7px; border-radius: 4px; cursor: pointer;
}
.fs-preset:hover { background: #383838; color: #eee; }
.fs-preset.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.fs-fine { margin-top: 6px; padding-left: 78px; }
/* Filled-track slider matching NumberSlider/RangeSlider (Image #63/#66). */
.fs-slider {
  flex: 1; min-width: 0; height: 18px; margin: 0; cursor: pointer;
  -webkit-appearance: none; appearance: none; background: transparent;
}
.fs-slider::-webkit-slider-runnable-track {
  height: 6px; border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--accent) 0%, var(--accent) var(--pct, 50%),
    #3a3a3a var(--pct, 50%), #3a3a3a 100%
  );
}
.fs-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; margin-top: -4px; border-radius: 50%;
  background: #eef2f8; border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); cursor: grab;
}
.fs-slider::-webkit-slider-thumb:active { cursor: grabbing; }
.fs-slider:focus { outline: none; }
.fs-slider:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--accent-soft); }
.fs-slider::-moz-range-track { height: 6px; border-radius: 999px; background: #3a3a3a; }
.fs-slider::-moz-range-progress { height: 6px; border-radius: 999px; background: var(--accent); }
.fs-slider::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: #eef2f8; border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}
.fs-num {
  width: 56px; background: #2a2a2a; border: 1px solid #444; border-radius: 4px;
  color: #e0e0e0; padding: 4px 6px; font-size: 12px;
  /* Hide the native number spinner (#109) — slider/arrow keys are the affordance. */
  -moz-appearance: textfield;
}
.fs-num::-webkit-outer-spin-button,
.fs-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.fs-unit { font-size: 11px; color: #888; }
.fs-meta {
  margin-top: 4px; padding-left: 78px; font-size: 10px; color: #777;
  display: flex; align-items: center; gap: 6px;
}
.fs-tag { color: #6c9; }
.fs-adv-toggle {
  margin-left: auto; background: none; border: none; color: var(--accent-strong);
  font-size: 10px; cursor: pointer; padding: 0; text-decoration: underline;
}
.fs-raw { margin-top: 4px; padding-left: 78px; }
/* Match PropField.vue's .field-input byte-for-byte (incl. box-sizing + focus)
   so the advanced/custom CSS box is visually consistent with every other
   themed panel input — issue #55. */
.field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
</style>
