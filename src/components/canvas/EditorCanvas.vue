<script setup lang="ts">
import { ref, computed } from 'vue'
import { ParallaxSite, FormBlock } from 'parallax-engine'
import { state, VIEWPORTS, getAtPath } from '../../stores/editor'
import { useCanvas } from '../../composables/useCanvas'
import { handleCanvasClick } from '../../composables/useSelection'
import SelectionOverlay from './SelectionOverlay.vue'

const canvasRef = ref<HTMLElement | null>(null)
const previewRef = ref<HTMLElement | null>(null)
const { viewport, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp } = useCanvas()

const components = { FormBlock }

const previewStyle = computed(() => {
  const vp = viewport()
  return {
    width: `${vp.width}px`,
    height: `${vp.height}px`,
    transform: `scale(${state.canvasZoom})`,
    transformOrigin: 'top left',
  }
})

const wrapperStyle = computed(() => ({
  transform: `translate(${state.canvasPan.x}px, ${state.canvasPan.y}px)`,
}))

function onClick(e: MouseEvent) {
  if (state.tool === 'select' && canvasRef.value) {
    handleCanvasClick(e, canvasRef.value)
  }
}
</script>

<template>
  <div
    ref="canvasRef"
    class="editor-canvas"
    :class="{ 'cursor-hand': state.tool === 'hand', 'cursor-zoom': state.tool === 'zoom' }"
    @wheel.prevent="handleWheel"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
    @mouseup="handleMouseUp"
    @click="onClick"
  >
    <!-- Checkerboard background -->
    <div class="canvas-bg" />

    <!-- Pannable wrapper -->
    <div class="pan-wrapper" :style="wrapperStyle">
      <!-- Scaled preview container -->
      <div class="preview-frame" :style="previewStyle">
        <div ref="previewRef" class="preview-inner">
          <ParallaxSite
            v-if="state.site"
            :site="state.site"
            :components="components"
            mode="dev"
          />
        </div>
      </div>

      <!-- Selection overlay (same coordinate space as preview) -->
      <SelectionOverlay
        v-if="state.selectedPath && state.site"
        :canvas-ref="canvasRef"
        :zoom="state.canvasZoom"
      />
    </div>
  </div>
</template>

<style scoped>
.editor-canvas {
  flex: 1;
  overflow: hidden;
  position: relative;
  cursor: default;
  background: #1a1a1a;
}
.cursor-hand { cursor: grab; }
.cursor-hand:active { cursor: grabbing; }
.cursor-zoom { cursor: zoom-in; }
.canvas-bg {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(45deg, #222 25%, transparent 25%),
    linear-gradient(-45deg, #222 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #222 75%),
    linear-gradient(-45deg, transparent 75%, #222 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  opacity: 0.3;
}
.pan-wrapper { position: relative; }
.preview-frame {
  background: white;
  box-shadow: 0 4px 40px rgba(0,0,0,0.4);
  overflow: auto;
  position: relative;
}
.preview-inner { width: 100%; min-height: 100%; }
</style>
