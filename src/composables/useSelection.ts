import { state, activeSections } from '../stores/editor'
import type { Site } from 'parallax-engine/schema'

/**
 * Given a DOM element with data-parallax-id, find its VIEW-RELATIVE path
 * ("sections.i.layers.l.elements.e"). We search the ACTIVE view's tree
 * (activeSections handles legacy vs independent desktop/mobile), so a click on
 * the canvas selects the node in whatever viewport is being edited. The path
 * is intentionally view-relative — getAtPath/setAtPath rebase it to the active
 * view's canonical root. `site` is accepted for signature stability but the
 * active view is the source of truth.
 */
export function findElementPath(_site: Site, parallaxId: string): string | null {
  const sections = activeSections()
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si]
    for (let li = 0; li < section.layers.length; li++) {
      const layer = section.layers[li]
      for (let ei = 0; ei < layer.elements.length; ei++) {
        if (layer.elements[ei].id === parallaxId) {
          return `sections.${si}.layers.${li}.elements.${ei}`
        }
      }
    }
  }
  return null
}

/**
 * Pick the [data-parallax-id] element under a screen point.
 *
 * We CANNOT use document.elementFromPoint(): the engine renders every
 * non-interactive element (and every .parallax-layer) with
 * `pointer-events: none`, so elementFromPoint walks straight past them and
 * returns the underlying <section> — whose ancestors have no
 * data-parallax-id, so .closest() always returns null and nothing selects.
 *
 * Instead we geometrically hit-test the live getBoundingClientRect() of
 * every rendered [data-parallax-id] element. Rects are real on-screen
 * boxes, so this is automatically correct at any scroll offset, zoom, pan
 * or CSS transform — and it ignores pointer-events entirely.
 *
 * When several elements overlap the point we pick the topmost one: later in
 * DOM order / deeper paints last, matching what the user visually clicked
 * and what the selection overlay will frame.
 */
export function elementAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[data-parallax-id]')
  let best: HTMLElement | null = null
  candidates.forEach((el) => {
    // Skip elements that aren't actually painted (display:none → 0 box).
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      // querySelectorAll is in document order; the last match that contains
      // the point is the one painted on top.
      best = el
    }
  })
  return best
}

/**
 * Handle click on the canvas to select an element.
 */
export function handleCanvasClick(e: MouseEvent, _canvasEl: HTMLElement) {
  if (state.tool !== 'select' || !state.site) return

  const parallaxEl = elementAtPoint(e.clientX, e.clientY)
  if (!parallaxEl) {
    state.selectedPath = null
    return
  }

  const id = parallaxEl.getAttribute('data-parallax-id')
  if (!id) {
    state.selectedPath = null
    return
  }

  const path = findElementPath(state.site, id)
  state.selectedPath = path
}
