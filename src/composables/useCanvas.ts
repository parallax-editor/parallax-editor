import { state, VIEWPORTS, setZoom, exitOverviewKeepingZoom } from '../stores/editor'

/**
 * Canvas interaction. The preview frame (the white artboard) is a natively
 * scrollable element passed in by EditorCanvas. The wheel is ROUTED BY POINTER
 * LOCATION, Illustrator-style — site-internal scroll vs workspace navigation
 * never mix:
 *
 *   - cmd/ctrl + wheel            → zoom (any location; trackpad pinch arrives
 *                                   here as ctrl+wheel). Unchanged.
 *   - pointer INSIDE the rendered  → drive the SITE's own internal scroll: the
 *     site / sections                artboard viewport scrolls through its
 *                                   sections/parallax exactly like scrolling
 *                                   the real page. In Preview mode the engine
 *                                   (Lenis on window) also advances. The
 *                                   workspace pan is NOT touched here.
 *   - pointer OUTSIDE the sections → pan the WORKSPACE (move the whole "mesa
 *     (over the dark pasteboard)     de trabajo" via canvasPan) so the user
 *                                   can locate/center the artboard. The site
 *                                   does NOT scroll here.
 *   - shift + wheel               → horizontal for mice (only when driving the
 *                                   site scroll); standard convention.
 *   - hand/space tool + drag      → pan (mousedown/move), unchanged.
 *
 * Hit-test: document.elementFromPoint(clientX, clientY). If the element under
 * the pointer is within the rendered site (a `.parallax-site` ancestor, i.e.
 * inside the artboard's painted content), the wheel is "inside". A geometric
 * fallback (pointer within previewFrame's on-screen rect) covers the rare
 * frame where elementFromPoint returns nothing useful. Everything else — the
 * checkerboard pasteboard around the artboard — is "outside".
 */
export function useCanvas() {
  const viewport = () => VIEWPORTS[state.deviceMode]

  let previewFrame: HTMLElement | null = null
  function setPreviewFrame(el: HTMLElement | null) {
    previewFrame = el
  }

  // True when the screen point is over the rendered site (its painted
  // sections / content), false when over the surrounding pasteboard. Uses
  // elementFromPoint so letterboxing / empty artboard padding correctly reads
  // as pasteboard; falls back to the artboard's screen rectangle.
  function pointerOverSite(clientX: number, clientY: number): boolean {
    const hit = document.elementFromPoint(clientX, clientY) as Element | null
    if (hit && hit.closest('.parallax-site')) return true
    // Geometric fallback: inside the (scaled+panned) artboard viewport box.
    if (previewFrame) {
      const r = previewFrame.getBoundingClientRect()
      if (
        hit &&
        previewFrame.contains(hit) &&
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      ) {
        return true
      }
    }
    return false
  }

  function handleWheel(e: WheelEvent) {
    if (e.metaKey || e.ctrlKey) {
      // Zoom (cmd/ctrl + scroll). Trackpad pinch also arrives here as ctrl+wheel.
      // Manual zoom while in "Vista completa" turns it OFF and keeps the
      // user's chosen zoom (non-confusing for a non-technical user).
      e.preventDefault()
      exitOverviewKeepingZoom()
      const factor = e.deltaY > 0 ? 0.95 : 1.05
      setZoom(state.canvasZoom * factor)
      return
    }

    e.preventDefault()

    // In "Vista completa" the whole composition is already visible — there's
    // nothing to scroll. The wheel just pans the workspace (so she can nudge
    // the giant sheet around), never the site's internal scroll.
    if (state.overviewMode) {
      let dx = e.deltaX
      let dy = e.deltaY
      if (e.shiftKey && dx === 0) {
        dx = dy
        dy = 0
      }
      state.canvasPan.x -= dx
      state.canvasPan.y -= dy
      return
    }

    const overSite = pointerOverSite(e.clientX, e.clientY)

    // ── Pointer OUTSIDE the sections → navigate the WORKSPACE ───────────────
    // Over the dark pasteboard the wheel pans the whole "mesa de trabajo" so
    // the user can locate/center the artboard (Illustrator pasteboard nav).
    // The site does NOT scroll here — the two never mix.
    if (!overSite || !previewFrame) {
      let dx = e.deltaX
      let dy = e.deltaY
      if (e.shiftKey && dx === 0) {
        dx = dy
        dy = 0
      }
      state.canvasPan.x -= dx
      state.canvasPan.y -= dy
      return
    }

    // ── Pointer INSIDE the site → drive the SITE's own internal scroll ──────
    // The wheel reaches the artboard viewport so the engine advances through
    // its sections/parallax exactly like scrolling the real page. We do NOT
    // pan the workspace from here (no fall-through), so the gestures stay
    // distinct. deltaX/deltaY applied verbatim for two-axis trackpads.
    const maxScrollTop = previewFrame.scrollHeight - previewFrame.clientHeight
    const canScrollX = previewFrame.scrollWidth - previewFrame.clientWidth > 1
    const canScrollY = maxScrollTop > 1

    let dx = e.deltaX
    let dy = e.deltaY

    if (e.shiftKey && dx === 0) {
      // Mouse shift+wheel = horizontal (standard convention).
      dx = dy
      dy = 0
    } else if (
      canScrollX &&
      dx === 0 &&
      dy !== 0 &&
      (!canScrollY ||
        (dy > 0 && previewFrame.scrollTop >= maxScrollTop) ||
        (dy < 0 && previewFrame.scrollTop <= 0))
    ) {
      // Vertical-only wheel (mouse) with horizontal overflow but no vertical
      // room left → drive horizontal so wide / scrollDirection:horizontal
      // sections stay reachable.
      dx = dy
      dy = 0
    }

    previewFrame.scrollTop += dy
    previewFrame.scrollLeft += dx

    if (state.previewMode === 'preview') {
      // Feed the engine: Lenis listens to wheel on window. Redispatch a
      // matching wheel so scroll-driven animations/parallax advance. The
      // engine derives section progress from the live getBoundingClientRect()
      // of the (now scrolled) sections, so progress stays correct.
      window.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
        }),
      )
    }
  }

  let isPanning = false
  let panStart = { x: 0, y: 0 }

  function handleMouseDown(e: MouseEvent) {
    if (state.tool === 'hand' || e.buttons === 4 || (e.buttons === 1 && e.altKey)) {
      isPanning = true
      panStart = { x: e.clientX - state.canvasPan.x, y: e.clientY - state.canvasPan.y }
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (isPanning) {
      state.canvasPan.x = e.clientX - panStart.x
      state.canvasPan.y = e.clientY - panStart.y
    }
  }

  function handleMouseUp() {
    isPanning = false
  }

  return {
    viewport,
    setPreviewFrame,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  }
}
