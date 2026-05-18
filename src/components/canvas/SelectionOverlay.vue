<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state, getAtPath, setAtPath, isPathLocked, VIEWPORTS, GRID_PERCENT } from '../../stores/editor'

const props = defineProps<{
  canvasRef: HTMLElement | null
  zoom: number
  scrollKey?: number
}>()

// Box in CANVAS-LOCAL coordinates (relative to the .editor-canvas element),
// so the overlay is correct regardless of the pan-wrapper transform.
const bounds = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const isDragging = ref(false)
const dragType = ref<'move' | 'resize' | 'rotate' | null>(null)
const dragStart = ref({ x: 0, y: 0 })
const dragOriginal = ref<any>({})
const activeHandle = ref<string | null>(null)
let rafId = 0

function findDomElement(): HTMLElement | null {
  if (!state.selectedPath) return null
  const selected = getAtPath(state.selectedPath)
  if (!selected?.id) return null
  return document.querySelector(`[data-parallax-id="${selected.id}"]`)
}

/**
 * Derive the selection rect from the ACTUAL rendered DOM element, expressed
 * relative to the canvas container. We do NOT recompute from JSON position,
 * so this stays correct at any zoom / artboard offset / device-frame size,
 * and once the engine positioning fix lands it tracks automatically.
 */
function updateBounds() {
  if (!state.selectedPath || !props.canvasRef) { bounds.value = null; return }
  const el = state.site ? findDomElement() : null
  if (!el) { bounds.value = null; return }
  const elRect = el.getBoundingClientRect()
  const canvasRect = props.canvasRef.getBoundingClientRect()
  bounds.value = {
    left: elRect.left - canvasRect.left,
    top: elRect.top - canvasRect.top,
    width: elRect.width,
    height: elRect.height,
  }
}

function scheduleUpdate() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(updateBounds)
}

// Re-measure when selection, site, zoom, pan, device or preview scroll change.
watch(
  () => [state.selectedPath, state.site, state.canvasZoom, state.canvasPan.x, state.canvasPan.y, state.deviceMode, props.scrollKey],
  scheduleUpdate,
  { deep: true },
)

let ro: ResizeObserver | null = null

onMounted(() => {
  scheduleUpdate()
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('resize', scheduleUpdate)
  if (props.canvasRef && 'ResizeObserver' in window) {
    ro = new ResizeObserver(scheduleUpdate)
    ro.observe(props.canvasRef)
  }
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('resize', scheduleUpdate)
  if (ro) ro.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
})

// ─── Drag handlers ──────────────────────────────────────────

// A locked node can't be moved/resized/rotated on the canvas. We block the
// drag at its start (the overlay still shows so the user sees it's selected,
// but the box reads as locked and no handle does anything).
const isLocked = computed(() => isPathLocked(state.selectedPath))

function startMove(e: MouseEvent) {
  if (state.tool !== 'select' || !state.selectedPath || isLocked.value) return
  e.stopPropagation()
  isDragging.value = true
  dragType.value = 'move'
  dragStart.value = { x: e.clientX, y: e.clientY }
  const el = getAtPath(state.selectedPath)
  dragOriginal.value = {
    x: typeof el?.position?.x === 'number' ? el.position.x : 50,
    y: typeof el?.position?.y === 'number' ? el.position.y : 50,
  }
}

function startResize(e: MouseEvent, handle: string) {
  if (isLocked.value) return
  e.stopPropagation()
  isDragging.value = true
  dragType.value = 'resize'
  activeHandle.value = handle
  dragStart.value = { x: e.clientX, y: e.clientY }
  const el = getAtPath(state.selectedPath!)
  dragOriginal.value = {
    width: typeof el?.size?.width === 'number' ? el.size.width : 20,
    height: typeof el?.size?.height === 'number' ? el.size.height : 20,
  }
}

function startRotate(e: MouseEvent) {
  if (isLocked.value) return
  e.stopPropagation()
  isDragging.value = true
  dragType.value = 'rotate'
  dragStart.value = { x: e.clientX, y: e.clientY }
  const el = getAtPath(state.selectedPath!)
  dragOriginal.value = { rotation: el?.rotation || 0 }
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value || !state.selectedPath) return

  // Screen px → artboard px: divide by the live zoom factor.
  const dx = (e.clientX - dragStart.value.x) / props.zoom
  const dy = (e.clientY - dragStart.value.y) / props.zoom

  const vp = VIEWPORTS[state.deviceMode]

  if (dragType.value === 'move') {
    let newX = dragOriginal.value.x + (dx / vp.width) * 100
    let newY = dragOriginal.value.y + (dy / vp.height) * 100

    if (state.snapToGrid) {
      // Snap to the SAME % step the visual grid overlay draws (GRID_PERCENT),
      // so the element lands exactly on the lines Daniela sees.
      newX = Math.round(newX / GRID_PERCENT) * GRID_PERCENT
      newY = Math.round(newY / GRID_PERCENT) * GRID_PERCENT
    }

    setAtPath(`${state.selectedPath}.position`, {
      x: Math.round(newX * 10) / 10,
      y: Math.round(newY * 10) / 10,
    })
  }

  if (dragType.value === 'resize') {
    const scaleX = activeHandle.value?.includes('e') ? 1 : activeHandle.value?.includes('w') ? -1 : 0
    const scaleY = activeHandle.value?.includes('s') ? 1 : activeHandle.value?.includes('n') ? -1 : 0

    let newW = dragOriginal.value.width + (dx / vp.width) * 100 * scaleX
    let newH = dragOriginal.value.height + (dy / vp.height) * 100 * scaleY

    if (e.shiftKey) {
      const ratio = dragOriginal.value.width / (dragOriginal.value.height || 1)
      if (Math.abs(dx) > Math.abs(dy)) {
        newH = newW / ratio
      } else {
        newW = newH * ratio
      }
    }

    if (state.snapToGrid && !e.shiftKey) {
      // Snap size to the same % grid step (skip while constraining ratio).
      newW = Math.round(newW / GRID_PERCENT) * GRID_PERCENT
      newH = Math.round(newH / GRID_PERCENT) * GRID_PERCENT
    }

    const size: any = {}
    if (scaleX !== 0) size.width = Math.max(1, Math.round(newW * 10) / 10)
    if (scaleY !== 0) size.height = Math.max(1, Math.round(newH * 10) / 10)

    const current = getAtPath(`${state.selectedPath}.size`) || {}
    setAtPath(`${state.selectedPath}.size`, { ...current, ...size })
  }

  if (dragType.value === 'rotate') {
    if (!bounds.value || !props.canvasRef) return
    const canvasRect = props.canvasRef.getBoundingClientRect()
    // Box center in screen coords (bounds are canvas-local).
    const cx = canvasRect.left + bounds.value.left + bounds.value.width / 2
    const cy = canvasRect.top + bounds.value.top + bounds.value.height / 2
    const startAngle = Math.atan2(dragStart.value.y - cy, dragStart.value.x - cx)
    const currentAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
    const delta = ((currentAngle - startAngle) * 180) / Math.PI
    setAtPath(`${state.selectedPath}.rotation`, Math.round(dragOriginal.value.rotation + delta))
  }

  scheduleUpdate()
}

function onMouseUp() {
  isDragging.value = false
  dragType.value = null
  activeHandle.value = null
}

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

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
</script>

<template>
  <div v-if="bounds" :style="boxStyle" class="selection-box" :class="{ locked: isLocked }">
    <!-- Border -->
    <div class="selection-border" />

    <!-- Locked badge: makes it obvious why nothing drags. -->
    <div v-if="isLocked" class="lock-badge" data-test="overlay-locked">🔒 Bloqueado</div>

    <!-- Move area: disabled (no pointer events) while locked so a drag never
         starts and the canvas hit-test stays clean. -->
    <div v-if="!isLocked" class="move-area" @mousedown="startMove" />

    <!-- Resize + rotate handles only when unlocked. -->
    <template v-if="!isLocked">
      <div
        v-for="h in handles"
        :key="h"
        :class="['handle', `handle-${h}`]"
        @mousedown="(e) => startResize(e, h)"
      />
      <div class="rotate-handle" @mousedown="startRotate">
        <div class="rotate-icon">&#x21BB;</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.selection-box { z-index: 10000; }
.selection-border { position: absolute; inset: 0; border: 2px solid #0099ff; pointer-events: none; }
.selection-box.locked .selection-border { border-color: #e0a52a; border-style: dashed; }
.lock-badge {
  position: absolute; top: -22px; left: 0;
  background: #e0a52a; color: #1a1a1a;
  font-size: 11px; font-weight: 600;
  padding: 1px 6px; border-radius: 3px;
  white-space: nowrap; pointer-events: none;
}
.move-area { position: absolute; inset: 0; cursor: move; pointer-events: auto; }
.handle { position: absolute; width: 8px; height: 8px; background: #fff; border: 1px solid #0099ff; pointer-events: auto; z-index: 1; }
.handle-nw { top: -4px; left: -4px; cursor: nw-resize; }
.handle-n { top: -4px; left: 50%; transform: translateX(-50%); cursor: n-resize; }
.handle-ne { top: -4px; right: -4px; cursor: ne-resize; }
.handle-e { top: 50%; right: -4px; transform: translateY(-50%); cursor: e-resize; }
.handle-se { bottom: -4px; right: -4px; cursor: se-resize; }
.handle-s { bottom: -4px; left: 50%; transform: translateX(-50%); cursor: s-resize; }
.handle-sw { bottom: -4px; left: -4px; cursor: sw-resize; }
.handle-w { top: 50%; left: -4px; transform: translateY(-50%); cursor: w-resize; }
.rotate-handle { position: absolute; top: -28px; left: 50%; transform: translateX(-50%); pointer-events: auto; cursor: grab; }
.rotate-icon { width: 18px; height: 18px; background: #fff; border: 1px solid #0099ff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #0099ff; }
</style>
