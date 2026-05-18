<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state, getAtPath, setAtPath } from '../../stores/editor'

const props = defineProps<{
  canvasRef: HTMLElement | null
  zoom: number
}>()

const bounds = ref<DOMRect | null>(null)
const isDragging = ref(false)
const dragType = ref<'move' | 'resize' | 'rotate' | null>(null)
const dragStart = ref({ x: 0, y: 0 })
const dragOriginal = ref<any>({})
const activeHandle = ref<string | null>(null)

function updateBounds() {
  if (!state.selectedPath) { bounds.value = null; return }
  const el = state.site ? findDomElement() : null
  if (el) {
    bounds.value = el.getBoundingClientRect()
  } else {
    bounds.value = null
  }
}

function findDomElement(): HTMLElement | null {
  const selected = getAtPath(state.selectedPath!)
  if (!selected?.id) return null
  return document.querySelector(`[data-parallax-id="${selected.id}"]`)
}

// Update bounds when selection or site changes
watch(() => [state.selectedPath, state.site], () => {
  requestAnimationFrame(updateBounds)
}, { deep: true })

onMounted(() => {
  updateBounds()
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})

// ─── Drag handlers ──────────────────────────────────────────

function startMove(e: MouseEvent) {
  if (state.tool !== 'select' || !state.selectedPath) return
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
  e.stopPropagation()
  isDragging.value = true
  dragType.value = 'rotate'
  dragStart.value = { x: e.clientX, y: e.clientY }
  const el = getAtPath(state.selectedPath!)
  dragOriginal.value = { rotation: el?.rotation || 0 }
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging.value || !state.selectedPath) return

  const dx = (e.clientX - dragStart.value.x) / props.zoom
  const dy = (e.clientY - dragStart.value.y) / props.zoom

  if (dragType.value === 'move') {
    // Convert px delta to % of viewport
    const vw = state.deviceMode === 'desktop' ? 1440 : 375
    const vh = state.deviceMode === 'desktop' ? 900 : 667
    let newX = dragOriginal.value.x + (dx / vw) * 100
    let newY = dragOriginal.value.y + (dy / vh) * 100

    if (state.snapToGrid) {
      newX = Math.round(newX / state.gridSize) * state.gridSize
      newY = Math.round(newY / state.gridSize) * state.gridSize
    }

    setAtPath(`${state.selectedPath}.position`, {
      x: Math.round(newX * 10) / 10,
      y: Math.round(newY * 10) / 10,
    })
  }

  if (dragType.value === 'resize') {
    const vw = state.deviceMode === 'desktop' ? 1440 : 375
    const scaleX = activeHandle.value?.includes('e') ? 1 : activeHandle.value?.includes('w') ? -1 : 0
    const scaleY = activeHandle.value?.includes('s') ? 1 : activeHandle.value?.includes('n') ? -1 : 0

    let newW = dragOriginal.value.width + (dx / vw) * 100 * scaleX
    let newH = dragOriginal.value.height + (dy / vw) * 100 * scaleY

    if (e.shiftKey) {
      // Maintain aspect ratio
      const ratio = dragOriginal.value.width / (dragOriginal.value.height || 1)
      if (Math.abs(dx) > Math.abs(dy)) {
        newH = newW / ratio
      } else {
        newW = newH * ratio
      }
    }

    const size: any = {}
    if (scaleX !== 0) size.width = Math.max(1, Math.round(newW * 10) / 10)
    if (scaleY !== 0) size.height = Math.max(1, Math.round(newH * 10) / 10)

    const current = getAtPath(`${state.selectedPath}.size`) || {}
    setAtPath(`${state.selectedPath}.size`, { ...current, ...size })
  }

  if (dragType.value === 'rotate') {
    if (!bounds.value) return
    const cx = bounds.value.left + bounds.value.width / 2
    const cy = bounds.value.top + bounds.value.height / 2
    const startAngle = Math.atan2(dragStart.value.y - cy, dragStart.value.x - cx)
    const currentAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
    const delta = ((currentAngle - startAngle) * 180) / Math.PI
    setAtPath(`${state.selectedPath}.rotation`, Math.round(dragOriginal.value.rotation + delta))
  }

  requestAnimationFrame(updateBounds)
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
    position: 'fixed' as const,
    left: `${bounds.value.left}px`,
    top: `${bounds.value.top}px`,
    width: `${bounds.value.width}px`,
    height: `${bounds.value.height}px`,
    pointerEvents: 'none' as const,
  }
})
</script>

<template>
  <div v-if="bounds" :style="boxStyle" class="selection-box">
    <!-- Border -->
    <div class="selection-border" />

    <!-- Move area -->
    <div class="move-area" @mousedown="startMove" />

    <!-- Resize handles -->
    <div
      v-for="h in handles"
      :key="h"
      :class="['handle', `handle-${h}`]"
      @mousedown="(e) => startResize(e, h)"
    />

    <!-- Rotate handle -->
    <div class="rotate-handle" @mousedown="startRotate">
      <div class="rotate-icon">&#x21BB;</div>
    </div>
  </div>
</template>

<style scoped>
.selection-box { z-index: 10000; }
.selection-border { position: absolute; inset: 0; border: 2px solid #0099ff; pointer-events: none; }
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
