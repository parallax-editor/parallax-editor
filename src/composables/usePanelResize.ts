import { ref, onBeforeUnmount, type Ref } from 'vue'

/**
 * Illustrator-style resizable side panels (TASK #84).
 *
 * Each side panel (CAPAS left, PROPIEDADES right, Conversación con Claude
 * bottom dock) gets a thin grab handle on its inner edge. Dragging the handle
 * with the pointer resizes the panel LIVE; the center canvas flexes to take
 * the remaining space (the 3-column flex row is untouched — we only change the
 * panel's fixed main-axis size). Size is clamped to [min, 50% of viewport] on
 * every move AND on window resize, and persisted to localStorage so it
 * survives reload / tab close.
 *
 * Persistence: a single GLOBAL key (`parallax-editor:panel-sizes`), matching
 * how the other global UI prefs are stored (Autosave / Grid / Vista completa
 * under `parallax-editor:prefs`) — panel chrome is a workspace preference, not
 * per-project content state. Corrupt / unavailable storage is non-fatal: we
 * fall back to defaults and just don't persist (same contract as the store's
 * readPrefs/writePrefs).
 *
 * Pointer events (not mouse) so it works with trackpad/pen; pointer capture
 * keeps the drag alive even if the cursor briefly leaves the 6px handle.
 */

export type PanelKey = 'capas' | 'props' | 'claude'
export type ResizeAxis = 'x' | 'y'

const STORAGE_KEY = 'parallax-editor:panel-sizes'

// Defaults double as the MIN size: a panel can never be dragged smaller than
// its shipped width/height (keeps the tree / props / chat usable), and never
// larger than 50% of the relevant viewport dimension.
const DEFAULTS: Record<PanelKey, number> = {
  capas: 240, // px, .panel-left flex-basis/width
  props: 280, // px, .panel-right flex-basis/width
  claude: 240, // px, .bottom-panel height
}

type PanelSizes = Partial<Record<PanelKey, number>>

function readSizes(): PanelSizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: PanelSizes = {}
    for (const k of ['capas', 'props', 'claude'] as PanelKey[]) {
      const v = (parsed as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeSizes(sizes: PanelSizes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
  } catch {
    /* localStorage unavailable / quota — non-fatal, just won't persist */
  }
}

/** Max = 50% of the viewport on the resize axis (live, so it tracks resizes). */
function maxFor(axis: ResizeAxis): number {
  return Math.round((axis === 'x' ? window.innerWidth : window.innerHeight) / 2)
}

function clamp(key: PanelKey, axis: ResizeAxis, v: number): number {
  const min = DEFAULTS[key]
  const max = Math.max(min, maxFor(axis))
  return Math.min(max, Math.max(min, Math.round(v)))
}

/**
 * One reactive size per panel, hydrated from localStorage and clamped to the
 * current viewport at hydration time (a window narrower than when the size was
 * saved must not leave a panel wider than 50%).
 */
const sizes: Record<PanelKey, Ref<number>> = {
  capas: ref(DEFAULTS.capas),
  props: ref(DEFAULTS.props),
  claude: ref(DEFAULTS.claude),
}

let hydrated = false
function hydrate() {
  if (hydrated) return
  hydrated = true
  const saved = readSizes()
  ;(['capas', 'props', 'claude'] as PanelKey[]).forEach((k) => {
    const axis: ResizeAxis = k === 'claude' ? 'y' : 'x'
    if (typeof saved[k] === 'number') sizes[k].value = clamp(k, axis, saved[k] as number)
  })
}

function persist() {
  writeSizes({
    capas: sizes.capas.value,
    props: sizes.props.value,
    claude: sizes.claude.value,
  })
}

// A single window-resize listener re-clamps every panel so none can exceed 50%
// after the viewport shrinks. Installed once, ref-counted by mounted consumers.
let resizeListeners = 0
function onWindowResize() {
  let changed = false
  ;(['capas', 'props', 'claude'] as PanelKey[]).forEach((k) => {
    const axis: ResizeAxis = k === 'claude' ? 'y' : 'x'
    const c = clamp(k, axis, sizes[k].value)
    if (c !== sizes[k].value) {
      sizes[k].value = c
      changed = true
    }
  })
  if (changed) persist()
}

export function usePanelResize() {
  hydrate()

  if (resizeListeners === 0) window.addEventListener('resize', onWindowResize)
  resizeListeners++
  onBeforeUnmount(() => {
    resizeListeners--
    if (resizeListeners === 0) window.removeEventListener('resize', onWindowResize)
  })

  /**
   * Wire a handle element. `key` selects which panel size to drive; `axis` is
   * 'x' for the side panels (drag horizontally) or 'y' for the bottom dock.
   * `direction` is +1 when dragging toward larger coords grows the panel
   * (CAPAS: handle on its right, drag right → wider), -1 when it shrinks it
   * (PROPIEDADES: handle on its left, drag left → wider; Claude: handle on
   * top, drag up → taller).
   */
  function onHandlePointerDown(
    e: PointerEvent,
    key: PanelKey,
    axis: ResizeAxis,
    direction: 1 | -1,
  ) {
    // Left button / primary pointer only; don't hijack right-click etc.
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const startCoord = axis === 'x' ? e.clientX : e.clientY
    const startSize = sizes[key].value
    const handle = e.currentTarget as HTMLElement
    const pointerId = e.pointerId
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      /* capture unsupported — listeners below still track the drag */
    }

    // Suppress text selection / wrong cursor flicker for the DURATION of the
    // drag only. The body override (cursor + user-select) is applied now and
    // RELIABLY reverted in cleanup() — which runs on pointerup, pointercancel,
    // lostpointercapture AND window blur (#96: the cursor used to stay stuck
    // over the whole panel when the gesture ended outside the handle or the
    // window lost focus mid-drag and no pointerup was ever delivered).
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'

    function onMove(ev: PointerEvent) {
      const cur = axis === 'x' ? ev.clientX : ev.clientY
      const delta = (cur - startCoord) * direction
      sizes[key].value = clamp(key, axis, startSize + delta)
    }

    // Idempotent teardown: detach EVERY listener, drop pointer capture, and
    // restore the body cursor / user-select to exactly what they were. Safe to
    // call more than once (pointerup may fire alongside lostpointercapture).
    let done = false
    function cleanup() {
      if (done) return
      done = true
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', cleanup)
      handle.removeEventListener('pointercancel', cleanup)
      handle.removeEventListener('lostpointercapture', cleanup)
      window.removeEventListener('blur', cleanup)
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        /* nothing captured */
      }
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      persist()
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', cleanup)
    handle.addEventListener('pointercancel', cleanup)
    // Pointer capture means a release OUTSIDE the thin handle still ends the
    // gesture; if capture is lost for any reason, that also ends it.
    handle.addEventListener('lostpointercapture', cleanup)
    // Last-resort safety net: alt-tab / OS dialog steals focus mid-drag → no
    // pointerup ever arrives. Without this the resize cursor stays stuck.
    window.addEventListener('blur', cleanup)
  }

  /** Double-click a handle → reset that panel to its shipped default. */
  function resetPanel(key: PanelKey) {
    sizes[key].value = DEFAULTS[key]
    persist()
  }

  return { sizes, onHandlePointerDown, resetPanel, DEFAULTS }
}
