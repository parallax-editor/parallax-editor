import { onBeforeUnmount } from 'vue'

/**
 * Make a side-panel scroll body scroll with the mouse wheel.
 *
 * THE REAL BUG (not CSS): the canvas always mounts a live ParallaxSite
 * preview, and parallax-engine spins up Lenis (`new Lenis()`), whose default
 * wrapper is `window`. Lenis registers a NON-passive `wheel` listener on
 * `window` and `preventDefault()`s every wheel event document-wide so it can
 * drive its own smooth page scroll. Result: wheeling over the PROPIEDADES /
 * CAPAS panels never reaches their native `overflow-y:auto` — the panel body
 * has the right CSS (bounded height, min-height:0, overflow-y:auto; it scrolls
 * fine programmatically) but the wheel gesture is swallowed before the browser
 * can scroll the element. Every prior "fix" tuned the flex/min-height chain and
 * measured programmatic scroll (which passed) while the wheel stayed hijacked.
 *
 * Fix, client-side only (we must not touch parallax-engine): on the panel
 * scroll body, listen for `wheel` in the CAPTURE phase and stop it from
 * propagating. Lenis listens on `window` (bubble phase, the last target a
 * bubbling event reaches), so stopping propagation at the panel prevents the
 * event from ever reaching Lenis — while we deliberately DO NOT call
 * preventDefault, so the browser still performs the element's native scroll.
 */
export function usePanelScroll() {
  let bound: HTMLElement | null = null

  function onWheel(e: WheelEvent) {
    // Keep this wheel gesture out of the window-level Lenis listener so the
    // panel's own overflow scrolling works. Do NOT preventDefault: native
    // scrolling of the scroll container must still happen.
    e.stopPropagation()
  }

  function attach(el: HTMLElement | null) {
    if (bound === el) return
    if (bound) bound.removeEventListener('wheel', onWheel, true)
    bound = el
    if (bound) bound.addEventListener('wheel', onWheel, { capture: true, passive: true })
  }

  // Template-ref function: Vue calls it with the element (or null on unmount).
  function panelScrollRef(el: Element | null) {
    attach((el as HTMLElement) || null)
  }

  onBeforeUnmount(() => attach(null))

  return { panelScrollRef }
}
