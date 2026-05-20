<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { state } from '../../stores/editor'

// ── TASK 2 (#81): editor-owned cursor effect, gap-free ─────────────────────
// The engine's <CustomCursor> is `position: fixed` and uses the raw pointer
// `clientX/clientY`. That's correct on the REAL sites, but in the editor the
// engine renders INSIDE `.preview-frame` which has `transform: scale(zoom)`
// (+ a translated `.pan-wrapper` ancestor + inner `.preview-scroll`). Per the
// CSS spec a transformed ancestor becomes the containing block for `fixed`
// descendants, so the engine's `left:clientX; top:clientY` is interpreted in
// the SCALED/TRANSLATED frame space → the circle is offset, and the offset
// grows with zoom / pan / scroll. The engine repo must not be touched.
//
// Fix (the task's accepted "hide-in-edit + correct in Preview" option):
//   • The engine CustomCursor is stripped from the preview copy entirely
//     (EditorCanvas drops `cursor` from `previewSite`), so the offset element
//     never renders in EITHER mode.
//   • Edición: a following-circle on a design surface is just noise (the OS
//     cursor + selection tooling is what matters) → no cursor shown.
//   • Preview: THIS component reproduces the engine's CustomCursor visual
//     contract (color/size/hoverScale/blendMode) but lives OUTSIDE the
//     transformed wrapper (sibling of SelectionOverlay) and is positioned with
//     the REAL viewport clientX/clientY. Because nothing between it and the
//     viewport is transformed/scrolled, it sits EXACTLY under the pointer at
//     any zoom / pan / scroll — no gap, ever.

const props = defineProps<{ canvasRef: HTMLElement | null }>()

// Mirrors the engine cursorSchema defaults (parallax-engine/src/schema.ts).
const cfg = computed(() => {
  const c: any = (state.site as any)?.cursor
  if (!c || !c.enabled) return null
  return {
    color: typeof c.color === 'string' ? c.color : '#000',
    size: typeof c.size === 'number' ? c.size : 20,
    hoverScale: typeof c.hoverScale === 'number' ? c.hoverScale : 2,
    blendMode: typeof c.blendMode === 'string' ? c.blendMode : 'difference',
  }
})

// Only in Preview (matches the real-site experience) and only when the active
// site actually enables a cursor.
const active = computed(() => state.previewMode === 'preview' && !!cfg.value)

const x = ref(0)
const y = ref(0)
const visible = ref(false)
const hovering = ref(false)

function overCanvas(clientX: number, clientY: number): boolean {
  const el = props.canvasRef
  if (!el) return false
  const r = el.getBoundingClientRect()
  return (
    clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
  )
}

function onMove(e: MouseEvent) {
  // Real viewport coords — the element is NOT inside any transformed/scrolled
  // ancestor, so these map 1:1 to the pointer (zero offset).
  x.value = e.clientX
  y.value = e.clientY
  visible.value = overCanvas(e.clientX, e.clientY)
  // Mirror the engine's interactive-hover scale (same selector contract).
  const t = e.target as HTMLElement | null
  hovering.value = !!t && !!t.closest?.('[data-parallax-interactive]')
}

function onLeave() {
  visible.value = false
}

onMounted(() => {
  if (typeof window === 'undefined') return
  document.addEventListener('mousemove', onMove, { passive: true })
  document.addEventListener('mouseleave', onLeave)
})

onUnmounted(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseleave', onLeave)
})

const style = computed(() => {
  const c = cfg.value
  if (!c) return {}
  return {
    left: `${x.value}px`,
    top: `${y.value}px`,
    width: `${c.size}px`,
    height: `${c.size}px`,
    backgroundColor: c.color,
    mixBlendMode: c.blendMode as any,
    transform: `translate(-50%, -50%) scale(${hovering.value ? c.hoverScale : 1})`,
  }
})
</script>

<template>
  <div
    v-if="active && visible"
    class="preview-cursor"
    data-test="preview-cursor"
    :style="style"
  />
</template>

<style scoped>
.preview-cursor {
  position: fixed;
  border-radius: 50%;
  pointer-events: none;
  z-index: 10001;
  transition: transform 0.15s ease-out, width 0.15s ease-out, height 0.15s ease-out;
  will-change: left, top, transform;
}
</style>
