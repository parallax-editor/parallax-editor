<script setup lang="ts">
// Configurable artboard size (#90). Device-aware: when the toolbar device is
// Desktop it shows PC/Mac/iPad presets; when Mobile it shows phone presets.
// Picking a size (preset or custom width/height) updates the matching reactive
// viewport in the store → live resize of the preview + persisted across reloads.
import { computed, ref, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  state,
  VIEWPORTS,
  MOBILE_PRESETS,
  DESKTOP_PRESETS,
  setMobileViewport,
  setDesktopViewport,
} from '../../stores/editor'

const { t } = useI18n()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
// Teleport menu out of the toolbar's stacking context (z-index:100 there
// caps any internal child below 10000, so the SelectionOverlay would paint
// over our popover even with a high z-index inside the toolbar). Track the
// trigger's rect so the popover sits just below the button.
const popoverPos = ref({ top: 0, left: 0 })
function updatePopoverPos() {
  const root = rootRef.value
  if (!root) return
  const r = root.getBoundingClientRect()
  popoverPos.value = { top: r.bottom + 6, left: r.left }
}

const isMobile = computed(() => state.deviceMode === 'mobile')
const presets = computed(() => (isMobile.value ? MOBILE_PRESETS : DESKTOP_PRESETS))
const vp = computed(() => (isMobile.value ? VIEWPORTS.mobile : VIEWPORTS.desktop))
const width = computed(() => vp.value.width)
const height = computed(() => vp.value.height)
const menuTitle = computed(() => (isMobile.value ? t('mobileSize.titleMobile') : t('mobileSize.titleDesktop')))

function applySize(w: number, h: number) {
  if (isMobile.value) setMobileViewport(w, h)
  else setDesktopViewport(w, h)
}

// Which preset (if any) matches the current size — drives the check mark and
// whether "Personalizado" is the active row.
const activePresetId = computed(() => {
  const match = presets.value.find(
    (p) => p.width === width.value && p.height === height.value,
  )
  return match ? match.id : null
})
const isCustom = computed(() => activePresetId.value === null)

// Custom inputs are seeded from the live size whenever the panel opens.
const customW = ref(width.value)
const customH = ref(height.value)

function toggle() {
  open.value = !open.value
  if (open.value) {
    customW.value = width.value
    customH.value = height.value
    nextTick(() => {
      updatePopoverPos()
      document.addEventListener('mousedown', onDocMouseDown, true)
      window.addEventListener('resize', updatePopoverPos)
      window.addEventListener('scroll', updatePopoverPos, true)
    })
  } else {
    document.removeEventListener('mousedown', onDocMouseDown, true)
    window.removeEventListener('resize', updatePopoverPos)
    window.removeEventListener('scroll', updatePopoverPos, true)
  }
}

function close() {
  open.value = false
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('resize', updatePopoverPos)
  window.removeEventListener('scroll', updatePopoverPos, true)
}

function onDocMouseDown(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) close()
}

function pickPreset(id: string) {
  const p = presets.value.find((x) => x.id === id)
  if (!p) return
  applySize(p.width, p.height)
  close()
}

function applyCustom() {
  applySize(Number(customW.value), Number(customH.value))
  // Keep the panel open so she can tweak; size already applied live.
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
})
</script>

<template>
  <div class="mobile-size" ref="rootRef">
    <button
      class="size-btn"
      type="button"
      :aria-expanded="open"
      :title="t('mobileSize.tooltip')"
      data-test="mobile-size-toggle"
      @click="toggle"
    >
      <span class="dev-icon" aria-hidden="true">{{ isMobile ? '📱' : '🖥' }}</span>
      <span class="size-value" data-test="mobile-size-value">{{ width }}×{{ height }}</span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <Teleport to="body">
    <div
      v-if="open"
      class="size-menu"
      role="menu"
      data-test="mobile-size-menu"
      :style="{ top: popoverPos.top + 'px', left: popoverPos.left + 'px' }"
    >
      <div class="menu-title">{{ menuTitle }}</div>
      <button
        v-for="p in presets"
        :key="p.id"
        type="button"
        :class="['menu-item', { active: activePresetId === p.id }]"
        role="menuitemradio"
        :aria-checked="activePresetId === p.id"
        :data-test="`mobile-preset-${p.id}`"
        @click="pickPreset(p.id)"
      >
        <span class="check">{{ activePresetId === p.id ? '✓' : '' }}</span>
        <span class="item-label">{{ p.label }}</span>
        <span class="item-dim">{{ p.width }}×{{ p.height }}</span>
      </button>

      <div class="menu-sep" />

      <div :class="['custom-row', { active: isCustom }]">
        <span class="check">{{ isCustom ? '✓' : '' }}</span>
        <span class="item-label">{{ t('mobileSize.custom') }}</span>
        <div class="custom-inputs">
          <input
            type="number"
            v-model.number="customW"
            min="200"
            max="3840"
            :aria-label="t('mobileSize.customWidth')"
            data-test="mobile-custom-width"
            @keydown.enter="applyCustom"
          />
          <span class="times">×</span>
          <input
            type="number"
            v-model.number="customH"
            min="200"
            max="3840"
            :aria-label="t('mobileSize.customHeight')"
            data-test="mobile-custom-height"
            @keydown.enter="applyCustom"
          />
          <button
            type="button"
            class="apply-btn"
            data-test="mobile-custom-apply"
            @click="applyCustom"
          >{{ t('mobileSize.apply') }}</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mobile-size { position: relative; display: inline-flex; }
.size-btn { display: inline-flex; align-items: center; gap: 5px; background: #333; border: 1px solid #444; color: #ccc; height: 24px; padding: 0 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.size-btn:hover { background: #444; color: #fff; }
.dev-icon { font-size: 12px; }
.size-value { font-family: monospace; }
.caret { font-size: 9px; opacity: 0.8; }

.size-menu { position: fixed; z-index: 100000; min-width: 248px; background: #2b2b2b; border: 1px solid #444; border-radius: 6px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); max-height: 60vh; overflow-y: auto; }
.menu-title { font-size: 11px; color: #888; padding: 2px 8px 6px; font-weight: 600; }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: none; color: #ccc; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; text-align: left; }
.menu-item:hover { background: #383838; color: #fff; }
.menu-item.active { color: #fff; }
.check { width: 12px; color: var(--accent-strong); font-size: 12px; flex-shrink: 0; }
.item-label { flex: 1; }
.item-dim { font-family: monospace; color: #888; font-size: 11px; }
.menu-sep { height: 1px; background: #444; margin: 6px 4px; }
.custom-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; flex-wrap: wrap; }
.custom-row.active { color: #fff; }
.custom-inputs { display: flex; align-items: center; gap: 4px; width: 100%; margin-top: 6px; padding-left: 20px; }
.custom-inputs input { width: 64px; background: #1f1f1f; border: 1px solid #444; color: #eee; border-radius: 4px; padding: 3px 6px; font-size: 12px; font-family: monospace; }
.custom-inputs input:focus { outline: none; border-color: var(--accent-strong); }
.times { color: #888; }
.apply-btn { background: var(--accent); border: none; color: var(--accent-fg); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: background .12s ease; }
.apply-btn:hover { background: var(--accent-hover); }
.apply-btn:active { background: var(--accent); }
.apply-btn:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
</style>
