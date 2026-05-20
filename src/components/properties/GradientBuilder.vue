<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import HelpHint from './HelpHint.vue'
import NumberSlider from './NumberSlider.vue'

/**
 * Friendly gradient builder for `section.background.value` (#100).
 *
 * Daniela is non-technical: instead of a raw CSS string she gets a Lineal/
 * Radial select, an angle slider (Lineal only), and a list of color stops
 * (each = color picker + position % via NumberSlider). The builder generates a
 * valid `linear-gradient(<deg>, c1 p1%, c2 p2%, …)` / `radial-gradient(circle
 * at center, c1 p1%, c2 p2%, …)` and writes it to `modelValue`.
 *
 * An "Avanzado / CSS" expander still exposes the raw string. Incoming raw
 * values are best-effort parsed back into the builder so an already-edited
 * section pops open populated.
 */
const props = defineProps<{ modelValue: string | undefined; help?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

type Stop = { color: string; position: number }

interface ParsedGradient {
  type: 'linear' | 'radial'
  angle: number
  stops: Stop[]
}

const DEFAULT: ParsedGradient = {
  type: 'linear',
  angle: 180,
  stops: [
    { color: '#f5f1e8', position: 0 },
    { color: '#ebe4d6', position: 100 },
  ],
}

// ── Parser (best-effort) ─────────────────────────────────────────────────────
// Recognises `linear-gradient(<angle>?, stop, stop, …)` and `radial-gradient(
// …, stop, stop, …)`. Angles accepted: "<n>deg" (default 180deg if absent).
// Stops: "<color> <pos>%" or just "<color>" (positions inferred evenly).
// Anything we can't parse returns null and the UI falls back to raw input.
function parseGradient(raw: string | undefined): ParsedGradient | null {
  if (!raw || typeof raw !== 'string') return null
  const s = raw.trim()
  const linearM = s.match(/^linear-gradient\s*\(([\s\S]*)\)\s*$/i)
  const radialM = !linearM ? s.match(/^radial-gradient\s*\(([\s\S]*)\)\s*$/i) : null
  if (!linearM && !radialM) return null
  const inner = (linearM ? linearM[1] : radialM![1]).trim()
  const parts = splitTopLevel(inner)
  if (!parts.length) return null

  let type: 'linear' | 'radial' = linearM ? 'linear' : 'radial'
  let angle = 180
  let stopParts = parts

  // First token may be angle (linear) or shape (radial).
  const first = parts[0].trim()
  if (type === 'linear') {
    const aDeg = first.match(/^(-?\d*\.?\d+)\s*deg$/i)
    const aTo = first.match(/^to\s+(top|right|bottom|left)(?:\s+(top|right|bottom|left))?$/i)
    if (aDeg) {
      angle = parseFloat(aDeg[1])
      stopParts = parts.slice(1)
    } else if (aTo) {
      angle = toAngleFromKeyword(aTo[1], aTo[2])
      stopParts = parts.slice(1)
    }
  } else {
    // radial: any non-color leading token is the shape — skip it.
    if (!looksLikeStop(first)) stopParts = parts.slice(1)
  }

  const stops: Stop[] = []
  for (let i = 0; i < stopParts.length; i++) {
    const p = stopParts[i].trim()
    const m = p.match(/^(.+?)(?:\s+(-?\d*\.?\d+)\s*%)?$/)
    if (!m) continue
    const color = m[1].trim()
    const pos = m[2] != null
      ? parseFloat(m[2])
      : Math.round((i / Math.max(1, stopParts.length - 1)) * 100)
    if (!color) continue
    stops.push({ color, position: clampPct(pos) })
  }
  if (stops.length < 2) return null
  return { type, angle: normalizeAngle(angle), stops }
}

// Split a comma-separated list NOT inside nested parens (e.g. rgb(0,0,0)).
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(buf)
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim()) out.push(buf)
  return out
}

function looksLikeStop(token: string): boolean {
  const t = token.trim()
  return /^(#|rgb|rgba|hsl|hsla|[a-z]+)/i.test(t)
}

function toAngleFromKeyword(a: string, b?: string): number {
  const key = `${a || ''} ${b || ''}`.trim().toLowerCase()
  // CSS: "to top" = 0deg, "to right" = 90deg, "to bottom" = 180deg, "to left" = 270deg.
  const map: Record<string, number> = {
    'top': 0,
    'top right': 45,
    'right': 90,
    'bottom right': 135,
    'bottom': 180,
    'bottom left': 225,
    'left': 270,
    'top left': 315,
  }
  return map[key] ?? 180
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}
function normalizeAngle(n: number): number {
  if (!Number.isFinite(n)) return 180
  let v = n % 360
  if (v < 0) v += 360
  return v
}

// ── Builder state ────────────────────────────────────────────────────────────
const showRaw = ref(false)
const state = ref<ParsedGradient>({ ...DEFAULT, stops: DEFAULT.stops.map((s) => ({ ...s })) })
const couldParse = ref<boolean>(true)

// Track our own last emit so the incoming-modelValue watcher doesn't re-parse
// the very string we just wrote (and fight the in-progress user edit).
// MUST be declared BEFORE the watcher — the `immediate:true` watcher fires
// synchronously and a `let` declared below would be in the TDZ.
let lastEmitted = ''

watch(
  () => props.modelValue,
  (v) => {
    if (v === lastEmitted) return
    const parsed = parseGradient(v)
    if (parsed) {
      state.value = parsed
      couldParse.value = true
    } else if (v && v.trim() !== '') {
      couldParse.value = false
    } else {
      couldParse.value = true
    }
  },
  { immediate: true },
)

function buildCss(g: ParsedGradient): string {
  const stops = g.stops.map((s) => `${s.color} ${Math.round(s.position)}%`).join(', ')
  if (g.type === 'radial') return `radial-gradient(circle at center, ${stops})`
  return `linear-gradient(${Math.round(g.angle)}deg, ${stops})`
}

function commit() {
  const css = buildCss(state.value)
  lastEmitted = css
  emit('update:modelValue', css)
}

function setType(next: 'linear' | 'radial') {
  state.value.type = next
  commit()
}
function setAngle(v: number) {
  state.value.angle = normalizeAngle(v)
  commit()
}
function setStopColor(i: number, v: string) {
  state.value.stops[i].color = v
  commit()
}
function setStopPos(i: number, v: number) {
  state.value.stops[i].position = clampPct(v)
  commit()
}
function addStop() {
  // Insert near the middle with a halfway colour-stop position.
  const last = state.value.stops[state.value.stops.length - 1]
  const first = state.value.stops[0]
  const pos = Math.round((first.position + last.position) / 2)
  state.value.stops.push({ color: last.color, position: pos })
  commit()
}
function removeStop(i: number) {
  if (state.value.stops.length <= 2) return
  state.value.stops.splice(i, 1)
  commit()
}

function onRaw(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

const preview = computed(() => buildCss(state.value))
</script>

<template>
  <div class="gb" data-test="gradient-builder">
    <div class="prop-field">
      <label class="field-label">Tipo</label>
      <select
        class="field-input field-control"
        data-test="gradient-type"
        :value="state.type"
        @change="setType(($event.target as any).value)"
      >
        <option value="linear">Lineal</option>
        <option value="radial">Radial</option>
      </select>
      <HelpHint v-if="help" :text="help" label="Gradiente" />
    </div>

    <NumberSlider
      v-if="state.type === 'linear'"
      id="gradient-angle"
      label="Ángulo"
      unit="°"
      :min="0"
      :max="360"
      :step="1"
      :modelValue="state.angle"
      @update:modelValue="setAngle($event)"
    />

    <div class="prop-group-mini">Paradas de color</div>
    <div
      v-for="(s, i) in state.stops"
      :key="i"
      class="stop-row"
      :data-test="`gradient-stop-${i}`"
    >
      <div class="stop-top">
        <span class="stop-color-wrap">
          <input
            type="color"
            class="stop-color"
            :data-test="`gradient-stop-${i}-color-picker`"
            :value="/^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#000000'"
            @input="setStopColor(i, ($event.target as any).value)"
          />
          <input
            type="text"
            class="stop-color-text"
            :data-test="`gradient-stop-${i}-color`"
            :value="s.color"
            @input="setStopColor(i, ($event.target as any).value)"
          />
        </span>
        <button
          class="stop-remove"
          type="button"
          :disabled="state.stops.length <= 2"
          :data-test="`gradient-stop-${i}-remove`"
          title="Eliminar parada"
          @click="removeStop(i)"
        >&times;</button>
      </div>
      <NumberSlider
        :id="`gradient-stop-${i}-pos`"
        label="Pos."
        unit="%"
        :min="0"
        :max="100"
        :step="1"
        :modelValue="s.position"
        @update:modelValue="setStopPos(i, $event)"
      />
    </div>
    <button
      class="stop-add"
      type="button"
      data-test="gradient-stop-add"
      @click="addStop"
    >+ Agregar parada</button>

    <div class="gb-preview" data-test="gradient-preview" :style="{ background: preview }"></div>

    <div class="gb-adv">
      <button
        type="button"
        class="gb-adv-toggle"
        data-test="gradient-advanced-toggle"
        :aria-expanded="showRaw"
        @click="showRaw = !showRaw"
      >{{ showRaw ? 'ocultar avanzado' : 'avanzado / CSS' }}</button>
      <span v-if="!couldParse" class="gb-warn" data-test="gradient-parse-warn">No se pudo interpretar el CSS; edítalo manualmente abajo.</span>
    </div>

    <div v-if="showRaw || !couldParse" class="gb-raw">
      <input
        type="text"
        class="field-input"
        data-test="gradient-raw"
        :value="modelValue || ''"
        placeholder="linear-gradient(180deg, #f5f1e8 0%, #ebe4d6 100%)"
        @input="onRaw"
      />
    </div>
  </div>
</template>

<style scoped>
.gb { padding: 4px 0; }
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-control { flex: 1 1 auto; min-width: 0; }
.field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }

.prop-group-mini { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin: 8px 0 4px; }
/* Stacked stop (#67): top line = swatch + hex + remove; second line = the Pos
   slider full-width. A single line overflowed the ~280px panel. */
.stop-row { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; max-width: 100%; border-bottom: 1px solid #2f2f2f; }
.stop-row:last-of-type { border-bottom: none; }
.stop-top { display: flex; align-items: center; gap: 6px; }
.stop-color-wrap { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0; }
.stop-color { width: 28px; height: 22px; flex: 0 0 auto; border: 1px solid #444; border-radius: 4px; padding: 0; cursor: pointer; background: #2a2a2a; }
.stop-color-text {
  flex: 1 1 auto; min-width: 0; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444;
  border-radius: 4px; color: #e0e0e0; padding: 4px 6px; font-size: 11px; font-family: inherit;
}
.stop-row :deep(.prop-field) { padding: 0; max-width: 100%; }
.stop-row :deep(.field-label) { min-width: 34px; }
/* Custom dropdown arrow (same as PropField) so the select arrow isn't flush. */
select.field-input {
  -webkit-appearance: none; -moz-appearance: none; appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'><path d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
.stop-remove {
  flex: 0 0 auto; width: 22px; height: 22px;
  background: transparent; border: 1px solid #444; color: #aaa;
  border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1;
}
.stop-remove:hover:not(:disabled) { background: #3a2020; color: #ff8a8a; border-color: #5a2a2a; }
.stop-remove:disabled { opacity: 0.4; cursor: default; }
.stop-add {
  margin: 4px 0; background: #2a2a2a; border: 1px dashed #555; color: #aaa;
  padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
}
.stop-add:hover { background: #353535; color: #e0e0e0; border-color: #777; }
.gb-preview {
  height: 28px; border-radius: 4px; border: 1px solid #333;
  margin: 8px 0 4px;
}
.gb-adv { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.gb-adv-toggle {
  background: none; border: none; color: var(--accent-strong);
  font-size: 10px; cursor: pointer; padding: 0; text-decoration: underline;
}
.gb-warn { font-size: 10px; color: #e0a52a; }
.gb-raw { margin-top: 4px; }
</style>
