<script setup lang="ts">
import { computed } from 'vue'
import HelpHint from './HelpHint.vue'

const props = defineProps<{
  label: string
  modelValue: any
  type?: 'text' | 'number' | 'color' | 'select' | 'checkbox' | 'textarea'
  options?: string[]
  min?: number
  max?: number
  step?: number
  help?: string
  // Display-only unit hint shown next to the control (e.g. "%", "°", "ms").
  // Never coerces/strips the stored value — purely an affordance for Daniela.
  unit?: string
  // Placeholder shown when an empty value is allowed (e.g. "auto").
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()

const fieldType = computed(() => props.type || (typeof props.modelValue === 'number' ? 'number' : typeof props.modelValue === 'boolean' ? 'checkbox' : 'text'))

// The unit suffix only makes sense next to a single-line text/number control.
const showUnit = computed(
  () => !!props.unit && fieldType.value !== 'checkbox' && fieldType.value !== 'color' && fieldType.value !== 'select',
)

function update(val: any) {
  if (fieldType.value === 'number') val = Number(val)
  emit('update:modelValue', val)
}
</script>

<template>
  <div class="prop-field">
    <label class="field-label">{{ label }}</label>

    <select v-if="fieldType === 'select'" :value="modelValue" @change="update(($event.target as any).value)" class="field-input field-control">
      <option v-for="opt in options" :key="opt" :value="opt">{{ opt }}</option>
    </select>

    <label v-else-if="fieldType === 'checkbox'" class="checkbox-wrap field-control">
      <input type="checkbox" :checked="modelValue" @change="update(($event.target as any).checked)" />
    </label>

    <input v-else-if="fieldType === 'color'" type="color" :value="modelValue" @input="update(($event.target as any).value)" class="field-color field-control" />

    <textarea v-else-if="fieldType === 'textarea'" :value="modelValue" @input="update(($event.target as any).value)" class="field-input field-control" rows="3" />

    <span v-else class="field-control input-wrap">
      <input :type="fieldType" :value="modelValue" @input="update(($event.target as any).value)" :min="min" :max="max" :step="step" :placeholder="placeholder" class="field-input" />
      <span v-if="showUnit" class="field-unit" data-test="field-unit">{{ unit }}</span>
    </span>

    <HelpHint v-if="help" :text="help" :label="label" />
  </div>
</template>

<style scoped>
/* Row layout: label (auto) + control (flex:1, shrinkable) + ? (fixed).
   min-width:0 lets the control shrink instead of pushing the "?" past the
   panel edge; box never exceeds the panel content width. */
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-control { flex: 1 1 auto; min-width: 0; }
.field-input { width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit; }
.field-input:focus { outline: 1px solid #0066cc; border-color: #0066cc; }
.input-wrap { position: relative; display: flex; align-items: center; }
.field-unit {
  position: absolute; right: 8px; pointer-events: none;
  font-size: 10px; color: #888; background: #2a2a2a; padding-left: 4px;
}
/* Reserve room so the value text doesn't run under the unit label. */
.input-wrap .field-input { padding-right: 30px; }
.field-color { width: 32px; height: 24px; flex: 0 0 32px; border: 1px solid #444; border-radius: 4px; padding: 0; cursor: pointer; }
.checkbox-wrap { display: flex; flex: 0 0 auto; }
.checkbox-wrap input { accent-color: #0066cc; }
</style>
