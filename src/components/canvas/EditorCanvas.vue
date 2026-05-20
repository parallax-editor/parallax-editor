<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, h, type Component } from 'vue'
import { ParallaxSite, FormBlock } from 'parallax-engine'
import CustomComponentHost from './CustomComponentHost.vue'
import { buildPreviewSite } from '../../composables/usePreviewSite'
import {
  state,
  VIEWPORTS,
  getAtPath,
  artboardHeight,
  refitOverview,
  centerArtboardOnLoad,
  prefsWantOverview,
  setOverview,
  isCanvasDragActive,
} from '../../stores/editor'

// TASK 1 (#88): the engine resolves CSS viewport units in `section.height`
// (`100vh`, `150vh`, `50vw`, …) against the REAL browser window — i.e. the
// editor's large outer window — not the emulated device artboard. So a
// `height:'100vh'` section paints ~ window-height tall and OVERFLOWS the
// device-sized `.preview-frame` (the section / its highlight box spill past
// the artboard). The editor must make `vh`/`vw` resolve to the emulated
// device the artboard already uses (desktop 1440×900 / mobile 375×667).
//
// We do it on the THROWAWAY preview copy only (same place asset paths /
// active-view are already rewritten): convert any `height` string that uses
// `vh`/`vw` to an explicit px length relative to the device artboard.
//
//   vh → value/100 * deviceHeight   vw → value/100 * deviceWidth
//   (deviceHeight/Width = VIEWPORTS[state.deviceMode], the exact basis the
//    artboard / overview model-sum already use)
//
// state.site stays canonical: real saved sections keep `'100vh'`. Composition
// with "Vista completa": overview measures the engine's live `scrollHeight`
// (overviewContentHeight) and ALSO model-sums section heights against the same
// device viewport (overviewContentHeightFromModel). If we rewrote heights to
// px while overview was ON, the px the engine paints would equal the device
// basis AND the model sum would still use it → still consistent, BUT to keep
// overview's existing "fit the whole sheet" math byte-for-byte unchanged we
// only rewrite on the NON-overview render path (overview OFF). When overview
// is ON the engine keeps painting raw `vh` and overview's own fit logic
// (untouched) handles it exactly as before.
// Rewrite EVERY viewport-unit token (vw/vh/vmin/vmax) anywhere in a value —
// including inside clamp()/calc()/min()/max() — to an explicit px length
// relative to the emulated device artboard. A standalone `"230vh"` and a
// compound `"clamp(2.6rem, 9vw, 6.5rem)"` are both handled (the anchored regex
// this replaces only caught standalone values, so vw inside a clamp() fontSize
// resolved against the real editor window and the title blew up vs the real
// device). state.site stays canonical; only the throwaway copy is rewritten.
const VP_UNIT_TOKEN_RE = /([\d.]+)\s*(vw|vh|vmin|vmax)\b/gi
function remapViewportUnits<T>(value: T): T {
  if (typeof value !== 'string' || !/(vw|vh|vmin|vmax)/i.test(value)) return value
  const vp = VIEWPORTS[state.deviceMode]
  return value.replace(VP_UNIT_TOKEN_RE, (_m, num: string, unit: string) => {
    const n = parseFloat(num)
    if (!Number.isFinite(n)) return _m
    const u = unit.toLowerCase()
    const basis =
      u === 'vw' ? vp.width :
      u === 'vh' ? vp.height :
      u === 'vmin' ? Math.min(vp.width, vp.height) :
      Math.max(vp.width, vp.height)
    return `${(n / 100) * basis}px`
  }) as unknown as T
}
// Rewrite the length-bearing string props of one element AND its responsive
// (mobile/desktop) overrides, so viewport units in fontSize/size resolve
// against the device artboard like the deployed site does.
function remapElementUnits(el: any): void {
  const fix = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (typeof obj.fontSize === 'string') obj.fontSize = remapViewportUnits(obj.fontSize)
    if (obj.size && typeof obj.size === 'object') {
      if (typeof obj.size.width === 'string') obj.size.width = remapViewportUnits(obj.size.width)
      if (typeof obj.size.height === 'string') obj.size.height = remapViewportUnits(obj.size.height)
    }
  }
  if (!el || typeof el !== 'object') return
  fix(el)
  fix(el.mobile)
  fix(el.desktop)
}
import { useCanvas } from '../../composables/useCanvas'
import { handleCanvasClick } from '../../composables/useSelection'
import { usePreviewHitTargets } from '../../composables/usePreviewHitTargets'
import { GRID_PERCENT } from '../../stores/editor'
import SelectionOverlay from './SelectionOverlay.vue'
import SectionLayerHighlight from './SectionLayerHighlight.vue'
import SmartGuides from './SmartGuides.vue'
import PreviewCursor from './PreviewCursor.vue'

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
  handleZoomToolClick,
} = useCanvas()

// Make engine-rendered video/audio selectable in Edición mode (stamps
// data-parallax-id on media hosts + strips native controls so the
// canvas-level hit-test wins). Preview mode keeps real interactive media.
usePreviewHitTargets(previewRef)

// Components map handed to <ParallaxSite>. Always includes the engine built-in
// FormBlock. For every custom component the project registered (GAP1 / PLAN
// §13) we register a thin wrapper that renders CustomComponentHost — it
// best-effort dynamically imports the real sibling SFC and, per PLAN §16,
// falls back to a RED placeholder ("Componente <Name> falló: <error>")
// instead of letting a broken component crash the whole preview. The
// engine's ComponentElement does `<component :is> v-bind="el.props"`, so the
// schema props arrive as $attrs which we forward verbatim to the host.
const components = computed<Record<string, Component>>(() => {
  const map: Record<string, Component> = { FormBlock }
  for (const name of Object.keys(state.componentRegistry)) {
    if (name === 'FormBlock') continue
    map[name] = {
      name: `CustomHost_${name}`,
      inheritAttrs: false,
      setup(_props: unknown, { attrs }: { attrs: Record<string, unknown> }) {
        return () =>
          h(CustomComponentHost, { name, componentProps: attrs })
      },
    }
  }
  return map
})

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

// Preview render copy. The SHARED core (buildPreviewSite) handles the two
// transforms common with the full-viewport "Vista en vivo" tab — active-view
// resolution (v1.1 `views` → the editor-selected device, DROP `copy.views` so
// the engine takes the legacy path) and relative-asset prefixing
// ("images/foo.png" → "/content/<type>/<slug>/images/foo.png" so the preview
// fetches it from the editor's asset route). state.site stays CANONICAL.
//
// On TOP of that shared copy this component layers EDITOR-CANVAS-ONLY tweaks
// that must NOT leak into the live tab (cursor strip, hidden-node pruning, and
// the device-artboard `vh→px` remap — the live tab is a real full viewport so
// it keeps raw `vh`/`vw`).
const previewSite = computed(() => {
  const copy: any = buildPreviewSite(
    state.site,
    state.projectType,
    state.slug,
    state.deviceMode,
  )
  if (!copy) return null
  // TASK 2 (#81): never let the engine render its own CustomCursor in the
  // preview. It is `position:fixed` but lives inside the scaled/translated
  // `.preview-frame`, so the spec makes that transformed ancestor its
  // containing block → the circle is OFFSET from the real pointer and the
  // offset grows with zoom/pan/scroll. The editor renders a correctly-aligned
  // <PreviewCursor> instead (Preview mode only). state.site stays canonical —
  // the real eventos/site keep their engine cursor untouched.
  delete copy.cursor
  // Per-node visibility. The engine honors element.visible (v-if), but has NO
  // visible field for layers/sections. We mirror the eye toggle by dropping
  // hidden layers/sections from this THROWAWAY render copy so the canvas
  // preview reflects the toggle. state.site stays canonical (the extra
  // visible:false key is additive and ignored by the sites/engine).
  copy.sections = (copy.sections || []).filter((sec: any) => sec.visible !== false)
  for (const section of copy.sections) {
    section.layers = (section.layers || []).filter((l: any) => l.visible !== false)
  }
  // TASK 1 (#88): map `vh`/`vw` section heights to device-artboard px so a
  // `100vh` section is exactly the artboard tall (not the editor window).
  // Overview OFF only — overview keeps painting raw `vh` and uses its own
  // (untouched) fit math. Canonical state.site is never mutated (this is the
  // deep-cloned throwaway copy).
  if (!state.overviewMode) {
    for (const section of copy.sections) {
      section.height = remapViewportUnits(section.height)
    }
  }
  // Element-level viewport units (fontSize: clamp(2.6rem, 9vw, 6.5rem),
  // size.width: 50vw, …) must also resolve against the device artboard or text
  // and images blow up vs the real site — especially on the narrow mobile
  // artboard (the title "Bestiario Botanico" overflowed). Applied in BOTH modes
  // (it only affects element appearance, not the overview fit math).
  for (const section of copy.sections) {
    for (const layer of section.layers || []) {
      for (const el of layer.elements || []) remapElementUnits(el)
    }
  }
  // Asset paths / og image / favicon / custom @font-face urls are ALREADY
  // prefixed by buildPreviewSite — no second pass here.
  return copy
})

// The engine injects custom @font-face / the favicon <link> ONCE, inside
// ParallaxSite's onMounted (Q()). It does NOT react to a later meta change.
// So uploading a custom font (or favicon) wouldn't show in the editor preview
// until the engine re-mounts. We fold a SIGNATURE of just the custom-font
// definitions + favicon into the preview :key so changing one re-mounts
// ParallaxSite (re-runs Q() → @font-face/<link> picked up). It deliberately
// ignores Google fonts and every other site edit, so unrelated changes do NOT
// thrash the preview (keeps the animation/selection behavior unchanged).
const fontFaceKey = computed(() => {
  const m: any = (state.site as any)?.meta
  if (!m) return ''
  const fonts = Array.isArray(m.fonts)
    ? m.fonts
        .filter((f: any) => f && f.source === 'custom')
        .map((f: any) => `${f.family || ''}|${f.url || ''}`)
        .join(',')
    : ''
  return `${fonts}#${m.favicon || ''}`
})

// TASK #111 — engine re-mount key. The `<ParallaxSite>` instance must ONLY be
// torn down and re-created when something REQUIRES a fresh mount (which replays
// every enter/split animation from 0). Those triggers are, exhaustively:
//   • slug          — opening a DIFFERENT project (a wholly new site tree; the
//                     previous project's animation/scroll state must not bleed
//                     in via a prop patch).
//   • previewNonce  — the explicit "Reiniciar mesa" / preview-restart button
//                     (restartPreview() bumps it; replaying animations is the
//                     whole point of that button).
//   • fontFaceKey   — a custom @font-face / favicon change, which the engine
//                     only injects in its onMounted (see fontFaceKey docblock).
//
// Crucially this key is INDEPENDENT of selection, hover, scroll, the scroll-key,
// and live content edits (position/size/text/animation props…). Those mutate
// `state.site` (or just `selectedPath`/hover), which flows to the engine as a
// reactive PROP PATCH — Vue diffs the existing instance in place and the
// in-flight animations keep running. So selecting a back element, hovering
// front layers, or nudging a value can never restart/freeze an animation that
// is mid-flight in the canvas preview. Only the three triggers above re-key.
const engineKey = computed(() => `${state.slug || ''}#${state.previewNonce}#${fontFaceKey.value}`)

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
  // Zoom tool: click zooms IN at the pointer, alt/option+click zooms OUT
  // around the cursor (GAP9). Space-pan takes precedence (handled inside).
  if (state.tool === 'zoom') {
    handleZoomToolClick(e, canvasRef.value)
    return
  }
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
  // Include the (now reactive) artboard dimensions: changing the device size
  // resizes vh-based sections, so the overview sheet must re-measure + re-fit
  // or it leaves stale height (a white gap at the end) and a mis-scaled fit.
  () => [
    state.deviceMode,
    state.site,
    state.overviewMode,
    VIEWPORTS[state.deviceMode].width,
    VIEWPORTS[state.deviceMode].height,
  ],
  () => {
    if (!state.overviewMode) return
    // Item #2: do NOT refit while an element drag is in progress. A drag mutates
    // the element's position in state.site, firing this deep watcher; refitting
    // here would call setZoom/center and RESET the zoom/pan the user is dragging
    // against (the "Vista completa" zoom jump). The refit is only meant for real
    // content/layout changes (section add/edit, device/view switch) — none of
    // which happen during a live drag. On drag end the position is final and a
    // genuine height change (rare for a move) is already reflected.
    if (isCanvasDragActive()) return
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

// Initial framing: when a project opens it must NOT be jammed in the top-left
// corner. Center it horizontally with a small top margin (normal mode only).
// Fires once per opened project (slug change) once the canvas has a real size,
// and never again so the user's own pan/zoom is preserved across edits.
let framedSlug: string | null = null
function frameInitial() {
  if (state.overviewMode) return
  if (!state.slug || state.slug === framedSlug) return
  const canvas = canvasRef.value
  if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return
  framedSlug = state.slug
  // Restore the persisted "Vista completa" pref through the REAL enable/fit
  // path now that the project + canvas are measured (NOT by blindly setting
  // state.overviewMode, which would skip the scale/center math). Defer one
  // more frame so the engine has painted its sections → the live scrollHeight
  // is accurate for the fit. If the pref wants normal mode, just center.
  if (prefsWantOverview.value) {
    prefsWantOverview.value = false
    nextTick(() => {
      const c = canvasRef.value
      const scroller = frameRef.value
      if (!c) return
      setOverview(true, c.clientWidth || 0, c.clientHeight || 0, {
        measuredHeight: scroller?.scrollHeight || 0,
        scrollTop: scroller?.scrollTop || 0,
        scrollLeft: scroller?.scrollLeft || 0,
      })
    })
    return
  }
  centerArtboardOnLoad(canvas.clientWidth, canvas.clientHeight)
}

watch(
  () => state.slug,
  () => {
    framedSlug = null
    nextTick(frameInitial)
  },
)

// The engine's Q() skips a font/favicon whose <style|link data-parallax-font>
// tag already lives in document.head ("if (document.querySelector(...)) continue").
// On a key-driven re-mount it does NOT clean those up, so re-uploading a file
// for an EXISTING family would keep the stale url. Prune the engine-injected
// font tags right before the re-mount so Q() re-injects with the fresh url.
// Scoped to fontFaceKey (custom fonts + favicon only) → no churn elsewhere.
watch(fontFaceKey, () => {
  if (typeof document === 'undefined') return
  document
    .querySelectorAll('style[data-parallax-font], link[data-parallax-font]')
    .forEach((n) => n.parentNode?.removeChild(n))
})

onMounted(() => {
  frameRef.value?.addEventListener('scroll', onFrameScroll, { passive: true })
  nextTick(frameInitial)
})

onBeforeUnmount(() => {
  frameRef.value?.removeEventListener('scroll', onFrameScroll)
  setPreviewFrame(null)
})

// Scroll the preview so the element with this id is centered in the frame.
// Used after a Claude edit (EditorView.applyExternalChange) so the restored
// selection stays in view. In "Vista completa" the whole sheet is already on
// screen, so it's a no-op. data-parallax-id is stamped on every preview element
// (engine + usePreviewHitTargets).
function scrollToElement(id: string) {
  if (state.overviewMode) return
  // Replacing state.site re-renders the engine over a few frames, so the target
  // element may not be in the DOM on the first frame — retry up to ~20 frames
  // until it appears, then center it in the scroll frame.
  let tries = 0
  const attempt = () => {
    const scroller = frameRef.value
    const root = previewRef.value
    const host = root?.querySelector(
      `[data-parallax-id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null
    if (host && scroller) {
      // getBoundingClientRect is in SCALED screen px (the artboard is rendered
      // through `transform: scale(zoom)` on .preview-frame), but scrollTop is in
      // UNSCALED layout px. Convert the screen delta to content units by
      // dividing by the zoom — otherwise we scroll only `zoom`× far enough and
      // the element stays off-screen (root cause of "no hace scroll").
      const zoom = state.canvasZoom || 1
      const sRect = scroller.getBoundingClientRect()
      const hRect = host.getBoundingClientRect()
      const contentDelta = (hRect.top - sRect.top) / zoom
      const hostH = hRect.height / zoom
      const target =
        scroller.scrollTop + contentDelta - (scroller.clientHeight / 2 - hostH / 2)
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
      return
    }
    if (++tries < 20) requestAnimationFrame(attempt)
  }
  nextTick(() => requestAnimationFrame(attempt))
}
defineExpose({ scrollToElement })
</script>

<template>
  <div
    ref="canvasRef"
    class="editor-canvas"
    :class="{
      'cursor-hand': state.tool === 'hand' || state.spacePanning,
      'cursor-zoom': state.tool === 'zoom' && !state.spacePanning,
      'is-preview': state.previewMode === 'preview',
      'is-edit': state.previewMode === 'edit',
      'is-overview': state.overviewMode,
      'space-panning': state.spacePanning,
    }"
    :data-space-panning="state.spacePanning ? '1' : '0'"
    :data-tool="state.tool"
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
              :key="engineKey"
              :site="previewSite"
              :components="components"
              data-engine-root
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

        <!-- TASK 1 (#interactions): pointer CAPTURE LAYER over the engine preview.
             The engine now stamps `pointer-events:auto` on interactive elements
             (links, .interactive png/text, components, media, forms) so they
             navigate/animate in the real site. That means in EDICIÓN mode a click
             on such an element would fire its link/hover/click instead of
             selecting it — and setting pointer-events:none on an ANCESTOR can NOT
             stop a descendant that re-enables pointer-events:auto. So we paint a
             full-cover transparent layer ON TOP of the engine content (above the
             interactive elements, below the SelectionOverlay handles at z-index
             10000). In EDICIÓN it is pointer-events:auto → it swallows every
             click/hover from the engine; the click bubbles to .editor-canvas
             @click → handleCanvasClick → the geometric hit-test selects the
             topmost element under the cursor (independent of where the click
             physically lands). Pan/zoom/scroll keep working because mousedown /
             wheel bubble to .editor-canvas too, and the move/resize/rotate
             handles sit ABOVE this layer so dragging is unaffected. In PREVIEW
             mode it is pointer-events:none → clicks/hover fall straight through
             to the engine so links/hover/click animations work for testing. -->
        <div
          v-if="state.previewMode === 'edit'"
          class="capture-layer"
          data-test="capture-layer"
        />
      </div>
    </div>

    <!-- Smart alignment guides: OUTSIDE the transformed pan-wrapper (same as
         SelectionOverlay) so its canvas-local line coords aren't double-
         transformed. Edición mode only (hidden in Preview). Derives guides
         from the active view's rendered rects → view-aware by construction.
         pointer-events:none → never touches selection/grid/pan/clamp. -->
    <SmartGuides
      v-if="state.selectedPath && state.site && state.previewMode === 'edit'"
      :canvas-ref="canvasRef"
      :scroll-key="scrollTick"
    />

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

    <!-- Section/Layer highlight: a NON-interactive dashed outline over the
         rendered bounds of the section/layer selected in the CAPAS tree
         (elements keep the normal .selection-box above). Same canvas-local
         geometry + re-measure triggers as SelectionOverlay; pointer-events:none
         so it never touches element selection/grid/pan/clamp. -->
    <SectionLayerHighlight
      v-if="state.selectedPath && state.site && state.previewMode === 'edit'"
      :canvas-ref="canvasRef"
      :scroll-key="scrollTick"
    />

    <!-- Editor-owned cursor effect (TASK 2 / #81). OUTSIDE the transformed
         pan-wrapper, positioned with real viewport coords → sits exactly under
         the pointer at any zoom/pan/scroll (the engine's own offset
         CustomCursor is stripped from previewSite). Shows only in Preview mode
         and only when the active site enables a cursor. -->
    <PreviewCursor v-if="state.site" :canvas-ref="canvasRef" />
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
/* TASK 1 capture layer. Covers the entire artboard ON TOP of the engine
   content (above grid z-index:5). Transparent. In Edición mode it carries
   pointer-events:auto so it intercepts every click/hover the engine's
   interactive elements would otherwise grab; the event still BUBBLES to
   .editor-canvas (pan/wheel/click handlers) so workspace navigation +
   geometric selection keep working. It is only rendered in Edición mode
   (v-if previewMode==='edit'), so in Preview mode it doesn't exist and the
   engine receives pointer events natively. The SelectionOverlay's move-area /
   resize / rotate handles live OUTSIDE this frame at z-index:10000, above this
   layer, so dragging/resizing is never blocked. */
.capture-layer {
  position: absolute;
  inset: 0;
  z-index: 6;
  background: transparent;
  pointer-events: auto;
  /* Same cursor affordances as the canvas so the artboard reads as selectable
     and pan/zoom cursors still show through the modifier classes. */
  cursor: inherit;
}
</style>
