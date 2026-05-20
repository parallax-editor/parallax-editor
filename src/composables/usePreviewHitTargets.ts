import { watch, onMounted, onBeforeUnmount } from 'vue'
import { state, activeSections } from '../stores/editor'

/**
 * Make engine-rendered VIDEO and AUDIO elements selectable in Edición mode.
 *
 * The engine's PngElement/TextElement/ComponentElement render their host with
 * `data-parallax-id`, so the geometric hit-test in useSelection.ts finds them.
 * VideoElement/AudioElement do NOT — their host is just
 * `<div class="parallax-video-element">` / `.parallax-audio-element` with no
 * id attribute. We cannot patch the engine, so we patch the editor side:
 *
 *  1. After every preview render we walk the preview DOM. For each
 *     `.parallax-layer` we map its direct element-host children to the
 *     layer's `elements` array (the engine renders exactly one host per
 *     element, in array order — see ParallaxLayer v-for keyed by id). Any
 *     video/audio host missing `data-parallax-id` gets it stamped on, so the
 *     existing getBoundingClientRect() hit-test now includes it and
 *     SelectionOverlay's `[data-parallax-id="<id>"]` lookup resolves.
 *
 *  2. The native `<video controls>` and `<audio controls>` capture clicks
 *     before they bubble to the `.editor-canvas @click` handler. In Edición
 *     mode the preview is for LAYOUT only, so we make the media itself
 *     non-interactive (no controls, pointer-events:none) — the canvas-level
 *     hit-test then wins and the video selects like text/png. In Preview
 *     mode we revert so the real interactive video/audio is untouched.
 *
 * Everything here is reversible and only mutates the preview DOM, never
 * state.site.
 */

const HOST_SELECTOR =
  '.parallax-png-element, .parallax-text-element, .parallax-component-element, .parallax-video-element, .parallax-audio-element'
const ID_HOST_SELECTOR = `${HOST_SELECTOR}, [data-parallax-id]`
const STAMPED_ATTR = 'data-editor-hit-stamped'

function isElementHost(node: Element): boolean {
  return (
    node.classList.contains('parallax-png-element') ||
    node.classList.contains('parallax-text-element') ||
    node.classList.contains('parallax-component-element') ||
    node.classList.contains('parallax-video-element') ||
    node.classList.contains('parallax-audio-element') ||
    node.hasAttribute('data-parallax-id')
  )
}

/**
 * The engine renders ONE direct child of `.parallax-layer` per element, in
 * `layer.elements` order. That child is either the element host itself OR an
 * `<a class="parallax-element-link">` wrapper when the element has a `link`.
 * Resolve the actual host node either way.
 */
function resolveHost(directChild: Element): HTMLElement | null {
  if (isElementHost(directChild)) return directChild as HTMLElement
  if (directChild.classList.contains('parallax-element-link')) {
    const inner = directChild.querySelector<HTMLElement>(HOST_SELECTOR) || (directChild.firstElementChild as HTMLElement | null)
    return inner
  }
  // Unknown wrapper: try to dig for a known host so we still align by order.
  return directChild.querySelector<HTMLElement>(HOST_SELECTOR)
}

/**
 * Stamp data-parallax-id onto video/audio hosts by mapping each
 * .parallax-layer's host children to that layer's elements array in order.
 */
function stampMediaIds(root: HTMLElement) {
  const site = state.site
  if (!site) return

  // Flat list of every layer in render order: sections → layers. Use the
  // ACTIVE view's tree so ids stamped onto the preview DOM match whatever
  // viewport (compartido / desktop / mobile) is being edited and rendered.
  const layers: { id: string; type: string }[][] = []
  for (const section of activeSections()) {
    for (const layer of section.layers || []) {
      layers.push((layer.elements || []).map((el: any) => ({ id: el.id, type: el.type })))
    }
  }

  const layerEls = root.querySelectorAll<HTMLElement>('.parallax-layer')
  layerEls.forEach((layerEl, li) => {
    const elements = layers[li]
    if (!elements) return
    // One direct child per rendered element, in array order. Resolve each to
    // its host (handles the optional <a.parallax-element-link> wrapper).
    const hosts = Array.from(layerEl.children)
      .map((c) => resolveHost(c as Element))
      .filter((h): h is HTMLElement => !!h)

    // Engine renders one host per element. If counts match we can map 1:1 by
    // order (covers video/audio which carry NO data-parallax-id).
    if (hosts.length === elements.length) {
      hosts.forEach((host, ei) => {
        const meta = elements[ei]
        if (!host.hasAttribute('data-parallax-id')) {
          host.setAttribute('data-parallax-id', meta.id)
          host.setAttribute(STAMPED_ATTR, '1')
        }
      })
      return
    }

    // Counts diverge (e.g. a video with visible:false renders nothing).
    // Conservative fallback: only video/audio hosts need an id; match them
    // to the layer's video/audio elements in order so we never mis-label.
    const mediaMeta = elements.filter(
      (m) => m.type === 'video' || m.type === 'audio',
    )
    const mediaHosts = hosts.filter(
      (h) =>
        h.classList.contains('parallax-video-element') ||
        h.classList.contains('parallax-audio-element'),
    )
    if (mediaHosts.length === mediaMeta.length) {
      mediaHosts.forEach((host, mi) => {
        if (!host.hasAttribute('data-parallax-id')) {
          host.setAttribute('data-parallax-id', mediaMeta[mi].id)
          host.setAttribute(STAMPED_ATTR, '1')
        }
      })
    }
  })
}

/**
 * In edit mode strip native interactivity off the preview media so the
 * canvas-level geometric hit-test receives the click. In preview mode
 * restore the real interactive media.
 */
function applyMediaInteractivity(root: HTMLElement) {
  const editMode = state.previewMode === 'edit'
  const media = root.querySelectorAll<HTMLMediaElement>(
    '.parallax-video-element video, .parallax-audio-element audio',
  )
  media.forEach((m) => {
    if (editMode) {
      if (m.hasAttribute('controls')) {
        m.setAttribute('data-editor-had-controls', '1')
        m.removeAttribute('controls')
      }
      m.style.pointerEvents = 'none'
    } else {
      if (m.getAttribute('data-editor-had-controls') === '1') {
        m.setAttribute('controls', '')
        m.removeAttribute('data-editor-had-controls')
      }
      m.style.pointerEvents = ''
    }
  })
}

export function usePreviewHitTargets(rootRef: { value: HTMLElement | null }) {
  let mo: MutationObserver | null = null
  let rafId = 0

  function sync() {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => {
      const root = rootRef.value
      if (!root) return
      stampMediaIds(root)
      applyMediaInteractivity(root)
    })
  }

  onMounted(() => {
    sync()
    if (rootRef.value && 'MutationObserver' in window) {
      mo = new MutationObserver(() => sync())
      mo.observe(rootRef.value, { childList: true, subtree: true })
    }
  })

  // Re-stamp / re-apply when the site, edit/preview mode, or the ACTIVE
  // viewport changes (switching desktop↔mobile in independent mode swaps the
  // rendered tree, so ids must be re-stamped against the new tree).
  //
  // TASK #111: deliberately NOT watching state.selectedPath. Selection never
  // adds/removes/re-renders a media host, so re-stamping on every selection was
  // pure churn — and it issued setAttribute() DOM writes into the engine's
  // subtree while enter/split animations were mid-flight. The MutationObserver
  // above already re-syncs whenever the engine actually mutates its DOM (e.g.
  // a video host mounting), so selection has nothing to do here.
  watch(
    () => [state.site, state.previewMode, state.deviceMode],
    sync,
    { deep: true },
  )

  onBeforeUnmount(() => {
    if (mo) mo.disconnect()
    if (rafId) cancelAnimationFrame(rafId)
  })

  return { syncHitTargets: sync }
}

// Re-export so tests / callers can reference the selector if needed.
export { ID_HOST_SELECTOR }
