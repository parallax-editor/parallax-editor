<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import HelpHint from './HelpHint.vue'

/**
 * Illustrator-style two-handle range slider (atom).
 *
 * One row = label + two numeric inputs flanking a horizontal track with TWO
 * draggable handles. Dragging or typing either side updates the value live;
 * the `from` handle clamps to ≤ `to` (and vice-versa) so the tuple stays
 * ordered. Emits `update:modelValue` with the RAW (store-shape) `[from, to]`
 * tuple — never a display variant — so the store shape is unchanged.
 *
 * `display`:
 *   'raw'      — the stored tuple IS the displayed tuple (default).
 *   'percent'  — the stored tuple is 0–1 but the UI shows 0–100% (slider runs
 *                0–100, the number reads/writes 0–100, and the emitted tuple
 *                is the underlying 0–1 fraction). `unit` should be '%'. The
 *                `min`/`max`/`step`/`decimals` props should be specified in
 *                the percent-space (e.g. min=0 max=100 step=1 decimals=0).
 *
 * `fromLabel`/`toLabel` override the `aria-label`s on the two number inputs so
 * the harness/users see "Inicio %" / "Fin %" instead of the default
 * "<label> desde" / "<label> hasta".
 *
 * Chrome matches `NumberSlider` (.prop-field / .field-label / .field-control)
 * so it blends with every other panel row. `data-test`:
 *   rangeslider-<id>           — wrapper
 *   rangeslider-<id>-from      — left numeric input
 *   rangeslider-<id>-to        — right numeric input
 *   rangeslider-<id>-track     — the slider track (also -track-from / -track-to
 *                                aliases for the two range inputs that overlap
 *                                on the track).
 */
const props = withDefaults(
  defineProps<{
    label: string
    modelValue: [number, number] | null | undefined
    min: number
    max: number
    step?: number
    unit?: string
    help?: string
    /** Decimal digits to show in the number inputs (display only). */
    decimals?: number
    /** data-test id prefix. */
    id?: string
    /** Display mapping for stored value vs UI (see component docblock). */
    display?: 'raw' | 'percent'
    /** Aria-label for the "from" numeric input (default: `<label> desde`). */
    fromLabel?: string
    /** Aria-label for the "to" numeric input (default: `<label> hasta`). */
    toLabel?: string
  }>(),
  {
    step: 1,
    display: 'raw',
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: [number, number]] }>()

const testId = computed(() =>
  props.id || props.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'range',
)

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

// Convert between the stored (raw) value and the displayed value.
// In `percent` mode the store value is a 0–1 fraction and we display it on a
// 0–100 axis (so `min/max` are 0/100 in display-space).
function toDisplay(raw: number): number {
  return props.display === 'percent' ? raw * 100 : raw
}
function toRaw(displayed: number): number {
  return props.display === 'percent' ? displayed / 100 : displayed
}

// Default raw bounds for fallback when modelValue is missing: in percent mode
// the raw axis is 0..1; in raw mode use the props' min/max directly.
const rawMin = computed(() => (props.display === 'percent' ? 0 : props.min))
const rawMax = computed(() => (props.display === 'percent' ? 1 : props.max))

const fromValue = computed(() => {
  const v = Array.isArray(props.modelValue) ? props.modelValue[0] : rawMin.value
  const d = clamp(toDisplay(Number(v)), props.min, props.max)
  return d
})
const toValue = computed(() => {
  const v = Array.isArray(props.modelValue) ? props.modelValue[1] : rawMax.value
  const d = clamp(toDisplay(Number(v)), props.min, props.max)
  return d
})

// Local input strings so the user can type freely (incl. '.', empty).
const fromText = ref<string>('')
const toText = ref<string>('')
const editingFrom = ref(false)
const editingTo = ref(false)

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return ''
  const d = props.decimals
  if (typeof d === 'number') return n.toFixed(d)
  const s = n.toFixed(4)
  return s.replace(/\.?0+$/, '')
}

watch(
  fromValue,
  (v) => {
    if (!editingFrom.value) fromText.value = formatNumber(v)
  },
  { immediate: true },
)
watch(
  toValue,
  (v) => {
    if (!editingTo.value) toText.value = formatNumber(v)
  },
  { immediate: true },
)

function emitTuple(fromDisplay: number, toDisplay: number) {
  // Always keep from ≤ to and clamp to [min, max] in DISPLAY space; emit RAW.
  let f = clamp(fromDisplay, props.min, props.max)
  let t = clamp(toDisplay, props.min, props.max)
  if (f > t) f = t
  emit('update:modelValue', [toRaw(f), toRaw(t)])
}

function onFromSlider(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  // from-handle clamps ≤ to-handle.
  const clamped = Math.min(v, toValue.value)
  fromText.value = formatNumber(clamped)
  emitTuple(clamped, toValue.value)
}

function onToSlider(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  const clamped = Math.max(v, fromValue.value)
  toText.value = formatNumber(clamped)
  emitTuple(fromValue.value, clamped)
}

function onFromInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  fromText.value = raw
  const n = Number(raw)
  if (raw === '' || !Number.isFinite(n)) return
  emitTuple(n, toValue.value)
}

function onToInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  toText.value = raw
  const n = Number(raw)
  if (raw === '' || !Number.isFinite(n)) return
  emitTuple(fromValue.value, n)
}

function onFromFocus() {
  editingFrom.value = true
}
function onFromBlur() {
  editingFrom.value = false
  fromText.value = formatNumber(fromValue.value)
}
function onToFocus() {
  editingTo.value = true
}
function onToBlur() {
  editingTo.value = false
  toText.value = formatNumber(toValue.value)
}

// Visual fill between the two handles (percentage of [min,max]).
// When from === to (or extremely close) we still render a tiny visible chip
// so the user sees WHERE the (empty) range is sitting on the track — otherwise
// the fill collapses to 0px and the row reads as two empty number inputs with
// no slider at all (the bug we are fixing).
const fillStyle = computed(() => {
  const span = props.max - props.min
  if (span <= 0) return { left: '0%', right: '0%' }
  const leftPct = ((fromValue.value - props.min) / span) * 100
  const rightPct = 100 - ((toValue.value - props.min) / span) * 100
  return { left: `${leftPct}%`, right: `${rightPct}%` }
})
</script>

<template>
  <!-- Two-row layout (#109): the label sits on its own line, then the track +
       two numeric inputs flow underneath. With a narrow (~280px) panel a single
       row (label + from + track + to + ?) overflowed horizontally; stacking it
       keeps the whole control inside the panel content width at any zoom. -->
  <div class="prop-field range-slider range-slider-stacked" :data-test="`rangeslider-${testId}`">
    <div class="rs-label-row">
      <label class="field-label rs-label">{{ label }}</label>
      <HelpHint v-if="help" :text="help" :label="label" />
    </div>
    <span class="field-control rs-control">
      <span class="rs-num-wrap rs-num-wrap-from">
        <input
          class="rs-num"
          type="number"
          :step="step"
          :min="min"
          :max="max"
          :value="fromText"
          :aria-label="fromLabel || `${label} desde`"
          :data-test="`rangeslider-${testId}-from`"
          @input="onFromInput"
          @focus="onFromFocus"
          @blur="onFromBlur"
        />
        <span v-if="unit" class="rs-unit rs-unit-from" data-test="field-unit">{{ unit }}</span>
      </span>

      <span class="rs-track-wrap" :data-test="`rangeslider-${testId}-track`">
        <span class="rs-track-bg" />
        <span class="rs-track-fill" :style="fillStyle" />
        <input
          class="rs-range rs-range-from"
          type="range"
          :min="min"
          :max="max"
          :step="step"
          :value="fromValue"
          :aria-label="fromLabel || `${label} desde`"
          :data-test="`rangeslider-${testId}-track-from`"
          @input="onFromSlider"
        />
        <input
          class="rs-range rs-range-to"
          type="range"
          :min="min"
          :max="max"
          :step="step"
          :value="toValue"
          :aria-label="toLabel || `${label} hasta`"
          :data-test="`rangeslider-${testId}-track-to`"
          @input="onToSlider"
        />
      </span>

      <span class="rs-num-wrap rs-num-wrap-to">
        <input
          class="rs-num"
          type="number"
          :step="step"
          :min="min"
          :max="max"
          :value="toText"
          :aria-label="toLabel || `${label} hasta`"
          :data-test="`rangeslider-${testId}-to`"
          @input="onToInput"
          @focus="onToFocus"
          @blur="onToBlur"
        />
        <span v-if="unit" class="rs-unit" data-test="field-unit">{{ unit }}</span>
      </span>
    </span>
  </div>
</template>

<style scoped>
/* Two-row contract (#109): the field stacks vertically — label row, then the
   slider+inputs row — so it can never overflow the ~280px panel width even when
   both 56px number inputs flank an 80px track. Other panel rows stay one-line;
   this is opt-in via .range-slider-stacked. */
.prop-field { display: flex; padding: 3px 0; max-width: 100%; box-sizing: border-box; }
.range-slider-stacked { flex-direction: column; align-items: stretch; gap: 4px; }
.rs-label-row { display: flex; align-items: center; gap: 6px; }
.field-label { font-size: 11px; color: #999; }
.rs-label { flex: 1 1 auto; min-width: 0; }
.field-control { min-width: 0; max-width: 100%; }
.rs-control { display: flex; align-items: center; gap: 6px; box-sizing: border-box; }

.rs-track-wrap {
  position: relative;
  flex: 1 1 auto;
  /* Force a minimum visible track so the slider chrome is recognizable even
     when the panel is narrow and even when both handles sit at the same end
     (from === to === 0, the previous bug had the track collapse). */
  min-width: 80px;
  height: 18px;
  display: flex;
  align-items: center;
}
.rs-track-bg {
  position: absolute;
  left: 0; right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 6px;
  background: #3a3a3a;
  border-radius: 999px;
}
.rs-track-fill {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 6px;
  background: var(--accent);
  border-radius: 999px;
}
/* Two stacked range inputs share the track. They are transparent so the
   custom track/fill above shows through; only the thumbs are visible. */
.rs-range {
  position: absolute;
  left: 0;
  right: 0;
  width: 100%;
  height: 18px;
  margin: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  pointer-events: none;
}
.rs-range::-webkit-slider-runnable-track { background: transparent; height: 18px; }
.rs-range::-moz-range-track { background: transparent; height: 18px; }
.rs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  pointer-events: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #eef2f8;
  border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  cursor: grab;
}
.rs-range::-webkit-slider-thumb:active { cursor: grabbing; }
.rs-range::-moz-range-thumb {
  pointer-events: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #eef2f8;
  border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  cursor: pointer;
}

.rs-num-wrap { position: relative; display: flex; align-items: center; flex: 0 1 56px; min-width: 44px; }
.rs-num {
  width: 100%;
  box-sizing: border-box;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  padding: 4px 6px;
  font-size: 12px;
  font-family: inherit;
  text-align: right;
  -moz-appearance: textfield;
}
.rs-num-wrap-to .rs-num,
.rs-num-wrap-from .rs-num { padding-right: 22px; }
.rs-num::-webkit-outer-spin-button,
.rs-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.rs-num:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
.rs-unit {
  position: absolute;
  right: 6px;
  pointer-events: none;
  font-size: 10px;
  color: #888;
}
</style>
