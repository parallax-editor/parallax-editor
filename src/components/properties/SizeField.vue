<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import HelpHint from './HelpHint.vue'

/**
 * Friendly size control for element.size.width / .height (item #5).
 *
 * The schema stores the value as a string OR number. Powerful forms like
 * `min(46%, 520px)` are confusing for a non-technical user, so this control
 * lets Daniela pick a clear MODE and fills friendly inputs per mode:
 *
 *   • Fijo        → "520px"            (un tamaño exacto en píxeles)
 *   • Porcentual  → "46%"             (relativo al ancho disponible)
 *   • Adaptable   → "min(46%, 520px)" (crece con la pantalla pero topa en X px)
 *   • Auto        → ""                (sin valor; el elemento usa su tamaño natural)
 *
 * It READS/WRITES the same underlying schema string so existing content
 * round-trips. A bare number / numeric string is treated as a PERCENT (matches
 * the engine's units util and PropertiesPanel.sizeUnit). Anything it can't
 * parse (e.g. clamp(), calc(), vw…) falls back to an "avanzado" raw text box so
 * the value is never lost or silently rewritten.
 */
const props = defineProps<{
  label: string
  modelValue: string | number | undefined | null
  help?: string
  testId?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()

type Mode = 'auto' | 'fixed' | 'percent' | 'adaptive' | 'raw'

const MODE_OPTS: { value: Mode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'fixed', label: 'Fijo (px)' },
  { value: 'percent', label: 'Porcentual (%)' },
  { value: 'adaptive', label: 'Adaptable' },
]

// ── Parse the incoming value into a mode + numeric fields ────────────────────
function detect(v: string | number | undefined | null): {
  mode: Mode; px: number; pct: number; raw: string
} {
  const def = { mode: 'auto' as Mode, px: 300, pct: 50, raw: '' }
  if (v == null || v === '') return def
  if (typeof v === 'number') return { ...def, mode: 'percent', pct: v }
  const s = String(v).trim()
  if (s === '') return def
  // min(<pct>%, <px>px) in either order → adaptive.
  const minM = s.match(/^min\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/i)
  if (minM) {
    const a = minM[1].trim()
    const b = minM[2].trim()
    const pctTok = [a, b].find((t) => /%$/.test(t))
    const pxTok = [a, b].find((t) => /px$/i.test(t))
    if (pctTok && pxTok) {
      return {
        ...def,
        mode: 'adaptive',
        pct: parseFloat(pctTok) || def.pct,
        px: parseFloat(pxTok) || def.px,
      }
    }
    return { ...def, mode: 'raw', raw: s }
  }
  // Pure percent.
  const pctM = s.match(/^(-?\d*\.?\d+)%$/)
  if (pctM) return { ...def, mode: 'percent', pct: parseFloat(pctM[1]) }
  // Pure px.
  const pxM = s.match(/^(-?\d*\.?\d+)px$/i)
  if (pxM) return { ...def, mode: 'fixed', px: parseFloat(pxM[1]) }
  // Bare numeric string → percent (engine treats a bare number as %).
  const numM = s.match(/^(-?\d*\.?\d+)$/)
  if (numM) return { ...def, mode: 'percent', pct: parseFloat(numM[1]) }
  // Anything else (clamp/calc/vw…) → keep verbatim in the advanced box.
  return { ...def, mode: 'raw', raw: s }
}

// Local editable state, hydrated from the incoming value.
const mode = ref<Mode>('auto')
const px = ref(300)
const pct = ref(50)
const raw = ref('')

function hydrate(v: string | number | undefined | null) {
  const d = detect(v)
  mode.value = d.mode
  px.value = d.px
  pct.value = d.pct
  raw.value = d.raw
}
hydrate(props.modelValue)

// Re-hydrate when the underlying value changes from OUTSIDE (selection change,
// undo/redo, Claude edit), but NOT when our own emit echoes back. Compare the
// canonical string we'd produce against the incoming one.
watch(
  () => props.modelValue,
  (v) => {
    if (compose() !== normalizeIncoming(v)) hydrate(v)
  },
)

function normalizeIncoming(v: string | number | undefined | null): string {
  if (v == null) return ''
  if (typeof v === 'number') return `${v}%`
  return String(v).trim()
}

// ── Compose the schema string from the current mode + fields ─────────────────
function compose(): string {
  switch (mode.value) {
    case 'auto': return ''
    case 'fixed': return `${round(px.value)}px`
    case 'percent': return `${round(pct.value)}%`
    case 'adaptive': return `min(${round(pct.value)}%, ${round(px.value)}px)`
    case 'raw': return raw.value.trim()
  }
}
function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function emitNow() {
  const out = compose()
  emit('update:modelValue', out === '' ? undefined : out)
}

function setMode(m: Mode) {
  mode.value = m
  emitNow()
}
function onPx(e: Event) { px.value = Number((e.target as HTMLInputElement).value) || 0; emitNow() }
function onPct(e: Event) { pct.value = Number((e.target as HTMLInputElement).value) || 0; emitNow() }
function onRaw(e: Event) { raw.value = (e.target as HTMLInputElement).value; emitNow() }

const tid = computed(() => props.testId || props.label.toLowerCase())

// Helper line per mode.
const helperText = computed(() => {
  switch (mode.value) {
    case 'auto': return 'Usa el tamaño natural del elemento (sin forzar medida).'
    case 'fixed': return 'Tamaño exacto en píxeles. No cambia con el tamaño de la pantalla.'
    case 'percent': return 'Relativo al ancho disponible: crece y encoge con la pantalla.'
    case 'adaptive': return `Crece con la pantalla pero nunca pasa de ${round(px.value)} px.`
    case 'raw': return 'Valor avanzado (CSS) que no encaja en los modos anteriores.'
  }
})
</script>

<template>
  <div class="size-field" :data-test="`size-field-${tid}`">
    <div class="sf-row">
      <label class="field-label">{{ label }}</label>
      <div class="sf-modes" role="group" :aria-label="`Modo de ${label}`">
        <button
          v-for="m in MODE_OPTS"
          :key="m.value"
          type="button"
          class="sf-mode"
          :class="{ active: mode === m.value }"
          :data-test="`size-${tid}-mode-${m.value}`"
          @click="setMode(m.value)"
        >{{ m.label }}</button>
      </div>
      <HelpHint v-if="help" :text="help" :label="label" />
    </div>

    <div class="sf-inputs">
      <template v-if="mode === 'fixed'">
        <span class="sf-input-wrap">
          <input
            class="field-input"
            type="number"
            min="0"
            :value="px"
            :data-test="`size-${tid}-px`"
            :aria-label="`${label} en píxeles`"
            @input="onPx"
          />
          <span class="sf-unit">px</span>
        </span>
      </template>

      <template v-else-if="mode === 'percent'">
        <span class="sf-input-wrap">
          <input
            class="field-input"
            type="number"
            min="0"
            max="100"
            :value="pct"
            :data-test="`size-${tid}-pct`"
            :aria-label="`${label} en porcentaje`"
            @input="onPct"
          />
          <span class="sf-unit">%</span>
        </span>
      </template>

      <template v-else-if="mode === 'adaptive'">
        <span class="sf-input-wrap sf-adaptive">
          <input
            class="field-input"
            type="number"
            min="0"
            max="100"
            :value="pct"
            :data-test="`size-${tid}-pct`"
            :aria-label="`${label}: porcentaje`"
            @input="onPct"
          />
          <span class="sf-unit">%</span>
        </span>
        <span class="sf-sep">máx.</span>
        <span class="sf-input-wrap sf-adaptive">
          <input
            class="field-input"
            type="number"
            min="0"
            :value="px"
            :data-test="`size-${tid}-px`"
            :aria-label="`${label}: máximo en píxeles`"
            @input="onPx"
          />
          <span class="sf-unit">px</span>
        </span>
      </template>

      <template v-else-if="mode === 'raw'">
        <input
          class="field-input sf-raw"
          type="text"
          :value="raw"
          :data-test="`size-${tid}-raw`"
          :aria-label="`${label}: valor avanzado`"
          @input="onRaw"
        />
      </template>
    </div>

    <p class="sf-helper" :data-test="`size-${tid}-helper`">{{ helperText }}</p>
  </div>
</template>

<style scoped>
.size-field { padding: 3px 0; max-width: 100%; }
.sf-row { display: flex; align-items: center; gap: 8px; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.sf-modes { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 auto; min-width: 0; }
.sf-mode {
  background: #2a2a2a; border: 1px solid #444; color: #bbb;
  font-size: 10px; padding: 3px 7px; border-radius: 4px; cursor: pointer;
}
.sf-mode:hover { background: #383838; color: #eee; }
.sf-mode.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }

.sf-inputs { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding-left: 78px; }
.sf-input-wrap { position: relative; display: flex; align-items: center; flex: 1 1 0; min-width: 0; }
.sf-adaptive { flex: 1 1 0; }
.field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 24px 4px 8px; font-size: 12px; font-family: inherit;
  -moz-appearance: textfield;
}
.sf-raw { padding-right: 8px; }
.field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
.field-input[type='number']::-webkit-outer-spin-button,
.field-input[type='number']::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.sf-unit {
  position: absolute; right: 8px; pointer-events: none;
  font-size: 10px; color: #888;
}
.sf-sep { font-size: 10px; color: #888; flex: 0 0 auto; }

.sf-helper { margin: 4px 0 0; padding-left: 78px; font-size: 10px; color: #777; line-height: 1.4; }
</style>
