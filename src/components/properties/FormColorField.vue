<script setup lang="ts">
import { computed } from 'vue'
import HelpHint from './HelpHint.vue'

// Friendly color control for FormBlock styling values.
// Daniela never types raw CSS: she clicks a theme swatch (stored as the
// site CSS token, e.g. "var(--color-paper)") or uses the native color
// picker (stored as a hex). The "avanzado" text box still allows any raw
// CSS string so power-use isn't lost. The stored value is ALWAYS a plain
// CSS string the engine already accepts — no schema change.

const props = defineProps<{
  label: string
  modelValue: string
  help?: string
  // data-test key for the control, e.g. "inputBg" → formblock-style-inputBg
  testKey: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

// Theme tokens the site exposes (see parallax-engine ParallaxSite.vue:
// --color-ink/paper/accent). Stored verbatim as CSS so the form inherits
// the site theme automatically.
const SWATCHES = [
  { token: 'paper', label: 'Papel (claro)', css: 'var(--color-paper)', preview: '#ffffff' },
  { token: 'ink', label: 'Tinta (oscuro)', css: 'var(--color-ink)', preview: '#1a1a1a' },
  { token: 'accent', label: 'Acento', css: 'var(--color-accent)', preview: '#c8a04b' },
]

const value = computed(() => props.modelValue || '')

// Which (if any) theme swatch is currently selected — for the active ring.
const activeToken = computed(() => {
  const v = value.value.trim()
  const hit = SWATCHES.find((s) => s.css === v)
  return hit ? hit.token : null
})

// The native picker only understands hex. If the stored value is a hex use
// it; otherwise show a neutral default but DON'T overwrite the stored CSS
// token until the user actually moves the picker.
const hexForPicker = computed(() => {
  const v = value.value.trim()
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : '#000000'
})

function pickSwatch(css: string) {
  emit('update:modelValue', css)
}

function pickColor(hex: string) {
  emit('update:modelValue', hex)
}

function setRaw(raw: string) {
  emit('update:modelValue', raw)
}
</script>

<template>
  <div class="form-color" :data-test="`formblock-style-${testKey}`">
    <div class="fc-head">
      <label class="fc-label">{{ label }}</label>
      <HelpHint v-if="help" :text="help" :label="label" />
    </div>

    <div class="fc-row">
      <span class="fc-swatches">
        <button
          v-for="s in SWATCHES"
          :key="s.token"
          type="button"
          class="fc-swatch"
          :class="{ 'is-active': activeToken === s.token }"
          :style="{ background: s.preview }"
          :data-test="`formblock-swatch-${testKey}-${s.token}`"
          :title="s.label"
          :aria-label="s.label"
          :aria-pressed="activeToken === s.token"
          @click="pickSwatch(s.css)"
        />
      </span>

      <input
        type="color"
        class="fc-picker"
        :value="hexForPicker"
        :data-test="`formblock-style-${testKey}-picker`"
        :title="`Elegir un color para ${label}`"
        :aria-label="`Elegir un color para ${label}`"
        @input="pickColor(($event.target as any).value)"
      />
    </div>

    <div class="fc-raw">
      <span class="fc-raw-label">avanzado / CSS</span>
      <input
        type="text"
        class="fc-raw-input"
        :value="value"
        placeholder="ej. var(--color-paper) o #ffffff"
        :data-test="`formblock-style-${testKey}-raw`"
        :aria-label="`Valor CSS de ${label}`"
        @input="setRaw(($event.target as any).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.form-color { padding: 6px 0; max-width: 100%; }
.fc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.fc-label { font-size: 11px; color: #999; }
.fc-row { display: flex; align-items: center; gap: 8px; }
.fc-swatches { display: flex; gap: 6px; flex: 1 1 auto; min-width: 0; }
.fc-swatch {
  width: 26px; height: 22px; border-radius: 4px; cursor: pointer;
  border: 1px solid #555; padding: 0; flex: 0 0 auto;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
}
.fc-swatch:hover { border-color: #888; }
.fc-swatch.is-active { outline: 2px solid #0099ff; outline-offset: 1px; border-color: #0099ff; }
.fc-picker {
  width: 32px; height: 24px; flex: 0 0 32px; border: 1px solid #444;
  border-radius: 4px; padding: 0; cursor: pointer; background: #2a2a2a;
}
.fc-raw { display: flex; align-items: center; gap: 8px; margin-top: 6px; max-width: 100%; }
.fc-raw-label { font-size: 10px; color: #777; min-width: 84px; flex-shrink: 0; }
.fc-raw-input {
  flex: 1 1 auto; min-width: 0; width: 100%; box-sizing: border-box;
  background: #242424; border: 1px solid #3a3a3a; border-radius: 4px;
  color: #bbb; padding: 4px 8px; font-size: 11px; font-family: inherit;
}
.fc-raw-input:focus { outline: 1px solid #0066cc; border-color: #0066cc; }
</style>
