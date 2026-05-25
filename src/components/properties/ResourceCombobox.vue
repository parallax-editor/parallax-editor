<script setup lang="ts">
/**
 * ResourceCombobox (TASK #85) — a type-to-filter autocomplete that references
 * the active project's resources (the SAME list the "Recursos" panel shows,
 * sourced from GET /api/projects/:type/:slug/assets).
 *
 * Design contract: it renders the EXACT PropField row markup
 * (`.prop-field > .field-label + .field-control.input-wrap > .field-input`)
 * so the panel-scoped styling rules (`.props-content[...] .prop-field /
 * .field-input`) restyle it byte-for-byte like every other field — no extra
 * styling needed for parity.
 *
 * Behaviour:
 *  - FREE TEXT is ALWAYS allowed (e.g. a Google font name "Playfair Display",
 *    or a hand-typed `images/x.jpg`). It only ever emits the raw string the
 *    user/picker chose; the consumer-prefixing model is untouched.
 *  - Suggestions come from `suggestions` (filtered as-you-type by substring,
 *    case-insensitive). Each may carry a thumbnail URL (images).
 *  - Keyboard: ↓/↑ move the active option, Enter picks it (or, if none active,
 *    keeps the typed value & closes), Esc closes without changing the value.
 */
import { ref, computed, watch, nextTick } from 'vue'
import HelpHint from './HelpHint.vue'

export interface ComboOption {
  /** The string written back (the relative src, or a free value). */
  value: string
  /** Visible label (defaults to value). */
  label?: string
  /** Optional thumbnail URL (images) shown in the dropdown row. */
  thumb?: string
  /** Optional secondary hint (e.g. file size, "Google Fonts"). */
  hint?: string
  /** Optional: render this option's label IN this font-family (preview de
   *  tipografía en el dropdown, como Google Fonts). Requiere que la fuente esté
   *  cargada en el documento del editor. */
  previewFont?: string
}

const props = defineProps<{
  label: string
  modelValue: string
  /** Project resources (already resolved to {value,label,thumb,hint}). */
  suggestions: ComboOption[]
  placeholder?: string
  help?: string
  /** data-test on the <input> so the harness can target it. */
  testId?: string
  /**
   * Asset kind. When set (e.g. 'images', 'fonts', 'audio', 'video'), the
   * combobox HIDES the `<kind>/` folder prefix from the visible input and
   * dropdown rows — Daniela already knows the field is for an image/font/etc.,
   * so seeing `images/foo.jpg` reads as noise. The STORED value is unchanged:
   * picking a suggestion or typing a bare filename ("foo.jpg") emits
   * `<kind>/foo.jpg`; typing a path with `/` or an absolute http(s):// URL
   * passes through verbatim (no prefix added). Omitting `kind` → raw passthrough
   * (the old behaviour used by `family` and any text-only field).
   */
  kind?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const activeIdx = ref(-1)

// ─── Folder-prefix hide (visual only) ──────────────────────────────────────
// When `kind` is set, the input/dropdown SHOW the basename (or a path with
// the kind prefix stripped) so the user doesn't read the redundant
// "images/"/"fonts/"/... directory. The STORE value still carries the full
// relative `<kind>/<file>` path — consumers/preview unchanged.
const PREFIX = computed(() => (props.kind ? `${props.kind}/` : ''))

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

/** Turn a stored value into what the input/dropdown shows. */
function toDisplay(stored: string): string {
  const s = stored ?? ''
  if (!props.kind || !s) return s
  if (isAbsoluteUrl(s)) return s
  if (s.startsWith(PREFIX.value)) return s.slice(PREFIX.value.length)
  return s
}

/** Turn the typed/picked display text into the stored value. */
function toStored(displayed: string): string {
  const s = displayed ?? ''
  if (!props.kind || !s) return s
  if (isAbsoluteUrl(s)) return s
  // If the typed text already includes any slash (a relative path with its
  // own subdir, or already-prefixed), pass through verbatim — don't double
  // up `<kind>/<kind>/…`.
  if (s.includes('/')) return s
  // Bare filename → prefix with the kind dir.
  return `${PREFIX.value}${s}`
}

// Local mirror so typing filters live without committing until blur/pick —
// but we DO emit on every input so the stored value tracks free text exactly
// like a plain field (no data-shape change vs the old raw input). Initialized
// to the DISPLAY form (basename when kind is set).
const draft = ref(toDisplay(props.modelValue ?? ''))
watch(
  () => props.modelValue,
  (v) => {
    const next = toDisplay(v ?? '')
    if (next !== draft.value) draft.value = next
  },
)

const rootRef = ref<HTMLElement | null>(null)

// Filter by case-insensitive substring of the typed text against the
// DISPLAY-shape (stripped prefix) — so typing "criatura" matches
// `images/criatura.jpg` even though the user can't see the `images/` part.
// Empty draft → show all (so it behaves like a normal "pick from list" too).
const filtered = computed<ComboOption[]>(() => {
  const q = draft.value.trim().toLowerCase()
  const list = props.suggestions || []
  if (!q) return list.slice(0, 50)
  return list
    .filter((o) => {
      const hay = `${o.value} ${o.label || ''} ${toDisplay(o.value)} ${toDisplay(o.label || '')}`.toLowerCase()
      return hay.includes(q)
    })
    .slice(0, 50)
})

function onInput(e: Event) {
  draft.value = (e.target as HTMLInputElement).value
  emit('update:modelValue', toStored(draft.value))
  open.value = true
  activeIdx.value = -1
}

function pick(opt: ComboOption) {
  // Picks always reflect the stored shape; the visible input drops the prefix.
  draft.value = toDisplay(opt.value)
  emit('update:modelValue', opt.value)
  open.value = false
  activeIdx.value = -1
}

function onFocus() {
  open.value = true
}

function onBlur() {
  // Delay so a click on an option lands before we close.
  setTimeout(() => {
    open.value = false
    activeIdx.value = -1
  }, 150)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!open.value) open.value = true
    activeIdx.value = Math.min(activeIdx.value + 1, filtered.value.length - 1)
    scrollActiveIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = Math.max(activeIdx.value - 1, -1)
    scrollActiveIntoView()
  } else if (e.key === 'Enter') {
    if (open.value && activeIdx.value >= 0 && filtered.value[activeIdx.value]) {
      e.preventDefault()
      pick(filtered.value[activeIdx.value])
    } else {
      // Keep the free text exactly as typed.
      open.value = false
    }
  } else if (e.key === 'Escape') {
    open.value = false
    activeIdx.value = -1
  }
}

async function scrollActiveIntoView() {
  await nextTick()
  const el = rootRef.value?.querySelector('.rc-opt.active') as HTMLElement | null
  el?.scrollIntoView({ block: 'nearest' })
}
</script>

<template>
  <div class="prop-field rc-field" ref="rootRef">
    <label class="field-label">{{ label }}</label>
    <span class="field-control input-wrap rc-wrap">
      <input
        class="field-input rc-input"
        type="text"
        :value="draft"
        :placeholder="placeholder"
        :data-test="testId"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <ul
        v-if="open && filtered.length"
        class="rc-list"
        :data-test="testId ? testId + '-list' : undefined"
      >
        <li
          v-for="(opt, i) in filtered"
          :key="opt.value + i"
          class="rc-opt"
          :class="{ active: i === activeIdx }"
          :data-test="testId ? testId + '-opt-' + opt.value : undefined"
          @mousedown.prevent="pick(opt)"
          @mouseenter="activeIdx = i"
        >
          <img v-if="opt.thumb" :src="opt.thumb" class="rc-thumb" alt="" />
          <span class="rc-opt-main">
            <span
              class="rc-opt-label"
              :style="opt.previewFont ? { fontFamily: opt.previewFont, fontSize: '15px' } : undefined"
            >{{ toDisplay(opt.label || opt.value) }}</span>
            <span v-if="opt.hint" class="rc-opt-hint">{{ opt.hint }}</span>
          </span>
        </li>
      </ul>
    </span>
    <HelpHint v-if="help" :text="help" :label="label" />
  </div>
</template>

<style scoped>
/* Ship PropField.vue's row contract BYTE-FOR-BYTE here (its scoped .field-*
   styles don't leak into other components, exactly like the hand-rolled
   inline rows in PropertiesPanel re-declare them — see issue #90). This is
   what guarantees pixel parity with every other field regardless of which
   panel (site/theme/element) renders this combobox. */
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-control { flex: 1 1 auto; min-width: 0; }
.field-input { width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit; }
.field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
.input-wrap { position: relative; display: flex; align-items: center; }

.rc-field { position: relative; }
.rc-wrap { position: relative; }
.rc-input { width: 100%; }
.rc-list {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 50;
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
  background: #232323;
  border: 1px solid #454545;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.rc-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #d0d0d0;
}
.rc-opt.active,
.rc-opt:hover {
  background: var(--accent-soft);
  color: #fff;
}
.rc-thumb {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 3px;
  background: repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 10px 10px;
}
.rc-opt-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}
.rc-opt-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-opt-hint {
  font-size: 10px;
  color: #888;
}
</style>
