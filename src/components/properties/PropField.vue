<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  modelValue: any
  type?: 'text' | 'number' | 'color' | 'select' | 'checkbox' | 'textarea'
  options?: string[]
  min?: number
  max?: number
  step?: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: any] }>()

const fieldType = computed(() => props.type || (typeof props.modelValue === 'number' ? 'number' : typeof props.modelValue === 'boolean' ? 'checkbox' : 'text'))

function update(val: any) {
  if (fieldType.value === 'number') val = Number(val)
  emit('update:modelValue', val)
}
</script>

<template>
  <div class="prop-field">
    <label class="field-label">{{ label }}</label>

    <select v-if="fieldType === 'select'" :value="modelValue" @change="update(($event.target as any).value)" class="field-input">
      <option v-for="opt in options" :key="opt" :value="opt">{{ opt }}</option>
    </select>

    <label v-else-if="fieldType === 'checkbox'" class="checkbox-wrap">
      <input type="checkbox" :checked="modelValue" @change="update(($event.target as any).checked)" />
    </label>

    <input v-else-if="fieldType === 'color'" type="color" :value="modelValue" @input="update(($event.target as any).value)" class="field-color" />

    <textarea v-else-if="fieldType === 'textarea'" :value="modelValue" @input="update(($event.target as any).value)" class="field-input" rows="3" />

    <input v-else :type="fieldType" :value="modelValue" @input="update(($event.target as any).value)" :min="min" :max="max" :step="step" class="field-input" />
  </div>
</template>

<style scoped>
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-input { flex: 1; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit; }
.field-input:focus { outline: 1px solid #0066cc; border-color: #0066cc; }
.field-color { width: 32px; height: 24px; border: 1px solid #444; border-radius: 4px; padding: 0; cursor: pointer; }
.checkbox-wrap { display: flex; }
.checkbox-wrap input { accent-color: #0066cc; }
</style>
