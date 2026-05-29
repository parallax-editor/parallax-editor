<script setup lang="ts">
// ─── Section / Layer highlight (TASK #78) ──────────────────────────────────
//
// SelectionOverlay only draws a box when an ELEMENT is selected (it keys off
// the selected node's data-parallax-id). Sections and layers have no
// data-parallax-id, so selecting them in the CAPAS tree drew nothing on the
// canvas. This overlay fills that gap: when the tree selection is a SECTION or
// LAYER it draws a NON-interactive dashed outline (visually distinct from the
// solid element selection box) over that section's / layer's rendered bounds,
// with a small "Sección: <id>" / "Capa: <id>" label.
//
// Geometry is derived EXACTLY like SelectionOverlay: read the real
// getBoundingClientRect of the rendered DOM node, express it relative to the
// .editor-canvas element, re-measured on the same scroll-key / zoom / pan /
// device / previewNonce triggers. It is pointer-events:none so it never
// interferes with element selection, the selection overlay, grid, pan or clamp.
//
// View-aware by construction: EditorCanvas pre-resolves the ACTIVE view into
// copy.sections before handing it to the engine, so the engine renders exactly
// the active view's tree in document order — index-based mapping matches the
// active view's tree the CAPAS panel shows.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state, isGlobalPath, resizeSectionWithRecalc, activeSectionsRoot } from '../../stores/editor'

const props = defineProps<{
  canvasRef: HTMLElement | null
  scrollKey?: number
}>()

// Parse the selected path → which section/layer (by index) is selected, or
// null when the selection is an element / global / nothing. Paths are
// view-relative: "sections.0" (section) | "sections.0.layers.1" (layer).
const target = computed<
  null | { kind: 'section' | 'layer'; sectionIndex: number; layerIndex?: number; id: string }
>(() => {
  const p = state.selectedPath
  if (!p || isGlobalPath(p) || !state.site) return null
  const parts = p.split('.')
  if (parts.length === 2 && parts[0] === 'sections') {
    const si = Number(parts[1])
    if (!Number.isInteger(si)) return null
    const node = activeSectionAt(si)
    return { kind: 'section', sectionIndex: si, id: node?.id || `Sección ${si + 1}` }
  }
  if (parts.length === 4 && parts[0] === 'sections' && parts[2] === 'layers') {
    const si = Number(parts[1])
    const li = Number(parts[3])
    if (!Number.isInteger(si) || !Number.isInteger(li)) return null
    const node = activeSectionAt(si)?.layers?.[li]
    return { kind: 'layer', sectionIndex: si, layerIndex: li, id: node?.id || `Capa ${li + 1}` }
  }
  return null
})

// The active view's section node at index si (legacy → site.sections;
// independent → site.views[deviceMode].sections), mirroring activeSections().
function activeSectionAt(si: number): any {
  const site = state.site as any
  if (!site) return null
  let sections: any[]
  if (site.views) {
    sections =
      state.deviceMode === 'mobile'
        ? site.views.mobile?.sections ?? site.views.desktop?.sections ?? []
        : site.views.desktop?.sections ?? []
  } else {
    sections = site.sections ?? []
  }
  return sections?.[si] ?? null
}

const bounds = ref<{ left: number; top: number; width: number; height: number } | null>(null)
let rafId = 0

// Resolve the selected section/layer to its rendered DOM node. Sections render
// (in document order) as `.parallax-section`; the engine wraps each section in
// an outer div, so `.parallax-section` is the section box itself. We index into
// the live NodeList by the same order the active-view tree uses.
//
// A LAYER is `position:absolute; inset:0` of its section — it has no own
// position/size, and the `.parallax-layer` element additionally carries a
// parallax transform (depth/scroll → translateY), so measuring it would shift
// the highlight per-layer (layers of different depth in the SAME section would
// draw at different y). A layer's LOGICAL bounds == its section's bounds, so we
// deliberately measure the CONTAINING SECTION for a layer selection: every
// layer in a section then highlights the same, section-sized box regardless of
// depth/scroll. (The label/styling stay layer-flavored via target.kind.)
function findDomNode(): HTMLElement | null {
  const t = target.value
  if (!t || !props.canvasRef) return null
  const sections = props.canvasRef.querySelectorAll<HTMLElement>('.parallax-section')
  const sec = sections[t.sectionIndex]
  if (!sec) return null
  // Both section AND layer selections measure the section box (a layer fills
  // its section); only the kind-driven label/colors differ.
  return sec
}

function updateBounds() {
  if (!target.value || !props.canvasRef) {
    bounds.value = null
    return
  }
  const node = findDomNode()
  if (!node) {
    bounds.value = null
    return
  }
  const r = node.getBoundingClientRect()
  const c = props.canvasRef.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) {
    bounds.value = null
    return
  }
  bounds.value = {
    left: r.left - c.left,
    top: r.top - c.top,
    width: r.width,
    height: r.height,
  }
}

function scheduleUpdate() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(updateBounds)
}

// Same re-measure triggers SelectionOverlay uses: selection, site, zoom, pan,
// device, preview scroll, preview re-mount.
watch(
  () => [
    state.selectedPath,
    state.site,
    state.canvasZoom,
    state.canvasPan.x,
    state.canvasPan.y,
    state.deviceMode,
    props.scrollKey,
    state.previewNonce,
  ],
  scheduleUpdate,
  { deep: true },
)

// "Reiniciar mesa" destroys/recreates the preview DOM: poll a few frames until
// the recreated section/layer node is measurable again (mirrors
// SelectionOverlay's previewNonce handling).
watch(
  () => state.previewNonce,
  () => {
    if (!target.value) return
    bounds.value = null
    let tries = 0
    const tick = () => {
      updateBounds()
      tries++
      if (!bounds.value && tries < 40) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  },
)

let ro: ResizeObserver | null = null

onMounted(() => {
  scheduleUpdate()
  window.addEventListener('resize', scheduleUpdate)
  if (props.canvasRef && 'ResizeObserver' in window) {
    ro = new ResizeObserver(scheduleUpdate)
    ro.observe(props.canvasRef)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', scheduleUpdate)
  if (ro) ro.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
})

const boxStyle = computed(() => {
  if (!bounds.value) return { display: 'none' }
  return {
    position: 'absolute' as const,
    left: `${bounds.value.left}px`,
    top: `${bounds.value.top}px`,
    width: `${bounds.value.width}px`,
    height: `${bounds.value.height}px`,
    pointerEvents: 'none' as const,
  }
})

const labelText = computed(() => {
  const t = target.value
  if (!t) return ''
  return t.kind === 'section' ? `Sección: ${t.id}` : `Capa: ${t.id}`
})

// ─── Section resize handle (Phase 5) ─────────────────────────────────────────
//
// When the target is a SECTION, render a draggable bottom-edge handle that
// resizes the section's height. Mouse → screen px; divided by canvasZoom to
// get artboard px. Live preview mutates state.site directly through the
// store helper, which also recomputes every child element's % positions
// against the new height so their absolute pixel locations stay put.
// pushUndo is fired ONLY on the first move event so the whole gesture is one
// undo step (mousedown alone shouldn't already burn an undo if the user lets
// go without dragging).
const MIN_SECTION_HEIGHT_PX = 80

const isResizing = ref(false)
let resizeStartScreenY = 0
let resizeStartHeightPx = 0
let originalSectionSnapshot: any = null
let resizeSectionPath: string | null = null
let undoPushedThisGesture = false

function sectionDotPath(sectionIndex: number): string {
  return `${activeSectionsRoot()}.${sectionIndex}`
}

function getActiveSectionObject(sectionIndex: number): any {
  return activeSectionAt(sectionIndex)
}

function onResizeHandleDown(e: PointerEvent) {
  const t = target.value
  if (!t || t.kind !== 'section' || !bounds.value) return
  e.preventDefault()
  e.stopPropagation()
  const section = getActiveSectionObject(t.sectionIndex)
  if (!section) return
  originalSectionSnapshot = JSON.parse(JSON.stringify(section))
  resizeSectionPath = sectionDotPath(t.sectionIndex)
  resizeStartHeightPx = bounds.value.height / (state.canvasZoom || 1)
  resizeStartScreenY = e.clientY
  undoPushedThisGesture = false
  isResizing.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onResizeHandleMove(e: PointerEvent) {
  if (!isResizing.value || !originalSectionSnapshot || !resizeSectionPath) return
  const deltaScreen = e.clientY - resizeStartScreenY
  const deltaArtboard = deltaScreen / (state.canvasZoom || 1)
  const newHeightPx = Math.max(MIN_SECTION_HEIGHT_PX, resizeStartHeightPx + deltaArtboard)
  // First move of the gesture: capture undo state. Subsequent moves reuse it.
  const opts = undoPushedThisGesture ? {} : { pushUndo: true }
  resizeSectionWithRecalc(
    resizeSectionPath,
    originalSectionSnapshot,
    resizeStartHeightPx,
    newHeightPx,
    opts,
  )
  undoPushedThisGesture = true
}

function onResizeHandleUp(e: PointerEvent) {
  if (!isResizing.value) return
  isResizing.value = false
  originalSectionSnapshot = null
  resizeSectionPath = null
  undoPushedThisGesture = false
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    /* releasePointerCapture can throw if the capture was already lost */
  }
}
</script>

<template>
  <div
    v-if="bounds && target"
    class="sl-highlight"
    :class="target.kind"
    :style="boxStyle"
    data-test="section-layer-highlight"
    :data-kind="target.kind"
  >
    <div class="sl-fill" />
    <div class="sl-border" />
    <div class="sl-label" :data-test="`section-layer-label-${target.kind}`">{{ labelText }}</div>
    <div
      v-if="target.kind === 'section'"
      class="sl-resize-handle"
      :class="{ 'is-resizing': isResizing }"
      data-test="section-resize-handle"
      title="Arrastra para cambiar la altura. Los elementos mantienen su posición relativa."
      @pointerdown="onResizeHandleDown"
      @pointermove="onResizeHandleMove"
      @pointerup="onResizeHandleUp"
      @pointercancel="onResizeHandleUp"
    >
      <span class="sl-resize-grip" />
    </div>
  </div>
</template>

<style scoped>
/* Distinct from the SOLID blue element selection box: a DASHED accent outline
   + a faint fill so a section/layer reads as a region, not a draggable element.
   Below the element selection box's z-index (10000) so element selection always
   wins visually; pointer-events:none → never blocks selection/grid/pan. */
.sl-highlight { z-index: 9000; }
.sl-fill { position: absolute; inset: 0; pointer-events: none; }
.sl-border { position: absolute; inset: 0; pointer-events: none; }
.sl-highlight.section .sl-border { border: 2px dashed #b06bff; }
.sl-highlight.section .sl-fill { background: rgba(176, 107, 255, 0.07); }
.sl-highlight.layer .sl-border { border: 2px dashed #2ad1c9; }
.sl-highlight.layer .sl-fill { background: rgba(42, 209, 201, 0.06); }
.sl-label {
  position: absolute; top: 0; left: 0;
  font-size: 11px; font-weight: 600;
  padding: 1px 6px; border-radius: 0 0 4px 0;
  white-space: nowrap; pointer-events: none;
  color: #1a1a1a;
}
.sl-highlight.section .sl-label { background: #b06bff; }
.sl-highlight.layer .sl-label { background: #2ad1c9; }

/* Resize handle: a thin, interactive band along the section's BOTTOM edge.
   Sits on top of the overlay (z-index above the dashed border) and overrides
   the parent's `pointer-events:none` so it can capture pointer events without
   the rest of the overlay swallowing element selection. The cursor is the
   standard ns-resize so the affordance reads at a glance. */
.sl-resize-handle {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -6px;
  height: 12px;
  cursor: ns-resize;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  touch-action: none;
}
.sl-resize-handle:hover .sl-resize-grip,
.sl-resize-handle.is-resizing .sl-resize-grip {
  background: #b06bff;
  width: 56px;
}
.sl-resize-grip {
  display: block;
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: rgba(176, 107, 255, 0.7);
  transition: width 0.12s ease, background 0.12s ease;
}
</style>
