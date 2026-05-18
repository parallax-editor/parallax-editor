import { state } from '../stores/editor'
import type { Site } from 'parallax-engine/schema'

/**
 * Given a DOM element with data-parallax-id, find its path in the site JSON.
 */
export function findElementPath(site: Site, parallaxId: string): string | null {
  for (let si = 0; si < site.sections.length; si++) {
    const section = site.sections[si]
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
 * Handle click on the canvas to select an element.
 */
export function handleCanvasClick(e: MouseEvent, canvasEl: HTMLElement) {
  if (state.tool !== 'select' || !state.site) return

  // Find the element under the click that has data-parallax-id
  const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  if (!target) {
    state.selectedPath = null
    return
  }

  const parallaxEl = target.closest('[data-parallax-id]') as HTMLElement | null
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
