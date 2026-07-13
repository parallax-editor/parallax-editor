<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state, getAtPath, setAtPath, setAtPathSilent, pushUndoOnce, isPathLocked, isNodeLockedById, VIEWPORTS, GRID_PERCENT, markDragEnded, setCanvasDragActive, hasMultiSelection, multiSelectedElementPaths, setCanvasSelection, toggleCanvasSelection } from '../../stores/editor'
import { elementAtPoint, findElementPath, pointInArtboard } from '../../composables/useSelection'

const props = defineProps<{
  canvasRef: HTMLElement | null
  zoom: number
  scrollKey?: number
}>()

// Box in CANVAS-LOCAL coordinates (relative to the .editor-canvas element),
// so the overlay is correct regardless of the pan-wrapper transform.
const bounds = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const isDragging = ref(false)
const dragType = ref<'move' | 'resize' | 'rotate' | null>(null)
const dragStart = ref({ x: 0, y: 0 })
const dragOriginal = ref<any>({})
const activeHandle = ref<string | null>(null)

// ── Click-through selection on the move-area (#110) ──────────────────────────
// A press on a selected element's .move-area must NOT immediately commit to a
// move. We arm a PENDING move (record the start + the drag origin) and only
// promote it to a real drag once the pointer travels past DRAG_THRESHOLD px. If
// the press releases without crossing the threshold it was a plain CLICK: we
// run the canvas geometric hit-test at that point and select the TOP-MOST
// [data-parallax-id] there (Illustrator behavior — a click always selects the
// front element under the cursor, even when a larger/back element is currently
// selected and its move-area covers it). `pendingKind` says which move-area was
// pressed so mouseup can route to single vs group selection / shift toggle.
const DRAG_THRESHOLD = 4
const pendingMove = ref(false)
const pendingKind = ref<'single' | 'group' | null>(null)
// Subtle Spanish hint shown when a drag had to convert a responsive expression
// (clamp()/min()/auto) to a concrete % so it stays WYSIWYG. Transient.
const dragHint = ref<string | null>(null)
let hintTimer: any = 0
let rafId = 0

function flashDragHint(msg: string) {
  dragHint.value = msg
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    if (dragHint.value === msg) dragHint.value = null
  }, 2600)
}

// ─── Inline text editing (double-click) ──────────────────────────────────────
// Illustrator-style: double-clicking a TEXT element on the canvas turns the
// element's DOM node into a contentEditable surface. Typing edits the live
// preview AND persists `element.content` to the store. Esc / Enter / blur /
// click outside commits. Re-entrant safe: we tear down any prior session
// before starting a new one.
const inlineEditing = ref(false)
let inlineEditNode: HTMLElement | null = null
let inlineEditPath: string | null = null
let inlineEditOnInput: ((e: Event) => void) | null = null
let inlineEditOnBlur: ((e: Event) => void) | null = null
let inlineEditOnKeydown: ((e: KeyboardEvent) => void) | null = null

function stopInlineTextEdit(commit = true) {
  if (!inlineEditing.value) return
  const node = inlineEditNode
  const path = inlineEditPath
  if (node) {
    node.removeAttribute('contenteditable')
    node.style.cursor = ''
    node.style.outline = ''
    if (inlineEditOnInput) node.removeEventListener('input', inlineEditOnInput)
    if (inlineEditOnBlur) node.removeEventListener('blur', inlineEditOnBlur)
    if (inlineEditOnKeydown) node.removeEventListener('keydown', inlineEditOnKeydown)
    // Commit final value once more in case the input listener missed the
    // last keystroke before blur fired.
    if (commit && path) {
      const text = node.innerText
      setAtPath(`${path}.content`, text)
    }
  }
  inlineEditing.value = false
  inlineEditNode = null
  inlineEditPath = null
  inlineEditOnInput = null
  inlineEditOnBlur = null
  inlineEditOnKeydown = null
}

function startInlineTextEdit(e: MouseEvent) {
  // Only text elements. Other types fall through to the default move-area
  // behavior (which double-click does not trigger anyway).
  if (!state.selectedPath) return
  const node = getAtPath(state.selectedPath)
  if (!node || node.type !== 'text') return
  e.preventDefault()
  e.stopPropagation()
  const dom = findDomElement()
  if (!dom) return
  // Tear down any previous session targeting a different element.
  stopInlineTextEdit(false)
  inlineEditing.value = true
  inlineEditNode = dom
  inlineEditPath = state.selectedPath
  dom.setAttribute('contenteditable', 'plaintext-only')
  dom.style.cursor = 'text'
  dom.style.outline = '2px solid var(--accent-strong, #b06bff)'
  // NO live store sync during typing: writing to `content` on every
  // keystroke makes Vue re-render the engine, which resets innerText on
  // this same DOM node and clobbers the caret. The user saw their typing
  // appear backwards because every new char's caret position was reset to 0.
  // The contentEditable element holds the typed text on its own; we read
  // innerText and persist on commit (Enter / Esc / blur).
  inlineEditOnInput = null
  inlineEditOnBlur = () => stopInlineTextEdit(true)
  inlineEditOnKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      stopInlineTextEdit(true)
    }
    // Enter (without shift) commits and exits. Shift+Enter inserts a newline.
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      stopInlineTextEdit(true)
    }
  }
  dom.addEventListener('blur', inlineEditOnBlur)
  dom.addEventListener('keydown', inlineEditOnKeydown)
  // Focus + place caret AT THE DOUBLE-CLICK POINT (Illustrator-style) so
  // editing starts where the user pointed, not at the end.
  //
  // History: the original fix called `document.caretPositionFromPoint(x, y)`
  // after punching `pointer-events: none` on every overlay layer in the
  // `elementsFromPoint` stack. That only works if every blocker is in the
  // stack AND `caretPositionFromPoint` honors pointer-events the way we
  // assume — neither was reliable here (the engine sometimes paints extra
  // wrappers, and the API's hit-test behavior varies by browser engine).
  // The reproducible failure was: caret kept landing at the END regardless
  // of where the user double-clicked.
  //
  // Robust approach: don't ask the browser to hit-test at all. Walk every
  // Text node inside `dom` and use Range rects to find which character box
  // the click point falls into. Self-contained, immune to overlay layers,
  // pointer-events, scale transforms (rects already include the CTM), and
  // engine-rendered wrappers like split-text span hosts.
  dom.focus()
  try {
    const sel = window.getSelection()
    if (!sel) throw new Error('no selection api')
    let range = caretRangeInsideAtPoint(dom, e.clientX, e.clientY)
    // Fallback: caret at end of text content (dblclick on padding / outside
    // any text node, or no text nodes at all). Better than collapsing to
    // start which would land BEFORE all the existing copy.
    if (!range) {
      range = document.createRange()
      range.selectNodeContents(dom)
      range.collapse(false)
    }
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {
    /* selection APIs can fail in odd contexts; non-fatal */
  }
}

// Returns a collapsed Range at the caret position closest to (x, y) inside
// `host`. Walks every descendant Text node, scans each character's client
// rect (built from a transient Range), and returns the closest insertion
// point. Independent of pointer-events / overlay stacking / browser-specific
// caretPositionFromPoint hit-testing — the only inputs are character rects
// the browser already computed for layout. Returns null if `host` has no
// non-empty text node (caller falls back to "end").
function caretRangeInsideAtPoint(host: HTMLElement, x: number, y: number): Range | null {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  // Best match by (vertical-distance-to-line, horizontal-distance-to-caret).
  // Vertical wins so multi-line text lands on the right line; horizontal is
  // the tiebreaker within the line. We also track an "in-rect" exact hit so a
  // click squarely on a character returns immediately.
  let bestNode: Text | null = null
  let bestOffset = 0
  let bestVert = Infinity
  let bestHoriz = Infinity
  const probe = document.createRange()
  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.length
    if (len === 0) { node = walker.nextNode() as Text | null; continue }
    // For each char gap (0..len), measure the rect of the surrounding char so
    // we can decide which side of the glyph the pointer landed on. Iterate
    // char-by-char (cheap; text in the editor is bounded).
    for (let i = 0; i < len; i++) {
      try {
        probe.setStart(node, i)
        probe.setEnd(node, i + 1)
      } catch { continue }
      // A char can span multiple rects (line wrap inside one Text node), so
      // examine each rect — getClientRects(), not getBoundingClientRect().
      const rects = probe.getClientRects()
      for (let r = 0; r < rects.length; r++) {
        const rect = rects[r]
        if (rect.width === 0 && rect.height === 0) continue
        const inside = y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right
        // Vertical distance to the LINE this char lives on (0 when y is
        // between rect.top and rect.bottom).
        const vert = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
        // Decide whether the caret should land BEFORE the char (offset i) or
        // AFTER (offset i+1) based on which side of the char center x is on.
        const mid = (rect.left + rect.right) / 2
        const before = x < mid
        const caretX = before ? rect.left : rect.right
        const horiz = Math.abs(x - caretX)
        const offset = before ? i : i + 1
        if (
          vert < bestVert
          || (vert === bestVert && horiz < bestHoriz)
        ) {
          bestVert = vert
          bestHoriz = horiz
          bestNode = node
          bestOffset = offset
          if (inside && vert === 0) {
            // Exact hit — no closer caret exists. Bail.
            const out = document.createRange()
            out.setStart(node, offset)
            out.collapse(true)
            return out
          }
        }
      }
    }
    node = walker.nextNode() as Text | null
  }
  if (!bestNode) return null
  const out = document.createRange()
  try {
    out.setStart(bestNode, bestOffset)
    out.collapse(true)
  } catch {
    return null
  }
  return out
}

function findDomElement(): HTMLElement | null {
  if (!state.selectedPath) return null
  const selected = getAtPath(state.selectedPath)
  if (!selected?.id) return null
  return document.querySelector(`[data-parallax-id="${selected.id}"]`)
}

/**
 * Derive the selection rect from the ACTUAL rendered DOM element, expressed
 * relative to the canvas container. We do NOT recompute from JSON position,
 * so this stays correct at any zoom / artboard offset / device-frame size,
 * and once the engine positioning fix lands it tracks automatically.
 */
function updateBounds() {
  if (!state.selectedPath || !props.canvasRef) { bounds.value = null; return }
  const el = state.site ? findDomElement() : null
  if (!el) { bounds.value = null; return }
  const elRect = el.getBoundingClientRect()
  const canvasRect = props.canvasRef.getBoundingClientRect()
  bounds.value = {
    left: elRect.left - canvasRect.left,
    top: elRect.top - canvasRect.top,
    width: elRect.width,
    height: elRect.height,
  }
}

function scheduleUpdate() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    updateBounds()
    // Keep the group bbox in sync with the same triggers (GAP5). Cheap no-op
    // when <2 are selected.
    updateGroupBounds()
  })
}

// Re-measure when selection (single OR multi), site, zoom, pan, device,
// preview scroll, or a preview re-mount (previewNonce) change.
watch(
  () => [state.selectedPath, state.selectedPaths, state.site, state.canvasZoom, state.canvasPan.x, state.canvasPan.y, state.deviceMode, props.scrollKey, state.previewNonce],
  scheduleUpdate,
  { deep: true },
)

// "Reiniciar mesa" re-mounts the preview ParallaxSite: the previously selected
// [data-parallax-id] DOM node is DESTROYED and RECREATED. Between destroy and
// recreate the old rect is stale and may briefly be missing. Drop the current
// bounds and poll over several frames until the recreated node is found again
// (engine remount + animation init can take a few frames), keeping the overlay
// glued to the selection across the restart. Always retry until found —
// don't bail on a stale truthy bounds value.
watch(
  () => state.previewNonce,
  () => {
    if (!state.selectedPath) return
    bounds.value = null
    let tries = 0
    const tick = () => {
      updateBounds()
      tries++
      // Keep polling while the recreated node hasn't been measured yet.
      if (!bounds.value && tries < 40) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  },
)

let ro: ResizeObserver | null = null

onMounted(() => {
  scheduleUpdate()
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('resize', scheduleUpdate)
  if (props.canvasRef && 'ResizeObserver' in window) {
    ro = new ResizeObserver(scheduleUpdate)
    ro.observe(props.canvasRef)
  }
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('resize', scheduleUpdate)
  if (ro) ro.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
  if (hintTimer) clearTimeout(hintTimer)
})

// ─── Unit-preserving value model ───────────────────────────────────────────
//
// position.x/y and size.width/height accept (schema lengthValue):
//   • a bare number  → engine reads it as a PERCENT of the section box
//   • "<n>%"          → percent of the section box
//   • "<n>px"         → absolute px
//   • a responsive expression: "min(…)", "max(…)", "clamp(…)", "calc(…)",
//     "auto", "<n>vw/vh/rem/em" — NOT a single scalar we can delta-adjust.
//
// A drag must NEVER coerce any of these to a different unit or strip the
// expression. So we parse the stored value into a typed cell, do the geometry
// in PERCENT of the real section box (the element's positioning context — what
// the engine actually resolves % against, so it's exact at any zoom/scroll),
// then re-emit:
//   • number   → number (percent semantics preserved)
//   • percent  → "<n>%"
//   • px       → "<n>px" (delta converted px↔% via the live section box)
//   • expr     → can't be safely delta-adjusted: convert the element's MEASURED
//                pixel rect → % of the section box and write a concrete "<n>%".
//                This is exact at the moment of the drag (WYSIWYG) and stays
//                fully editable; it never writes garbage into the expression.
//   • absent   → treated as percent (engine default) so a fresh element drags.

type Kind = 'number' | 'percent' | 'px' | 'expr' | 'absent'
interface Cell { kind: Kind; n: number }

function parseCell(raw: any): Cell {
  if (raw == null) return { kind: 'absent', n: 0 }
  if (typeof raw === 'number') return { kind: 'number', n: raw }
  const s = String(raw).trim()
  let m = s.match(/^(-?\d*\.?\d+)\s*%$/)
  if (m) return { kind: 'percent', n: parseFloat(m[1]) }
  m = s.match(/^(-?\d*\.?\d+)\s*px$/i)
  if (m) return { kind: 'px', n: parseFloat(m[1]) }
  m = s.match(/^(-?\d*\.?\d+)$/)
  if (m) return { kind: 'number', n: parseFloat(m[1]) }
  return { kind: 'expr', n: NaN }
}

const round1 = (v: number) => Math.round(v * 10) / 10

// ─── Artboard clamp (issue #53) ─────────────────────────────────────────────
//
// position.x/y is the % position of the element's ANCHOR point within its
// section box. With anchor fraction fx (left 0, center .5, right 1) and the
// element's width W (% of the section box) the element's box spans
//   [ posX − fx·W ,  posX + (1−fx)·W ]   (analogously posY/fy/H on Y).
//
// To keep the element fully INSIDE the section/artboard (0..100% of its own
// section) the anchor position must satisfy
//   posX ∈ [ fx·W ,  100 − (1−fx)·W ]
// i.e. left edge ≥ 0 and right edge ≤ 100. clampPos() returns the nearest
// in-range value. When the element is WIDER than the section (W ≥ 100 the
// valid interval collapses/inverts) we can't keep both edges in — we then pin
// it so its box is centred over the section (best-visible: it still overlaps
// the mesa instead of wandering off). Edges exactly at 0%/100% stay legal
// (the bounds are inclusive), so legitimate full-bleed positioning is intact.
function clampPos(pos: number, frac: number, sizePct: number): number {
  const s = Math.max(0, sizePct)
  const lo = frac * s
  const hi = 100 - (1 - frac) * s
  if (lo > hi) {
    // Element bigger than its section on this axis: centre its box over the
    // section so it stays maximally visible rather than escaping the mesa.
    return (lo + hi) / 2
  }
  return Math.min(hi, Math.max(lo, pos))
}

// Element extent (% of section box) on an axis from a size Cell. number/percent
// → its scalar; px → converted via the live section dim; expr/absent → the
// element's MEASURED rect (so clamping a clamp()/auto-sized box is still exact).
function extentPct(cell: Cell, dimPx: number, measuredPx: number | undefined): number {
  if (cell.kind === 'percent' || cell.kind === 'number') return Math.max(0, cell.n)
  if (cell.kind === 'px' && dimPx > 0) return Math.max(0, (cell.n / dimPx) * 100)
  if (measuredPx != null && dimPx > 0) return Math.max(0, (measuredPx / dimPx) * 100)
  return 0
}

// Re-emit a cell given a NEW value expressed as PERCENT of the section box
// `dimPx` is the relevant section box dimension (width for x/width, height for
// y/height) in unscaled artboard px, used for the px<->% conversion.
function emitCell(cell: Cell, newPercent: number, dimPx: number, isExprFallback: boolean): { value: any; converted: boolean } {
  if (cell.kind === 'px') {
    return { value: `${round1((newPercent / 100) * dimPx)}px`, converted: false }
  }
  if (cell.kind === 'percent') {
    return { value: `${round1(newPercent)}%`, converted: false }
  }
  if (cell.kind === 'expr') {
    // Can't delta-adjust an expression → replace with the exact equivalent %.
    return { value: `${round1(newPercent)}%`, converted: isExprFallback }
  }
  // number | absent → engine treats a number as a percent.
  return { value: round1(newPercent), converted: false }
}

// The element's positioning context: the rendered <section> (position:relative,
// offset parent of the absolutely-positioned layer/element). position.x/y % and
// size % resolve against THIS box, so it's the exact reference for px<->%.
function sectionBox(): { width: number; height: number } | null {
  const el = findDomElement()
  const sec = el?.closest('.parallax-section') as HTMLElement | null
  if (!sec) return null
  const r = sec.getBoundingClientRect()
  // Divide out the live zoom so we work in UNSCALED artboard px (matches the
  // engine's % math, which is independent of the editor's preview scale).
  const z = props.zoom || 1
  return { width: r.width / z, height: r.height / z }
}

// Current rendered element rect in UNSCALED artboard px, plus its position
// within the section box (for expr → % fallback: measured rect → % of section).
function measuredRectInSection(): { x: number; y: number; w: number; h: number } | null {
  const el = findDomElement()
  const sec = el?.closest('.parallax-section') as HTMLElement | null
  if (!el || !sec) return null
  const er = el.getBoundingClientRect()
  const sr = sec.getBoundingClientRect()
  const z = props.zoom || 1
  return {
    x: (er.left - sr.left) / z,
    y: (er.top - sr.top) / z,
    w: er.width / z,
    h: er.height / z,
  }
}

// ─── Group selection (GAP5): per-path DOM/section helpers ──────────────────
//
// The single-select helpers above resolve against state.selectedPath. The
// group move needs the SAME geometry per selected element, so these mirror
// findDomElement / sectionBox / measuredRectInSection but take an explicit
// view-relative path. They are ONLY used by the group-move path; the
// single-select path is byte-for-byte unchanged.
function domElForPath(path: string): HTMLElement | null {
  const node = getAtPath(path)
  if (!node?.id) return null
  return document.querySelector(`[data-parallax-id="${node.id}"]`)
}
function sectionBoxForEl(el: HTMLElement | null): { width: number; height: number } | null {
  const sec = el?.closest('.parallax-section') as HTMLElement | null
  if (!sec) return null
  const r = sec.getBoundingClientRect()
  const z = props.zoom || 1
  return { width: r.width / z, height: r.height / z }
}
function measuredRectForEl(
  el: HTMLElement | null,
): { x: number; y: number; w: number; h: number } | null {
  const sec = el?.closest('.parallax-section') as HTMLElement | null
  if (!el || !sec) return null
  const er = el.getBoundingClientRect()
  const sr = sec.getBoundingClientRect()
  const z = props.zoom || 1
  return {
    x: (er.left - sr.left) / z,
    y: (er.top - sr.top) / z,
    w: er.width / z,
    h: er.height / z,
  }
}

// Union bounding box (canvas-local px) of all multi-selected elements — the
// group selection frame. Null unless 2+ are selected and measurable.
const groupBounds = ref<{ left: number; top: number; width: number; height: number } | null>(null)

function updateGroupBounds() {
  if (!hasMultiSelection.value || !props.canvasRef) {
    groupBounds.value = null
    return
  }
  const canvasRect = props.canvasRef.getBoundingClientRect()
  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity
  let any = false
  for (const p of multiSelectedElementPaths.value) {
    const el = domElForPath(p)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    any = true
    minL = Math.min(minL, r.left - canvasRect.left)
    minT = Math.min(minT, r.top - canvasRect.top)
    maxR = Math.max(maxR, r.right - canvasRect.left)
    maxB = Math.max(maxB, r.bottom - canvasRect.top)
  }
  groupBounds.value = any
    ? { left: minL, top: minT, width: maxR - minL, height: maxB - minT }
    : null
}

// Any selected element locked → the whole group is treated as locked (no
// group drag), consistent with single-select lock behavior.
const groupHasLock = computed(() =>
  multiSelectedElementPaths.value.some((p) => {
    const n = getAtPath(p)
    return n && isNodeLockedById(n.id)
  }),
)

// Per-element drag origin captured at group-move start: the SAME fields the
// single-element startMove() snapshots, so the per-element apply reuses the
// verified anchor-aware + unit-preserving + clamp math verbatim.
interface GroupDragItem {
  path: string
  xPct: number
  yPct: number
  cellX: Cell
  cellY: Cell
  fx: number
  fy: number
  wPct: number
  hPct: number
  boxW: number
  boxH: number
}
const groupDragItems = ref<GroupDragItem[]>([])
const isGroupDragging = ref(false)

// Group RESIZE (escalar varios juntos): snapshot por elemento + escala alrededor
// de la esquina/borde OPUESTO al handle arrastrado. Geometría en px de canvas
// (los ratios son independientes del zoom) → % por sección, emitido con emitCell
// (preserva la unidad %/px de cada elemento). Posición y tamaño escalan; un
// elemento SIN size explícito solo se reposiciona (no se le inventa tamaño).
interface GroupResizeItem {
  path: string
  cellX: Cell; cellY: Cell; cellW: Cell; cellH: Cell
  hasW: boolean; hasH: boolean
  fx: number; fy: number
  xPct: number; yPct: number; wPct: number; hPct: number
  boxW: number; boxH: number
  anchorCanvasX: number; anchorCanvasY: number
}
const groupResizeItems = ref<GroupResizeItem[]>([])
const groupResizeOrig = ref<{ width: number; height: number; anchorX: number; anchorY: number } | null>(null)
const isGroupResizing = ref(false)
const groupResizeHandle = ref('')

// ─── Drag handlers ──────────────────────────────────────────

// A locked node can't be moved/resized/rotated on the canvas. We block the
// drag at its start (the overlay still shows so the user sees it's selected,
// but the box reads as locked and no handle does anything).
const isLocked = computed(() => isPathLocked(state.selectedPath))

// Anchor → fractional offset (which point of the element sits at position).
// Mirrors the engine's ANCHOR_OFFSETS exactly: x ∈ {left:0, center:.5, right:1},
// y ∈ {top:0, center:.5, bottom:1}.
function anchorFractions(anchor: string | undefined): { fx: number; fy: number } {
  const a = anchor || 'center'
  const map: Record<string, [number, number]> = {
    'center': [0.5, 0.5],
    'top-left': [0, 0],
    'top-right': [1, 0],
    'bottom-left': [0, 1],
    'bottom-right': [1, 1],
    'top': [0.5, 0],
    'bottom': [0.5, 1],
    'left': [0, 0.5],
    'right': [1, 0.5],
  }
  const [fx, fy] = map[a] || [0.5, 0.5]
  return { fx, fy }
}

function startMove(e: MouseEvent) {
  if (state.tool !== 'select' || !state.selectedPath || isLocked.value) return
  // Space pan modifier active → let the canvas pan; don't start a move even
  // when the press lands on the selected element (GAP9).
  if (state.spacePanning) return
  // Shift+press over the selected element must NOT start a move — it's a
  // multi-select toggle (GAP5). Let it bubble to the canvas click handler.
  if (e.shiftKey) return
  e.stopPropagation()
  // Click-through (#110): arm a PENDING move. We only become a real drag once
  // the pointer crosses DRAG_THRESHOLD (handled in onMouseMove). A release
  // without crossing it → treated as a click → topmost-element hit-test.
  pendingMove.value = true
  pendingKind.value = 'single'
  dragType.value = 'move'
  dragStart.value = { x: e.clientX, y: e.clientY }
  const el = getAtPath(state.selectedPath)
  const box = sectionBox()
  const meas = measuredRectInSection()
  const px = parseCell(el?.position?.x)
  const py = parseCell(el?.position?.y)
  const { fx, fy } = anchorFractions(el?.anchor)
  // Starting position as PERCENT of the section box. For number/percent use the
  // stored value verbatim (preserves it). For px/expr/absent derive the
  // equivalent % from the measured rect so the drag continues from where the
  // element visibly is (WYSIWYG) — never from a wrong coerced number.
  const startXPct =
    px.kind === 'percent' || px.kind === 'number'
      ? px.n
      : box && meas
        ? ((meas.x + fx * meas.w) / box.width) * 100
        : 50
  const startYPct =
    py.kind === 'percent' || py.kind === 'number'
      ? py.n
      : box && meas
        ? ((meas.y + fy * meas.h) / box.height) * 100
        : 50
  // Element extent (% of the section box) on each axis + anchor fractions, so
  // the move can be CLAMPED to keep the element's box inside the artboard
  // (issue #53). Width/height parsed like position; expr/auto/absent fall back
  // to the live measured rect → % so a clamp()/auto box still clamps exactly.
  const cw = parseCell(el?.size?.width)
  const ch = parseCell(el?.size?.height)
  const wPct = extentPct(cw, box?.width ?? 0, meas?.w)
  const hPct = extentPct(ch, box?.height ?? 0, meas?.h)
  dragOriginal.value = {
    xPct: startXPct,
    yPct: startYPct,
    cellX: px,
    cellY: py,
    fx,
    fy,
    wPct,
    hPct,
  }
}

// ─── Group move (GAP5) ──────────────────────────────────────────────────────
//
// Drag the group's bounding box → translate EVERY selected element by the same
// pointer delta. Each element keeps its OWN anchor, OWN unit, and is clamped
// to its OWN section, reusing the exact single-element math (parseCell /
// anchorFractions / extentPct / clampPos / emitCell). Group resize/rotate are
// intentionally NOT implemented (out of scope per the plan).
function startGroupMove(e: MouseEvent) {
  if (state.tool !== 'select' || !hasMultiSelection.value) return
  if (state.spacePanning || groupHasLock.value) return
  // Shift+press inside the group box = add/remove an element from the
  // selection (handled by the canvas click), not a group drag.
  if (e.shiftKey) return
  e.stopPropagation()
  // Click-through (#110): arm a PENDING group move; promote to a real group
  // drag only past DRAG_THRESHOLD. A plain click inside the group box selects
  // the topmost element under the cursor (collapsing the group to it).
  pendingMove.value = true
  pendingKind.value = 'group'
  dragType.value = 'move'
  dragStart.value = { x: e.clientX, y: e.clientY }
  const vp = VIEWPORTS[state.deviceMode]
  const items: GroupDragItem[] = []
  for (const path of multiSelectedElementPaths.value) {
    const el = getAtPath(path)
    if (!el) continue
    const dom = domElForPath(path)
    const box = sectionBoxForEl(dom)
    const meas = measuredRectForEl(dom)
    const px = parseCell(el?.position?.x)
    const py = parseCell(el?.position?.y)
    const { fx, fy } = anchorFractions(el?.anchor)
    const startXPct =
      px.kind === 'percent' || px.kind === 'number'
        ? px.n
        : box && meas
          ? ((meas.x + fx * meas.w) / box.width) * 100
          : 50
    const startYPct =
      py.kind === 'percent' || py.kind === 'number'
        ? py.n
        : box && meas
          ? ((meas.y + fy * meas.h) / box.height) * 100
          : 50
    const cw = parseCell(el?.size?.width)
    const ch = parseCell(el?.size?.height)
    items.push({
      path,
      xPct: startXPct,
      yPct: startYPct,
      cellX: px,
      cellY: py,
      fx,
      fy,
      wPct: extentPct(cw, box?.width ?? 0, meas?.w),
      hPct: extentPct(ch, box?.height ?? 0, meas?.h),
      boxW: box ? box.width : vp.width,
      boxH: box ? box.height : vp.height,
    })
  }
  groupDragItems.value = items
}

function applyGroupMove(e: MouseEvent) {
  const dx = (e.clientX - dragStart.value.x) / props.zoom
  const dy = (e.clientY - dragStart.value.y) / props.zoom
  for (const it of groupDragItems.value) {
    // Same delta in % of EACH element's OWN section box (so elements in
    // differently-sized sections still move by the same on-screen amount).
    let newX = it.xPct + (dx / it.boxW) * 100
    let newY = it.yPct + (dy / it.boxH) * 100
    if (state.snapToGrid) {
      newX = Math.round(newX / GRID_PERCENT) * GRID_PERCENT
      newY = Math.round(newY / GRID_PERCENT) * GRID_PERCENT
    }
    // Item #3(a): no bounds clamp on a group move either — overflow is clipped
    // by the engine, so elements may be dragged outside their sections freely.
    const ox = emitCell(it.cellX, newX, it.boxW, true)
    const oy = emitCell(it.cellY, newY, it.boxH, true)
    setAtPathSilent(`${it.path}.position`, { x: ox.value, y: oy.value })
  }
}

// ─── Group resize (escalar el grupo) ─────────────────────────────────────────
function startGroupResize(e: MouseEvent, handle: string) {
  if (state.tool !== 'select' || !hasMultiSelection.value) return
  if (state.spacePanning || groupHasLock.value || !groupBounds.value || !props.canvasRef) return
  e.stopPropagation()
  isDragging.value = true
  isGroupResizing.value = true
  setCanvasDragActive(true)
  dragType.value = 'resize'
  groupResizeHandle.value = handle
  dragStart.value = { x: e.clientX, y: e.clientY }
  const gb = groupBounds.value
  groupResizeOrig.value = {
    width: gb.width || 1,
    height: gb.height || 1,
    // Esquina/borde FIJO = el opuesto al handle arrastrado (en px de canvas).
    anchorX: handle.includes('w') ? gb.left + gb.width : gb.left,
    anchorY: handle.includes('n') ? gb.top + gb.height : gb.top,
  }
  const canvasRect = props.canvasRef.getBoundingClientRect()
  const vp = VIEWPORTS[state.deviceMode]
  const items: GroupResizeItem[] = []
  for (const path of multiSelectedElementPaths.value) {
    const el = getAtPath(path)
    if (!el) continue
    const dom = domElForPath(path)
    const box = sectionBoxForEl(dom)
    const meas = measuredRectForEl(dom)
    const px = parseCell(el?.position?.x); const py = parseCell(el?.position?.y)
    const cw = parseCell(el?.size?.width); const ch = parseCell(el?.size?.height)
    const { fx, fy } = anchorFractions(el?.anchor)
    const rect = dom?.getBoundingClientRect()
    items.push({
      path, cellX: px, cellY: py, cellW: cw, cellH: ch,
      hasW: el?.size?.width != null,
      hasH: el?.size?.height != null,
      fx, fy,
      xPct: px.kind === 'percent' || px.kind === 'number' ? px.n
        : box && meas ? ((meas.x + fx * meas.w) / box.width) * 100 : 50,
      yPct: py.kind === 'percent' || py.kind === 'number' ? py.n
        : box && meas ? ((meas.y + fy * meas.h) / box.height) * 100 : 50,
      wPct: extentPct(cw, box?.width ?? 0, meas?.w),
      hPct: extentPct(ch, box?.height ?? 0, meas?.h),
      boxW: box ? box.width : vp.width,
      boxH: box ? box.height : vp.height,
      anchorCanvasX: rect ? rect.left - canvasRect.left + fx * rect.width : 0,
      anchorCanvasY: rect ? rect.top - canvasRect.top + fy * rect.height : 0,
    })
  }
  groupResizeItems.value = items
}

function applyGroupResize(e: MouseEvent) {
  const o = groupResizeOrig.value
  if (!o || !props.canvasRef) return
  const canvasRect = props.canvasRef.getBoundingClientRect()
  const handle = groupResizeHandle.value
  const pX = e.clientX - canvasRect.left
  const pY = e.clientY - canvasRect.top
  let sx = handle.includes('e') ? (pX - o.anchorX) / o.width
    : handle.includes('w') ? (o.anchorX - pX) / o.width : 1
  let sy = handle.includes('s') ? (pY - o.anchorY) / o.height
    : handle.includes('n') ? (o.anchorY - pY) / o.height : 1
  // Shift en una esquina → escala proporcional (mismo factor en ambos ejes).
  if (e.shiftKey && handle.length === 2) { const s = Math.max(sx, sy); sx = s; sy = s }
  sx = Math.max(0.05, sx); sy = Math.max(0.05, sy)
  for (const it of groupResizeItems.value) {
    // El punto de anclaje del elemento se aleja/acerca de la esquina fija según
    // la escala; ese desplazamiento (px canvas) → % de la sección del elemento.
    const dX = (it.anchorCanvasX - o.anchorX) * (sx - 1)
    const dY = (it.anchorCanvasY - o.anchorY) * (sy - 1)
    const newX = it.xPct + (dX / (it.boxW * props.zoom)) * 100
    const newY = it.yPct + (dY / (it.boxH * props.zoom)) * 100
    const ox = emitCell(it.cellX, newX, it.boxW, true)
    const oy = emitCell(it.cellY, newY, it.boxH, true)
    const curPos = getAtPath(`${it.path}.position`) || {}
    setAtPathSilent(`${it.path}.position`, { ...curPos, x: ox.value, y: oy.value })
    // Tamaño: solo elementos CON size explícito (los demás solo se reposicionan).
    if (it.hasW || it.hasH) {
      const cur = getAtPath(`${it.path}.size`) || {}
      const patch: any = { ...cur }
      if (it.hasW) patch.width = emitCell(it.cellW, Math.max(1, it.wPct * sx), it.boxW, true).value
      if (it.hasH) patch.height = emitCell(it.cellH, Math.max(1, it.hPct * sy), it.boxH, true).value
      setAtPathSilent(`${it.path}.size`, patch)
    }
  }
}

function startResize(e: MouseEvent, handle: string) {
  if (isLocked.value || state.spacePanning) return
  e.stopPropagation()
  isDragging.value = true
  // Item #2: a resize also mutates state.site → guard the overview refit.
  setCanvasDragActive(true)
  dragType.value = 'resize'
  activeHandle.value = handle
  dragStart.value = { x: e.clientX, y: e.clientY }
  // Single undo snapshot for the whole resize gesture (mousemove uses
  // setAtPathSilent → no per-pixel undo entries). Without this Cmd+Z had
  // nothing to revert to (or popped an unrelated older snapshot).
  pushUndoOnce()
  const el = getAtPath(state.selectedPath!)
  const box = sectionBox()
  const meas = measuredRectInSection()
  const cw = parseCell(el?.size?.width)
  const ch = parseCell(el?.size?.height)
  const px = parseCell(el?.position?.x)
  const py = parseCell(el?.position?.y)
  const { fx, fy } = anchorFractions(el?.anchor)
  // Sizes as PERCENT of the section box. number/percent verbatim; otherwise
  // (px/expr/absent — e.g. clamp(); or width set, height auto) the measured
  // rect → % so the resize tracks the visible box exactly.
  const startWPct =
    cw.kind === 'percent' || cw.kind === 'number'
      ? cw.n
      : box && meas
        ? (meas.w / box.width) * 100
        : 20
  const startHPct =
    ch.kind === 'percent' || ch.kind === 'number'
      ? ch.n
      : box && meas
        ? (meas.h / box.height) * 100
        : 20
  // Position (anchor point) as % of the section box — needed for the
  // anchor-aware opposite-edge compensation.
  const startXPct =
    px.kind === 'percent' || px.kind === 'number'
      ? px.n
      : box && meas
        ? ((meas.x + fx * meas.w) / box.width) * 100
        : 50
  const startYPct =
    py.kind === 'percent' || py.kind === 'number'
      ? py.n
      : box && meas
        ? ((meas.y + fy * meas.h) / box.height) * 100
        : 50
  dragOriginal.value = {
    wPct: startWPct,
    hPct: startHPct,
    xPct: startXPct,
    yPct: startYPct,
    cellW: cw,
    cellH: ch,
    cellX: px,
    cellY: py,
    fx,
    fy,
  }
}

function startRotate(e: MouseEvent) {
  if (isLocked.value || state.spacePanning) return
  e.stopPropagation()
  isDragging.value = true
  // Item #2: a rotate also mutates state.site → guard the overview refit.
  setCanvasDragActive(true)
  dragType.value = 'rotate'
  dragStart.value = { x: e.clientX, y: e.clientY }
  const el = getAtPath(state.selectedPath!)
  dragOriginal.value = { rotation: el?.rotation || 0 }
  // Single undo snapshot for the whole rotate gesture; mousemove uses
  // setAtPathSilent (fixed below) so each frame doesn't push its own entry.
  pushUndoOnce()
}

function onMouseMove(e: MouseEvent) {
  // Click-through (#110): a pending move promotes to a real drag only once the
  // pointer travels past DRAG_THRESHOLD. Until then it's still a candidate
  // click and we do nothing (so a tiny jitter on press never moves anything).
  if (pendingMove.value && !isDragging.value) {
    const dx = e.clientX - dragStart.value.x
    const dy = e.clientY - dragStart.value.y
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    // Crossed the threshold → this is a genuine drag-move. Promote it.
    isDragging.value = true
    if (pendingKind.value === 'group') isGroupDragging.value = true
    pendingMove.value = false
      // Single undo snapshot for the whole gesture.
      pushUndoOnce()
    // Item #2: mark a live canvas drag so the overview refit watcher skips
    // re-fitting (which would reset the "Vista completa" zoom/pan mid-drag).
    setCanvasDragActive(true)
  }

  if (!isDragging.value) return

  // Group move (GAP5): translate every selected element by the same delta,
  // each through its own anchor/unit/clamp. Bypasses the single-element
  // resize/rotate path entirely (group resize/rotate is out of scope).
  if (isGroupDragging.value) {
    applyGroupMove(e)
    scheduleUpdate()
    updateGroupBounds()
    return
  }

  // Group resize: escala todos los seleccionados alrededor de la esquina fija.
  if (isGroupResizing.value) {
    applyGroupResize(e)
    scheduleUpdate()
    updateGroupBounds()
    return
  }

  if (!state.selectedPath) return

  // Screen px → artboard px: divide by the live zoom factor.
  const dx = (e.clientX - dragStart.value.x) / props.zoom
  const dy = (e.clientY - dragStart.value.y) / props.zoom

  const vp = VIEWPORTS[state.deviceMode]
  // The element's true positioning context. Falls back to the device viewport
  // (today's behavior) only if the section isn't measurable yet.
  const box = sectionBox()
  const boxW = box ? box.width : vp.width
  const boxH = box ? box.height : vp.height

  if (dragType.value === 'move') {
    let newX = dragOriginal.value.xPct + (dx / boxW) * 100
    let newY = dragOriginal.value.yPct + (dy / boxH) * 100

    if (state.snapToGrid) {
      // Snap to the SAME % step the visual grid overlay draws (GRID_PERCENT),
      // so the element lands exactly on the lines the user sees.
      newX = Math.round(newX / GRID_PERCENT) * GRID_PERCENT
      newY = Math.round(newY / GRID_PERCENT) * GRID_PERCENT
    }

    // Item #3(a): do NOT clamp a MOVE to the section/artboard bounds. The engine
    // now CLIPS section overflow, so anything dragged outside the margin simply
    // isn't rendered on the real site — there's no need (and it's harmful) to
    // pin the element inside. The old anchor-aware clampPos centred an
    // oversized image over the section and refused to let it leave the margin,
    // which read as the element "locking up". The user can now drag an element
    // partly or fully outside the section freely.
    const cellX: Cell = dragOriginal.value.cellX
    const cellY: Cell = dragOriginal.value.cellY
    const ox = emitCell(cellX, newX, boxW, true)
    const oy = emitCell(cellY, newY, boxH, true)
    setAtPathSilent(`${state.selectedPath}.position`, { x: ox.value, y: oy.value })
    if (ox.converted || oy.converted) {
      flashDragHint('Posición responsiva convertida a % para moverla con precisión')
    }
  }

  if (dragType.value === 'resize') {
    const scaleX = activeHandle.value?.includes('e') ? 1 : activeHandle.value?.includes('w') ? -1 : 0
    const scaleY = activeHandle.value?.includes('s') ? 1 : activeHandle.value?.includes('n') ? -1 : 0

    const o = dragOriginal.value
    let newW = o.wPct + (dx / boxW) * 100 * scaleX
    let newH = o.hPct + (dy / boxH) * 100 * scaleY

    if (e.shiftKey) {
      const ratio = o.wPct / (o.hPct || 1)
      if (Math.abs(dx) > Math.abs(dy)) {
        newH = newW / ratio
      } else {
        newW = newH * ratio
      }
    }

    if (state.snapToGrid && !e.shiftKey) {
      // Snap size to the same % grid step (skip while constraining ratio).
      newW = Math.round(newW / GRID_PERCENT) * GRID_PERCENT
      newH = Math.round(newH / GRID_PERCENT) * GRID_PERCENT
    }

    newW = Math.max(1, newW)
    newH = Math.max(1, newH)

    // ── Anchor-aware resize (Illustrator-style) ─────────────────────────────
    // The element occupies [posX - fx·W, posX + (1-fx)·W] on X (fx = anchor
    // fraction: left 0, center .5, right 1; fy analogous on Y).
    //
    //  • Anchor CENTERED on the axis (fx = .5 / fy = .5 — i.e. `center`, and
    //    `top`/`bottom` on X, `left`/`right` on Y): resize is SYMMETRIC about
    //    the anchor — position is NOT compensated, both edges move equally
    //    outward. This is the expected center-anchor behavior the task asks
    //    for (and the historical behavior, preserved).
    //  • Anchor NOT centered on the axis: keep the OPPOSITE edge/corner from
    //    the dragged handle FIXED by compensating position —
    //      east handle  → pin LEFT  edge → posX += fx·ΔW
    //      west handle  → pin RIGHT edge → posX -= (1-fx)·ΔW
    //      south handle → pin TOP   edge → posY += fy·ΔH
    //      north handle → pin BOTTOM edge→ posY -= (1-fy)·ΔH
    //    With fx=0 (`*-left`/`left`) east-drag → posX += 0 → left edge stays
    //    put exactly; with fx=1 (`*-right`/`right`) → opposite edge pinned.
    const dW = newW - o.wPct
    const dH = newH - o.hPct
    const xCentered = Math.abs(o.fx - 0.5) < 1e-6
    const yCentered = Math.abs(o.fy - 0.5) < 1e-6
    let newX = o.xPct
    let newY = o.yPct
    if (!xCentered) {
      if (scaleX === 1) newX = o.xPct + o.fx * dW
      else if (scaleX === -1) newX = o.xPct - (1 - o.fx) * dW
    }
    if (!yCentered) {
      if (scaleY === 1) newY = o.yPct + o.fy * dH
      else if (scaleY === -1) newY = o.yPct - (1 - o.fy) * dH
    }

    // Keep the resized box inside the artboard (issue #53). The size the user
    // dragged to is preserved; only the anchor position is nudged so neither
    // edge crosses 0%/100% of the section (anchor-aware via clampPos). This
    // never fights a legitimate edge-aligned resize — a box that exactly fits
    // 0..100 is already in range and untouched.
    newX = clampPos(newX, o.fx, newW)
    newY = clampPos(newY, o.fy, newH)

    let convertedAny = false
    const sizePatch: any = {}
    if (scaleX !== 0) {
      const ow = emitCell(o.cellW, newW, boxW, true)
      sizePatch.width = ow.value
      convertedAny = convertedAny || ow.converted
      // Compensate position only when the anchor isn't centered on X (centered
      // → o.fx=.5 makes both branches no-net-move = symmetric). Only write
      // position.x when it actually changed, preserving its unit.
      if (newX !== o.xPct) {
        const ox = emitCell(o.cellX, newX, boxW, true)
        const curPos = getAtPath(`${state.selectedPath}.position`) || {}
        setAtPathSilent(`${state.selectedPath}.position`, { ...curPos, x: ox.value })
        convertedAny = convertedAny || ox.converted
      }
    }
    if (scaleY !== 0) {
      const oh = emitCell(o.cellH, newH, boxH, true)
      sizePatch.height = oh.value
      convertedAny = convertedAny || oh.converted
      if (newY !== o.yPct) {
        const oy = emitCell(o.cellY, newY, boxH, true)
        const curPos = getAtPath(`${state.selectedPath}.position`) || {}
        setAtPathSilent(`${state.selectedPath}.position`, { ...curPos, y: oy.value })
        convertedAny = convertedAny || oy.converted
      }
    }

    const current = getAtPath(`${state.selectedPath}.size`) || {}
    setAtPathSilent(`${state.selectedPath}.size`, { ...current, ...sizePatch })
    if (convertedAny) {
      flashDragHint('Tamaño responsivo convertido a % para redimensionar con precisión')
    }
  }

  if (dragType.value === 'rotate') {
    if (!bounds.value || !props.canvasRef) return
    const canvasRect = props.canvasRef.getBoundingClientRect()
    // Box center in screen coords (bounds are canvas-local).
    const cx = canvasRect.left + bounds.value.left + bounds.value.width / 2
    const cy = canvasRect.top + bounds.value.top + bounds.value.height / 2
    const startAngle = Math.atan2(dragStart.value.y - cy, dragStart.value.x - cx)
    const currentAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
    const delta = ((currentAngle - startAngle) * 180) / Math.PI
    setAtPathSilent(`${state.selectedPath}.rotation`, Math.round(dragOriginal.value.rotation + delta))
  }

  scheduleUpdate()
}

function onMouseUp(e?: MouseEvent) {
  // Click-through (#110): a pending move that never crossed the drag threshold
  // is a plain CLICK on the move-area. Run the canvas hit-test at the release
  // point and select the TOP-MOST element there (the front element under the
  // cursor) — matching Illustrator, even though a larger/back element is
  // currently selected and its move-area covered the click. We mark the drag
  // guard so the synthetic `click` that follows this mouseup does NOT re-run
  // handleCanvasClick (which would re-process the same point).
  if (pendingMove.value && !isDragging.value && e) {
    markDragEnded()
    const wasGroup = pendingKind.value === 'group'
    pendingMove.value = false
    // No pushUndoOnce here: this branch fires for a plain click that never
    // crossed DRAG_THRESHOLD → nothing changed → stamping a snapshot of the
    // unchanged state just pollutes the undo stack and forces Cmd+Z to be
    // pressed extra times to skip past the no-op entries.
    pendingKind.value = null
    clickThroughSelect(e, wasGroup)
    dragType.value = null
    return
  }

  // Only guard the canvas click if a drag was actually in progress, so a plain
  // click elsewhere isn't accidentally swallowed.
  if (isDragging.value) markDragEnded()
  isDragging.value = false
  isGroupDragging.value = false
  isGroupResizing.value = false
  groupResizeItems.value = []
  groupResizeOrig.value = null
  pendingMove.value = false
  // No pushUndoOnce here: a real drag already stamped its single snapshot at
  // drag START (move) or at the handle/rotate press (resize/rotate, fixed
  // below). Stamping AGAIN at mouseup captures the POST-drag state, which
  // turns the first Cmd+Z into a no-op (the snapshot equals the current
  // state) — user had to press Cmd+Z twice per gesture.
  pendingKind.value = null
  groupDragItems.value = []
  dragType.value = null
  activeHandle.value = null
  // Item #2: drag finished → allow the overview refit to run again (e.g. a
  // later device/view switch or section edit re-fits as before).
  setCanvasDragActive(false)
}

// Topmost-element selection at a screen point (#110). Mirrors
// handleCanvasClick's hit-test: the LAST [data-parallax-id] in document order
// containing the point is the front one. Plain click → single select; shift →
// toggle in/out of the multi-selection (so shift-click-through extends a
// group). A click that lands on no element leaves the current selection
// untouched (the user pressed inside the box; don't surprise-deselect).
function clickThroughSelect(e: MouseEvent, _wasGroup: boolean) {
  if (!state.site) return
  // TASK #112: a click-through release over the PASTEBOARD (outside the
  // artboard `.preview-frame`) must not select an off-board element. Mirror
  // handleCanvasClick's artboard gate: outside the mesa, leave the selection
  // untouched (the user pressed inside the box but released off-board; don't
  // surprise-select something invisible).
  if (!pointInArtboard(e.clientX, e.clientY)) return
  const el = elementAtPoint(e.clientX, e.clientY)
  if (!el) return
  const id = el.getAttribute('data-parallax-id')
  if (!id) return
  const path = findElementPath(state.site, id)
  if (!path) return
  // Modificador de multi-selección — SOLO Cmd/Ctrl en canvas. Shift está
  // reservado para "mantener proporción" durante resize/rotación (líneas
  // 603, 666, 801, 992, 1001 en este mismo archivo). Antes toggle también
  // aceptaba Shift → confusión: shift+click en un elemento ya seleccionado
  // lo deseleccionaba en vez de comportarse como su rol de proporción.
  if (e.metaKey || e.ctrlKey) toggleCanvasSelection(path)
  else setCanvasSelection(path)
}

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const boxStyle = computed(() => {
  if (!bounds.value) return { display: 'none' }
  return {
    position: 'absolute' as const,
    left: `${bounds.value.left}px`,
    top: `${bounds.value.top}px`,
    width: `${bounds.value.width}px`,
    height: `${bounds.value.height}px`,
    pointerEvents: 'none' as const,
  }
})
</script>

<template>
  <!-- ── Single-element selection (UNCHANGED) ─────────────────────────────
       Rendered only when NOT in group mode, so all existing single-element
       resize/rotate/move behavior is byte-for-byte the same as before. -->
  <div
    v-if="bounds && !hasMultiSelection"
    :style="boxStyle"
    class="selection-box"
    :class="{ locked: isLocked }"
  >
    <!-- Border -->
    <div class="selection-border" />

    <!-- Locked badge: makes it obvious why nothing drags. -->
    <div v-if="isLocked" class="lock-badge" data-test="overlay-locked">🔒 Bloqueado</div>

    <!-- Transient hint when a responsive expression was converted to % so the
         drag stays exact (WYSIWYG, never corrupts the value). -->
    <div v-if="dragHint" class="drag-hint" data-test="overlay-drag-hint">{{ dragHint }}</div>

    <!-- Move area: disabled (no pointer events) while locked so a drag never
         starts and the canvas hit-test stays clean. -->
    <div v-if="!isLocked" class="move-area" @mousedown="startMove" @dblclick="startInlineTextEdit" />

    <!-- Resize + rotate handles only when unlocked. -->
    <template v-if="!isLocked">
      <div
        v-for="h in handles"
        :key="h"
        :class="['handle', `handle-${h}`]"
        :data-test="`resize-handle-${h}`"
        @mousedown="(e) => startResize(e, h)"
      />
      <div class="rotate-handle" data-test="rotate-handle" @mousedown="startRotate">
        <div class="rotate-icon">&#x21BB;</div>
      </div>
    </template>
  </div>

  <!-- ── Group selection (GAP5): 2+ elements ──────────────────────────────
       Caja combinada con MOVER (arrastrar el área) y ESCALAR (handles en los
       bordes/esquinas → escala todos los seleccionados juntos). -->
  <div
    v-if="hasMultiSelection && groupBounds"
    class="group-box"
    data-test="group-selection"
    :class="{ locked: groupHasLock }"
    :style="{
      position: 'absolute',
      left: `${groupBounds.left}px`,
      top: `${groupBounds.top}px`,
      width: `${groupBounds.width}px`,
      height: `${groupBounds.height}px`,
    }"
  >
    <div class="group-border" />
    <div class="group-count" data-test="group-count">
      {{ multiSelectedElementPaths.length }} seleccionados
    </div>
    <div v-if="groupHasLock" class="lock-badge" data-test="group-locked">🔒 Bloqueado</div>
    <div
      v-if="!groupHasLock"
      class="move-area"
      data-test="group-move-area"
      @mousedown="startGroupMove"
    />
    <!-- Handles de escala del GRUPO (escalan todos los seleccionados juntos). -->
    <template v-if="!groupHasLock">
      <div
        v-for="h in handles"
        :key="'g-' + h"
        :class="['handle', `handle-${h}`]"
        :data-test="`group-resize-handle-${h}`"
        @mousedown="(e) => startGroupResize(e, h)"
      />
    </template>
  </div>
</template>

<style scoped>
.selection-box { z-index: 10000; }
.selection-border { position: absolute; inset: 0; border: 2px solid #0099ff; pointer-events: none; }
.selection-box.locked .selection-border { border-color: #e0a52a; border-style: dashed; }
/* ── Group selection box (GAP5) ──────────────────────────────────────────
   Same stacking level as the single box. A dashed accent frame distinguishes
   it from a single selection; the move-area inside it carries pointer-events
   so a drag starts. */
.group-box { z-index: 10000; }
.group-border {
  position: absolute; inset: 0;
  border: 2px dashed #0099ff; pointer-events: none;
}
.group-box.locked .group-border { border-color: #e0a52a; }
.group-count {
  position: absolute; top: -22px; left: 0;
  background: #0099ff; color: #fff;
  font-size: 11px; font-weight: 600;
  padding: 1px 6px; border-radius: 3px;
  white-space: nowrap; pointer-events: none;
}
.lock-badge {
  position: absolute; top: -22px; left: 0;
  background: #e0a52a; color: #1a1a1a;
  font-size: 11px; font-weight: 600;
  padding: 1px 6px; border-radius: 3px;
  white-space: nowrap; pointer-events: none;
}
.drag-hint {
  position: absolute; bottom: -24px; left: 0;
  background: #0099ff; color: #fff;
  font-size: 11px; font-weight: 600;
  padding: 1px 6px; border-radius: 3px;
  white-space: nowrap; pointer-events: none;
}
.move-area { position: absolute; inset: 0; cursor: move; pointer-events: auto; }
.handle { position: absolute; width: 8px; height: 8px; background: #fff; border: 1px solid #0099ff; pointer-events: auto; z-index: 1; }
.handle-nw { top: -4px; left: -4px; cursor: nw-resize; }
.handle-n { top: -4px; left: 50%; transform: translateX(-50%); cursor: n-resize; }
.handle-ne { top: -4px; right: -4px; cursor: ne-resize; }
.handle-e { top: 50%; right: -4px; transform: translateY(-50%); cursor: e-resize; }
.handle-se { bottom: -4px; right: -4px; cursor: se-resize; }
.handle-s { bottom: -4px; left: 50%; transform: translateX(-50%); cursor: s-resize; }
.handle-sw { bottom: -4px; left: -4px; cursor: sw-resize; }
.handle-w { top: 50%; left: -4px; transform: translateY(-50%); cursor: w-resize; }
.rotate-handle { position: absolute; top: -28px; left: 50%; transform: translateX(-50%); pointer-events: auto; cursor: grab; }
.rotate-icon { width: 18px; height: 18px; background: #fff; border: 1px solid #0099ff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #0099ff; }
</style>
