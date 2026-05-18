<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ParallaxSite, FormBlock, resolveSections } from 'parallax-engine'
import {
  state,
  VIEWPORTS,
  getAtPath,
  artboardHeight,
  refitOverview,
} from '../../stores/editor'
import { useCanvas } from '../../composables/useCanvas'
import { handleCanvasClick } from '../../composables/useSelection'
import { usePreviewHitTargets } from '../../composables/usePreviewHitTargets'
import { GRID_PERCENT } from '../../stores/editor'
import SelectionOverlay from './SelectionOverlay.vue'

const canvasRef = ref<HTMLElement | null>(null)
const previewRef = ref<HTMLElement | null>(null)
const frameRef = ref<HTMLElement | null>(null)
// Bumps on preview-frame scroll so the SelectionOverlay re-measures.
const scrollTick = ref(0)
const {
  viewport,
  setPreviewFrame,
  handleWheel,
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
} = useCanvas()

// Make engine-rendered video/audio selectable in Edición mode (stamps
// data-parallax-id on media hosts + strips native controls so the
// canvas-level hit-test wins). Preview mode keeps real interactive media.
usePreviewHitTargets(previewRef)

const components = { FormBlock }

// Grid overlay: drawn at GRID_PERCENT of the artboard so the lines match the
// snap step exactly (snap rounds position.x/y — which are % of the artboard —
// to GRID_PERCENT increments). The whole layer lives INSIDE the scaled
// preview-frame so it scales 1:1 with zoom and the device artboard.
const gridStyle = computed(() => {
  const vp = viewport()
  const stepX = (vp.width * GRID_PERCENT) / 100
  const stepY = (vp.height * GRID_PERCENT) / 100
  return {
    backgroundSize: `${stepX}px ${stepY}px`,
    backgroundImage:
      'linear-gradient(to right, rgba(0,153,255,0.28) 0, rgba(0,153,255,0.28) 1px, transparent 1px),' +
      'linear-gradient(to bottom, rgba(0,153,255,0.28) 0, rgba(0,153,255,0.28) 1px, transparent 1px)',
  }
})

// The engine renders el.src verbatim. Real consumers prefix relative asset
// paths ("images/foo.png" → "/content/<slug>/images/foo.png"); the editor must
// do the equivalent so the preview can fetch the file from the editor's asset
// route (/content/<type>/<slug>/*). state.site stays CANONICAL ("images/foo.png")
// — only this preview copy is rewritten. Mirrors useEventData/useWorldData.
function isRelativeAsset(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && !s.startsWith('http') && !s.startsWith('/')
}
// Preview render copy. Two transforms, both ONLY on this throwaway copy —
// state.site stays canonical (with `views`) for saving:
//   1. Force the EDITOR-SELECTED viewport. In independent mode the engine's
//      resolveSections() would auto-pick desktop/mobile from the live window
//      size, not the editor's device frame. We pre-resolve the active view via
//      the engine, set it as `copy.sections`, and DROP `copy.views` so the
//      engine takes the legacy path and renders exactly the tree being edited.
//      Legacy/compartido sites are unaffected (resolveSections → site.sections).
//   2. Rewrite relative asset paths so the preview can fetch them.
const previewSite = computed(() => {
  if (!state.site) return null
  const base =
    state.projectType && state.slug
      ? `/content/${state.projectType}/${state.slug}/`
      : null
  const copy: any = JSON.parse(JSON.stringify(state.site))
  copy.sections = JSON.parse(
    JSON.stringify(resolveSections(state.site as any, state.deviceMode)),
  )
  delete copy.views
  delete copy.editorLocks
  // Per-node visibility. The engine honors element.visible (v-if), but has NO
  // visible field for layers/sections. We mirror the eye toggle by dropping
  // hidden layers/sections from this THROWAWAY render copy so the canvas
  // preview reflects the toggle. state.site stays canonical (the extra
  // visible:false key is additive and ignored by the sites/engine).
  copy.sections = (copy.sections || []).filter((sec: any) => sec.visible !== false)
  for (const section of copy.sections) {
    section.layers = (section.layers || []).filter((l: any) => l.visible !== false)
  }
  if (!base) return copy
  if (copy.meta && isRelativeAsset(copy.meta.ogImage)) copy.meta.ogImage = base + copy.meta.ogImage
  for (const section of copy.sections || []) {
    for (const layer of section.layers || []) {
      for (const el of layer.elements || []) {
        if ((el.type === 'png' || el.type === 'audio') && isRelativeAsset(el.src)) el.src = base + el.src
        if (el.type === 'video') {
          if (isRelativeAsset(el.src)) el.src = base + el.src
          if (isRelativeAsset(el.poster)) el.poster = base + el.poster
        }
      }
    }
  }
  return copy
})

// In "Vista completa" the artboard grows to the FULL stacked content height
// (artboardHeight = the live-measured scrollHeight) so the entire composition
// is one tall sheet; otherwise it's the fixed device viewport (today's
// behavior, untouched). The scale/pan are computed by the store's fit logic.
const previewStyle = computed(() => {
  const vp = viewport()
  return {
    width: `${vp.width}px`,
    height: `${artboardHeight()}px`,
    transform: `scale(${state.canvasZoom})`,
    transformOrigin: 'top left',
  }
})

const wrapperStyle = computed(() => ({
  transform: `translate(${state.canvasPan.x}px, ${state.canvasPan.y}px)`,
}))

function onClick(e: MouseEvent) {
  // In preview mode the engine owns interaction; don't hijack clicks.
  if (state.previewMode === 'preview') return
  if (state.tool === 'select' && canvasRef.value) {
    handleCanvasClick(e, canvasRef.value)
  }
}

function onFrameScroll() {
  scrollTick.value++
}

watch(
  frameRef,
  (el) => {
    setPreviewFrame(el)
  },
  { immediate: true },
)

// While "Vista completa" is ON, keep the giant sheet fitted when the device
// frame, active view, or the composition's content height changes (e.g. she
// switches desktop/mobile or edits sections). We re-measure the live painted
// height and re-fit. No-op when OFF — the normal mode is never touched.
watch(
  () => [state.deviceMode, state.site, state.overviewMode],
  () => {
    if (!state.overviewMode) return
    nextTick(() => {
      const canvas = canvasRef.value
      const scroller = frameRef.value
      refitOverview(
        canvas?.clientWidth || 0,
        canvas?.clientHeight || 0,
        scroller?.scrollHeight || 0,
      )
    })
  },
  { deep: true },
)

onMounted(() => {
  frameRef.value?.addEventListener('scroll', onFrameScroll, { passive: true })
})

onBeforeUnmount(() => {
  frameRef.value?.removeEventListener('scroll', onFrameScroll)
  setPreviewFrame(null)
})
</script>

<template>
  <div
    ref="canvasRef"
    class="editor-canvas"
    :class="{
      'cursor-hand': state.tool === 'hand',
      'cursor-zoom': state.tool === 'zoom',
      'is-preview': state.previewMode === 'preview',
      'is-edit': state.previewMode === 'edit',
      'is-overview': state.overviewMode,
    }"
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
        <!-- Native scroll viewport for the (tall) engine content. -->
        <div ref="frameRef" class="preview-scroll">
          <div ref="previewRef" class="preview-inner">
            <ParallaxSite
              v-if="previewSite"
              :site="previewSite"
              :components="components"
              mode="dev"
            />
          </div>
        </div>

        <!-- Grid overlay: lines every GRID_PERCENT of the artboard so what
             Daniela sees lines up with snap-to-grid. Inside the scaled
             preview-frame → scales with zoom. Pointer-events:none so it
             never blocks selection / pan / scroll. Edición mode only. -->
        <div
          v-if="state.snapToGrid && state.previewMode === 'edit'"
          class="grid-overlay"
          data-test="grid-overlay"
          :style="gridStyle"
        />
      </div>
    </div>

    <!-- Selection overlay: OUTSIDE the transformed pan-wrapper so it can be
         positioned relative to the (untransformed) canvas element. It derives
         its rect from the actual rendered DOM element + canvas geometry, so it
         stays aligned at any scroll offset (scrollKey forces re-measure). -->
    <SelectionOverlay
      v-if="state.selectedPath && state.site && state.previewMode === 'edit'"
      :canvas-ref="canvasRef"
      :zoom="state.canvasZoom"
      :scroll-key="scrollTick"
    />
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
  overflow: hidden;
  position: relative;
}
/* The actual scroller: same box as the artboard, scrolls the tall engine
   content so every section (100vh/150vh/…) is reachable. overflow:auto on
   BOTH axes so wide content / scrollDirection:horizontal sections can be
   reached by scrolling horizontally too. */
.preview-scroll {
  width: 100%;
  height: 100%;
  overflow: auto;
}
/* width:100% keeps the verified-good vertical behavior exactly; min-width:100%
   still lets content that is intrinsically wider than the artboard (a section
   that does not clip its own X overflow) push the scrollWidth out so the
   horizontal scrollbar gets real range. */
.preview-inner { width: 100%; min-width: 100%; min-height: 100%; }
/* Hide the inner scrollbar so the artboard reads like a design surface. */
.preview-scroll::-webkit-scrollbar { width: 0; height: 0; }
.preview-scroll { scrollbar-width: none; }
.editor-canvas.is-preview .preview-frame {
  outline: 2px solid #2a7d2a;
  outline-offset: 2px;
}
/* ── "Vista completa" (overview / hoja gigante) ───────────────────────────
   The artboard frame is grown (inline) to the FULL stacked content height
   and zoomed to fit. The inner scroller must NOT clip or scroll here — the
   whole composition is meant to be visible at once — so it shows overflow
   and never offsets. (Normal mode keeps overflow:auto, untouched.) A subtle
   accent outline tells Daniela she's looking at the whole sheet. */
.editor-canvas.is-overview .preview-scroll {
  overflow: visible;
}
.editor-canvas.is-overview .preview-frame {
  outline: 2px solid #6b3fa0;
  outline-offset: 2px;
}
/* ── Edición mode: make engine media selectable like text/png ──────────────
   The engine's VideoElement/AudioElement host carries no data-parallax-id and
   (with only size.width set) can collapse to a 0-height box, so the canvas
   geometric hit-test misses it. usePreviewHitTargets stamps the id; these
   rules guarantee the host has a real, clickable rectangle and that the
   native media never swallows the click. Preview mode is untouched, so the
   real interactive video/audio behaves normally there. */
.editor-canvas.is-edit :deep(.parallax-video-element),
.editor-canvas.is-edit :deep(.parallax-audio-element) {
  min-width: 24px;
  min-height: 24px;
}
.editor-canvas.is-edit :deep(.parallax-video-element) {
  /* Fallback box when no metadata is loaded yet (preload=none, src deferred)
     so the host frames the visible media area for the hit-test. */
  aspect-ratio: 16 / 9;
}
.editor-canvas.is-edit :deep(.parallax-video-element video),
.editor-canvas.is-edit :deep(.parallax-audio-element audio) {
  pointer-events: none !important;
}
.editor-canvas.is-edit :deep(.parallax-audio-element) {
  /* Audio has no visual; give it a faint placeholder so it's clickable. */
  background: rgba(0, 153, 255, 0.08);
  outline: 1px dashed rgba(0, 153, 255, 0.5);
}
/* Grid overlay sits above the preview content but below the selection
   overlay (which is z-index:10000 and outside this transformed frame).
   pointer-events:none guarantees it never intercepts clicks/pan/scroll. */
.grid-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
  background-position: 0 0;
}
</style>
