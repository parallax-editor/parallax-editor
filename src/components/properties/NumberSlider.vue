<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import HelpHint from './HelpHint.vue'

/**
 * Illustrator-style numeric slider.
 *
 * One row = label + numeric input + horizontal slider + (optional) unit suffix
 * + HelpHint. Dragging the slider OR typing the number both update the value
 * live; Esc reverts the in-flight edit; arrow keys nudge by `step`.
 *
 * `display`:
 *   'raw'      — the stored value IS the displayed value (default).
 *   'percent'  — the stored value is 0–1 but the UI shows 0–100% (slider
 *                runs 0–100, the number reads/writes 0–100, and the emitted
 *                value is the underlying 0–1 fraction). `unit` should be '%'.
 *
 * Emits `update:modelValue` with the RAW (store-shape) value — never the
 * percent display. Caller code keeps the existing data shape verbatim.
 *
 * `id` lets callers stamp distinct data-test hooks (numberslider-<id>,
 * numberslider-<id>-input, numberslider-<id>-track). Falls back to a sanitized
 * label so existing harness selectors stay stable.
 */
const props = withDefaults(
  defineProps<{
    label: string
    modelValue: number | undefined | null
    min?: number
    max?: number
    step?: number
    unit?: string
    help?: string
    display?: 'raw' | 'percent'
    /** Show this number when modelValue is null/undefined (UI fallback only — never emitted). */
    placeholder?: number
    /** data-test id prefix. */
    id?: string
    /** Decimal digits to show in the number input (display only). */
    decimals?: number
  }>(),
  {
    display: 'raw',
    step: 1,
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const testId = computed(() =>
  props.id || props.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'value',
)

// Convert between the stored (raw) value and the displayed value.
function toDisplay(raw: number | undefined | null): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : (props.placeholder ?? 0)
  return props.display === 'percent' ? n * 100 : n
}

function toRaw(displayed: number): number {
  return props.display === 'percent' ? displayed / 100 : displayed
}

const displayedFromProp = computed(() => toDisplay(props.modelValue))

// Local input string so the user can type freely (incl. '-', '.', empty) and
// arrow keys / slider drags reflect immediately; we revert on Esc.
const inputText = ref<string>('')
const editing = ref(false)
let preEditValue: number | null = null

watch(
  displayedFromProp,
  (v) => {
    if (!editing.value) inputText.value = formatNumber(v)
  },
  { immediate: true },
)

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return ''
  const d = props.decimals
  if (typeof d === 'number') return n.toFixed(d)
  // Default: drop trailing zeros, keep at most 4 fractional digits so a depth
  // of 0.05 reads cleanly.
  const s = n.toFixed(4)
  return s.replace(/\.?0+$/, '')
}

function clampRaw(raw: number): number {
  let v = raw
  if (typeof props.min === 'number') v = Math.max(props.min, v)
  if (typeof props.max === 'number') v = Math.min(props.max, v)
  return v
}

function emitFromDisplay(displayed: number) {
  if (!Number.isFinite(displayed)) return
  const raw = clampRaw(toRaw(displayed))
  emit('update:modelValue', raw)
}

function onSliderInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  inputText.value = formatNumber(v)
  emitFromDisplay(v)
}

function onNumberInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  inputText.value = raw
  const n = Number(raw)
  if (raw === '' || !Number.isFinite(n)) return
  emitFromDisplay(n)
}

function onNumberFocus() {
  editing.value = true
  preEditValue = displayedFromProp.value
}

function onNumberBlur() {
  editing.value = false
  // Reflect the committed value back into the input.
  inputText.value = formatNumber(displayedFromProp.value)
}

function onNumberKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (preEditValue != null) {
      emitFromDisplay(preEditValue)
    }
    inputText.value = formatNumber(displayedFromProp.value)
    ;(e.target as HTMLInputElement).blur()
  }
}

// Track min/max for the slider — both required to render a sensible track.
const hasTrack = computed(
  () => typeof props.min === 'number' && typeof props.max === 'number',
)

// Filled-track look (Image #63): the % of the track left of the thumb, fed to
// CSS as `--pct` so the runnable track paints a blue fill up to the thumb.
const sliderMin = computed(() => (props.display === 'percent' ? 0 : props.min ?? 0))
const sliderMax = computed(() => (props.display === 'percent' ? 100 : props.max ?? 100))
const fillPct = computed(() => {
  const range = sliderMax.value - sliderMin.value
  if (range <= 0) return 0
  const p = ((displayedFromProp.value - sliderMin.value) / range) * 100
  return Math.max(0, Math.min(100, p))
})
</script>

<template>
  <div class="prop-field number-slider" :data-test="`numberslider-${testId}`">
    <label class="field-label">{{ label }}</label>
    <span class="field-control ns-control">
      <input
        v-if="hasTrack"
        class="ns-track"
        type="range"
        :min="display === 'percent' ? 0 : min"
        :max="display === 'percent' ? 100 : max"
        :step="step"
        :value="displayedFromProp"
        :style="{ '--pct': fillPct + '%' }"
        :aria-label="label"
        :data-test="`numberslider-${testId}-track`"
        @input="onSliderInput"
      />
      <span class="ns-num-wrap">
        <input
          class="ns-num"
          type="number"
          :step="step"
          :value="inputText"
          :aria-label="label"
          :data-test="`numberslider-${testId}-input`"
          @input="onNumberInput"
          @focus="onNumberFocus"
          @blur="onNumberBlur"
          @keydown="onNumberKeydown"
        />
        <!-- data-test=field-unit (same hook as PropField) so the harness's
             [#31] "unidades visibles" probe sees percent/° on the new
             slider-driven rows too. Purely a test affordance — visually it is
             our scoped .ns-unit. -->
        <span v-if="unit" class="ns-unit" data-test="field-unit">{{ unit }}</span>
      </span>
    </span>
    <HelpHint v-if="help" :text="help" :label="label" />
  </div>
</template>

<style scoped>
/* Same row contract as PropField (.prop-field / .field-label / .field-control)
   so the slider blends with every other panel field. Row never overflows. */
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-control { flex: 1 1 auto; min-width: 0; }
.ns-control { display: flex; align-items: center; gap: 6px; }
/* Filled-track slider (Image #63): rounded track with a blue fill up to the
   thumb + a light pill thumb. `--pct` (set inline) drives the WebKit fill. */
.ns-track {
  flex: 1 1 auto;
  min-width: 0;
  height: 18px;
  margin: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
}
.ns-track::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--accent) 0%,
    var(--accent) var(--pct, 50%),
    #3a3a3a var(--pct, 50%),
    #3a3a3a 100%
  );
}
.ns-track::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -4px;
  border-radius: 50%;
  background: #eef2f8;
  border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  cursor: grab;
}
.ns-track::-webkit-slider-thumb:active { cursor: grabbing; }
.ns-track:focus { outline: none; }
.ns-track:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--accent-soft); }
/* Firefox */
.ns-track::-moz-range-track { height: 6px; border-radius: 999px; background: #3a3a3a; }
.ns-track::-moz-range-progress { height: 6px; border-radius: 999px; background: var(--accent); }
.ns-track::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: #eef2f8; border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}
.ns-num-wrap { position: relative; display: flex; align-items: center; flex: 0 0 auto; }
.ns-num {
  width: 60px;
  box-sizing: border-box;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  padding: 4px 22px 4px 6px;
  font-size: 12px;
  font-family: inherit;
  text-align: right;
  /* Hide spinners — the slider IS the affordance. */
  -moz-appearance: textfield;
}
.ns-num::-webkit-outer-spin-button,
.ns-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ns-num:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
.ns-unit {
  position: absolute;
  right: 6px;
  pointer-events: none;
  font-size: 10px;
  color: #888;
}
</style>
