import {
  state,
  activeSections,
  shouldSwallowCanvasClick,
  setCanvasSelection,
  toggleCanvasSelection,
  isNodeLockedById,
} from '../stores/editor'
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
 *
 * Item #6 — LOCKED elements are SKIPPED. A locked element (lock toggle in the
 * CAPAS tree; the flag lives in editor state `lockedIds`, NOT the engine
 * schema) is intentionally inert on the canvas: a click "passes through" it to
 * whatever is behind, and it gets no hover highlight. So a big locked
 * background image never blocks selecting the elements in front of/behind it.
 * It remains selectable ONLY from the CAPAS tree (that path doesn't go through
 * this geometric hit-test).
 */
export function elementAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[data-parallax-id]')
  let best: HTMLElement | null = null
  candidates.forEach((el) => {
    // Item #6: a locked element is invisible to the canvas hit-test — clicks
    // and hover pass straight through it.
    if (isNodeLockedById(el.getAttribute('data-parallax-id'))) return
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
 * Is a screen point INSIDE the artboard (the `.preview-frame` rect)?
 *
 * TASK #112 (Illustrator pasteboard semantics): a canvas click only selects
 * when the click lands inside the artboard. The geometric `elementAtPoint`
 * hit-test matches by an element's live getBoundingClientRect(), so a TALL
 * element whose box spills into the dark pasteboard around the mesa would get
 * "selected" by a click over the pasteboard even though nothing is visible
 * there. We gate every canvas hit-test by the artboard rect: a click outside
 * it must DESELECT and select nothing. The `.preview-frame` is the scaled +
 * panned device artboard (its on-screen rect is the visible mesa), valid in
 * normal AND "Vista completa" mode. (Tree-driven selection is unaffected — it
 * never goes through this path.)
 */
export function pointInArtboard(clientX: number, clientY: number): boolean {
  const frame = document.querySelector<HTMLElement>('.preview-frame')
  if (!frame) return false
  const r = frame.getBoundingClientRect()
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
}

/**
 * Handle click on the canvas to select an element.
 */
export function handleCanvasClick(e: MouseEvent, _canvasEl: HTMLElement) {
  if (state.tool !== 'select' || !state.site) return

  // Swallow the click synthesized by a move/resize/rotate drag's mouseup, so
  // releasing a handle over the pasteboard never deselects the dragged node.
  if (shouldSwallowCanvasClick()) return

  // TASK #112: gate by the artboard (`.preview-frame`) rect BEFORE the
  // geometric hit-test. A click on the pasteboard (outside the mesa) clears
  // the selection and selects nothing — even if an off-board element's box
  // extends under the cursor. A plain click clears; a SHIFT click on the
  // pasteboard preserves the current multi-selection (a missed shift-click
  // shouldn't nuke the group). The ONLY way to select an off-board element is
  // via the CAPAS tree.
  if (!pointInArtboard(e.clientX, e.clientY)) {
    if (!e.shiftKey) setCanvasSelection(null)
    return
  }

  const parallaxEl = elementAtPoint(e.clientX, e.clientY)
  if (!parallaxEl) {
    // Click on empty pasteboard. A plain click clears everything; a SHIFT
    // click on nothing preserves the existing multi-selection (so a missed
    // shift-click doesn't nuke the group).
    if (!e.shiftKey) setCanvasSelection(null)
    return
  }

  const id = parallaxEl.getAttribute('data-parallax-id')
  if (!id) {
    if (!e.shiftKey) setCanvasSelection(null)
    return
  }

  const path = findElementPath(state.site, id)
  if (!path) {
    if (!e.shiftKey) setCanvasSelection(null)
    return
  }
  // SHIFT+click → toggle this element in/out of the multi-selection (GAP5).
  // Plain click → single select (collapses any multi-selection). Both keep
  // `selectedPath` as the primary so PROPIEDADES/CAPAS are unchanged.
  if (e.shiftKey) toggleCanvasSelection(path)
  else setCanvasSelection(path)
}
