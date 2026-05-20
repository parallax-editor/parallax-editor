<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { state, getAtPath } from '../../stores/editor'

// ─── Smart alignment guides (GAP6) ─────────────────────────────────────────
//
// Magenta dashed lines that appear while an element is selected/dragged and
// its edges or center line up with another element's edges or center —
// Illustrator-style alignment feedback.
//
// Design choices (mirrors SelectionOverlay so it can't drift out of sync):
//   • Source of truth = the RENDERED DOM rects of every [data-parallax-id]
//     element, NOT site.json positions. This is automatically:
//       – view-aware: only the ACTIVE view's tree is painted (EditorCanvas
//         pre-resolves resolveSections(site, deviceMode)), so iterating the
//         painted nodes is exactly "the active view". The old code walked
//         state.site.sections directly → wrong/empty in v1.1 independent
//         `views` mode. This has no such bug.
//       – correct at any zoom / pan / scroll / device frame (real on-screen
//         boxes), like the SelectionOverlay rect derivation.
//   • Lines are expressed in CANVAS-LOCAL px and the component is mounted
//     OUTSIDE the transformed pan-wrapper (same as SelectionOverlay), so it
//     is never double-transformed.
//   • Compares edges (left/right, top/bottom) AND centers (cx/cy) of the
//     selected element against every OTHER element. A threshold in SCREEN px
//     keeps the feel consistent across zoom levels.
//   • Purely presentational: pointer-events:none, no writes, no snap. It
//     cannot interfere with selection, grid, pan or the drag/clamp logic.
//   • EditorCanvas only mounts this in Edición mode, so it's hidden in
//     Preview (the engine owns the canvas there).

const props = defineProps<{
  canvasRef: HTMLElement | null
  // Re-measure trigger (preview-frame scroll), same as SelectionOverlay.
  scrollKey?: number
}>()

interface GuideLine {
  // 'v' = vertical line at canvas-local x; 'h' = horizontal at canvas-local y.
  type: 'v' | 'h'
  pos: number
}

const lines = ref<GuideLine[]>([])
let rafId = 0

// Alignment threshold in SCREEN px. Small enough to mean "really aligned",
// large enough to catch a drag that's visually snapped by eye.
const THRESHOLD = 3

function selectedId(): string | null {
  if (!state.selectedPath) return null
  const sel = getAtPath(state.selectedPath)
  return sel?.id || null
}

function computeGuides() {
  rafId = 0
  if (!props.canvasRef || !state.selectedPath || state.previewMode !== 'edit') {
    if (lines.value.length) lines.value = []
    return
  }
  const id = selectedId()
  if (!id) {
    if (lines.value.length) lines.value = []
    return
  }
  const selEl = document.querySelector<HTMLElement>(`[data-parallax-id="${id}"]`)
  if (!selEl) {
    if (lines.value.length) lines.value = []
    return
  }

  const canvasRect = props.canvasRef.getBoundingClientRect()
  const sr = selEl.getBoundingClientRect()
  // Canvas-local key x/y values of the selected element.
  const sLeft = sr.left - canvasRect.left
  const sRight = sr.right - canvasRect.left
  const sCx = sLeft + sr.width / 2
  const sTop = sr.top - canvasRect.top
  const sBottom = sr.bottom - canvasRect.top
  const sCy = sTop + sr.height / 2

  const vSet = new Set<number>()
  const hSet = new Set<number>()

  const all = props.canvasRef.querySelectorAll<HTMLElement>('[data-parallax-id]')
  all.forEach((el) => {
    if (el === selEl || el.getAttribute('data-parallax-id') === id) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return
    const oLeft = r.left - canvasRect.left
    const oRight = r.right - canvasRect.left
    const oCx = oLeft + r.width / 2
    const oTop = r.top - canvasRect.top
    const oBottom = r.bottom - canvasRect.top
    const oCy = oTop + r.height / 2

    // Vertical guides: any selected vertical key near any other vertical key.
    for (const s of [sLeft, sCx, sRight]) {
      for (const o of [oLeft, oCx, oRight]) {
        if (Math.abs(s - o) <= THRESHOLD) vSet.add(Math.round(o))
      }
    }
    // Horizontal guides.
    for (const s of [sTop, sCy, sBottom]) {
      for (const o of [oTop, oCy, oBottom]) {
        if (Math.abs(s - o) <= THRESHOLD) hSet.add(Math.round(o))
      }
    }
  })

  const next: GuideLine[] = []
  vSet.forEach((x) => next.push({ type: 'v', pos: x }))
  hSet.forEach((y) => next.push({ type: 'h', pos: y }))

  // Avoid pointless reactivity churn when nothing changed.
  const a = JSON.stringify(next)
  const b = JSON.stringify(lines.value)
  if (a !== b) lines.value = next
}

function schedule() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(computeGuides)
}

// Re-measure on the SAME signals SelectionOverlay uses, so guides track a live
// drag (position writes mutate state.site → deep watch fires every frame).
watch(
  () => [
    state.selectedPath,
    state.site,
    state.canvasZoom,
    state.canvasPan.x,
    state.canvasPan.y,
    state.deviceMode,
    state.previewMode,
    props.scrollKey,
    state.previewNonce,
  ],
  schedule,
  { deep: true },
)

onMounted(() => {
  schedule()
  window.addEventListener('resize', schedule)
})
onUnmounted(() => {
  window.removeEventListener('resize', schedule)
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<template>
  <svg
    v-if="lines.length > 0"
    class="smart-guides"
    data-test="smart-guides"
    xmlns="http://www.w3.org/2000/svg"
  >
    <line
      v-for="(g, i) in lines"
      :key="i"
      :x1="g.type === 'v' ? g.pos : 0"
      :y1="g.type === 'h' ? g.pos : 0"
      :x2="g.type === 'v' ? g.pos : '100%'"
      :y2="g.type === 'h' ? g.pos : '100%'"
      stroke="#ff00ff"
      stroke-width="1"
      stroke-dasharray="4,4"
      opacity="0.7"
    />
  </svg>
</template>

<style scoped>
/* Sits above the preview but below the SelectionOverlay (z-index 10000), so
   handles stay clickable. pointer-events:none → never blocks selection / pan
   / scroll / the drag. Positioned over the (untransformed) canvas element. */
.smart-guides {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 9990;
}
</style>
