<script setup lang="ts">
import { computed } from 'vue'
import HelpHint from './HelpHint.vue'

/**
 * Friendly CSS mix-blend-mode select. Emits the raw CSS keyword (verbatim,
 * unchanged from what the engine consumes — layer.style.mixBlendMode /
 * cursor.blendMode). Spanish labels mirror the rest of the panel.
 *
 * "Personalizado" reveals a text input for power users / forward-compat values
 * the schema may add (the field is `z.string()` so anything goes).
 *
 * `id` lets callers stamp distinct data-test hooks (blendselect-<id>) — falls
 * back to a sanitized label so existing harness selectors stay stable.
 */
const props = withDefaults(
  defineProps<{
    label?: string
    modelValue: string | undefined | null
    help?: string
    /** Allowed empty string (clear the field) — adds an "(ninguno)" option. */
    allowEmpty?: boolean
    /** data-test id prefix. */
    id?: string
  }>(),
  { label: 'Blend', allowEmpty: true },
)

const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()

const testId = computed(() =>
  props.id || props.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blend',
)

// The CSS keywords + Spanish labels (the user is non-technical — she sees
// "Multiplicar", we still write `multiply`).
const BLENDS: { value: string; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiplicar' },
  { value: 'screen', label: 'Pantalla' },
  { value: 'overlay', label: 'Superposición' },
  { value: 'darken', label: 'Oscurecer' },
  { value: 'lighten', label: 'Aclarar' },
  { value: 'color-dodge', label: 'Sobreexponer color' },
  { value: 'color-burn', label: 'Subexponer color' },
  { value: 'difference', label: 'Diferencia' },
  { value: 'exclusion', label: 'Exclusión' },
  { value: 'hue', label: 'Tono' },
  { value: 'saturation', label: 'Saturación' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosidad' },
]

const CUSTOM = '__custom__'

const KNOWN = new Set(BLENDS.map((b) => b.value))

const isCustom = computed(() => {
  const v = (props.modelValue ?? '').toString()
  if (v === '') return false
  return !KNOWN.has(v)
})

const selectValue = computed(() => {
  const v = (props.modelValue ?? '').toString()
  if (v === '') return ''
  if (KNOWN.has(v)) return v
  return CUSTOM
})

function onSelect(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v === '') {
    emit('update:modelValue', undefined)
    return
  }
  if (v === CUSTOM) {
    // Picking "Personalizado" reveals the input but keeps whatever value is
    // there (seed with empty so the text box appears clean if untouched).
    emit('update:modelValue', isCustom.value ? (props.modelValue as string) : '')
    return
  }
  emit('update:modelValue', v)
}

function onCustomInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  emit('update:modelValue', v === '' ? undefined : v)
}
</script>

<template>
  <div class="prop-field blend-select" :data-test="`blendselect-${testId}`">
    <label class="field-label">{{ label }}</label>
    <span class="field-control bs-wrap">
      <select
        class="field-input bs-select"
        :value="selectValue"
        :data-test="`blendselect-${testId}-select`"
        @change="onSelect"
      >
        <option v-if="allowEmpty" value="">(ninguno)</option>
        <option v-for="b in BLENDS" :key="b.value" :value="b.value">{{ b.label }}</option>
        <option :value="CUSTOM">Personalizado…</option>
      </select>
      <input
        v-if="selectValue === CUSTOM"
        type="text"
        class="field-input bs-custom"
        placeholder="mix-blend-mode CSS"
        :value="modelValue || ''"
        :data-test="`blendselect-${testId}-custom`"
        @input="onCustomInput"
      />
    </span>
    <HelpHint v-if="help" :text="help" :label="label" />
  </div>
</template>

<style scoped>
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-control { flex: 1 1 auto; min-width: 0; }
.bs-wrap { display: flex; flex-direction: column; gap: 4px; }
.bs-select, .bs-custom {
  width: 100%;
  box-sizing: border-box;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
}
.bs-select:focus, .bs-custom:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
/* Homogenize the <select> chevron to match PropField / GradientBuilder so the
   blend dropdown shows the identical custom arrow + right-side gap instead of
   the native OS arrow. Styling only. */
.bs-select {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'><path d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
</style>
