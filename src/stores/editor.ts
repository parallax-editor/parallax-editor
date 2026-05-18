import { reactive, computed } from 'vue'
import type { Site, Section, Layer, AnyElement } from 'parallax-engine/schema'
import { toViews, resolveSections } from 'parallax-engine'

export type Tool = 'select' | 'hand' | 'zoom'
export type DeviceMode = 'desktop' | 'mobile'

// Clipboard kinds mirror the three tree node levels.
export type ClipboardKind = 'section' | 'layer' | 'element'
export interface Clipboard {
  kind: ClipboardKind
  // Deep snapshot taken at copy/cut time (ids regenerated on every paste).
  data: any
  // 'cut' removes the source on the first paste; 'copy' keeps it.
  op: 'copy' | 'cut'
  // Path the cut node lived at (so the first paste can delete it). View-aware
  // bookkeeping is unnecessary because cut deletes by re-locating the node id.
  sourceId?: string
}
// 'edit'   → elements manipulable, parallax/animations paused (design view)
// 'preview'→ engine runs animations/parallax so the effect is visible
export type PreviewMode = 'edit' | 'preview'

export interface EditorState {
  projectType: 'eventos' | 'site' | null
  slug: string | null
  site: Site | null
  originalSite: string | null
  selectedPath: string | null
  tool: Tool
  deviceMode: DeviceMode
  previewMode: PreviewMode
  canvasZoom: number
  canvasPan: { x: number; y: number }
  undoStack: string[]
  redoStack: string[]
  isClaudeLoading: boolean
  snapToGrid: boolean
  gridSize: number
  errors: string[]
  // Tree clipboard (copy/cut/paste in CAPAS, within and across views).
  clipboard: Clipboard | null
  // Transient hint shown when a paste can't find a sensible target.
  pasteHint: string | null
  // Editor-local lock: set of node ids (section/layer/element) the user has
  // locked. Locked nodes can't be canvas-dragged/resized or tree-reordered.
  // Persisted into the saved JSON ONLY via the OPTIONAL additive
  // `site.editorLocks` field (see syncLocksToSite) — the engine schema is
  // untouched and the sites ignore the extra key.
  lockedIds: string[]
  // ── "Vista completa" (overview) ──────────────────────────────────────────
  // OFF (default) = today's behavior unchanged: device-proportion artboard
  // (1440×900 / 375×667) with vertical scroll through the sections.
  // ON = the whole composition (all stacked sections, full total height) is
  // shown scaled-to-fit at once, no per-screen scrolling. Purely an editor
  // view state — never saved into site.json.
  overviewMode: boolean
  // Rendered total content height (px) of the active view's stacked sections,
  // measured from the live preview at the moment overview is enabled. 0 until
  // measured. Used to size the artboard + compute the fit zoom.
  overviewContentHeight: number
  // Snapshot of zoom/pan/inner-scroll taken when overview is enabled, so
  // turning it OFF restores the previous mode EXACTLY.
  preOverview: {
    zoom: number
    pan: { x: number; y: number }
    scrollTop: number
    scrollLeft: number
  } | null
}

export const state = reactive<EditorState>({
  projectType: null,
  slug: null,
  site: null,
  originalSite: null,
  selectedPath: null,
  tool: 'select',
  deviceMode: 'desktop',
  previewMode: 'edit',
  canvasZoom: 0.5,
  canvasPan: { x: 0, y: 0 },
  undoStack: [],
  redoStack: [],
  isClaudeLoading: false,
  snapToGrid: false,
  gridSize: 10,
  errors: [],
  clipboard: null,
  pasteHint: null,
  lockedIds: [],
  overviewMode: false,
  overviewContentHeight: 0,
  preOverview: null,
})

// ─── View model: compartido (legacy) vs independiente (v1.1 views) ─────────────
//
// A legacy/compartido site keeps ONE shared `site.sections` tree (current
// behavior, per-element mobile/desktop overrides intact). It is NEVER
// auto-migrated. Daniela opts in via the "Configuración independiente
// móvil/escritorio" toggle, which calls toViews(site) ONCE to materialize two
// genuinely independent trees (site.views.desktop / .mobile), bumps
// schemaVersion to '1.1' and marks dirty (undoable).
//
// Once independent, the device toggle selects the ACTIVE viewport and EVERY
// editing surface (CAPAS, canvas, properties, add/delete, drag, animations,
// copy/paste) operates on the active view's tree. We keep selectedPath
// RELATIVE to the active sections root ("sections.0.layers.1...") so all the
// existing path machinery (getAtPath/setAtPath/getSelected/SelectionOverlay/
// PropertiesPanel/usePreviewHitTargets) keeps working untouched — only the
// root these paths resolve against changes with the active view.

export const isIndependent = computed(
  () => !!state.site && !!(state.site as any).views,
)

// The Section[] array the active view edits. Legacy → site.sections.
// Independent → site.views[deviceMode].sections (mobile may not exist yet:
// fall back to desktop so we never crash, though enableIndependentViews
// always creates both).
export function activeSections(): Section[] {
  const site = state.site as any
  if (!site) return []
  if (site.views) {
    if (state.deviceMode === 'mobile') {
      return site.views.mobile?.sections ?? site.views.desktop?.sections ?? []
    }
    return site.views.desktop?.sections ?? []
  }
  return site.sections ?? []
}

// Dot-path PREFIX from the site root down to the active sections array.
// Legacy: "sections". Independent desktop: "views.desktop.sections", mobile:
// "views.mobile.sections". getAtPath/setAtPath rewrite a leading "sections"
// token to this so callers can keep using view-relative paths verbatim.
export function activeSectionsRoot(): string {
  const site = state.site as any
  if (site?.views) {
    const vp = state.deviceMode === 'mobile' ? 'mobile' : 'desktop'
    return `views.${vp}.sections`
  }
  return 'sections'
}

// Resolve a view-relative path ("sections.0...") to a canonical site path
// ("views.mobile.sections.0..." when independent). Non-"sections" paths
// (e.g. "meta.title") pass through untouched.
function toCanonicalPath(path: string): string {
  if (path === 'sections' || path.startsWith('sections.')) {
    const root = activeSectionsRoot()
    if (root === 'sections') return path
    return path === 'sections' ? root : root + path.slice('sections'.length)
  }
  return path
}

/**
 * Opt-in migration. Materializes site.views.{desktop,mobile} via the engine's
 * pure toViews(), bumps schemaVersion to 1.1, marks dirty + undoable. No-op if
 * already independent.
 */
export function enableIndependentViews() {
  if (!state.site || isIndependent.value) return
  pushUndo()
  const migrated = toViews(state.site) as any
  migrated.schemaVersion = '1.1'
  state.site = migrated
  // selectedPath stays valid: desktop view is the legacy sections verbatim
  // and we land the user on desktop.
  state.deviceMode = 'desktop'
}

// Grid step, expressed as a PERCENT of the artboard (position.x/y and
// size.width/height are %-of-artboard in the schema). The visual grid overlay
// in EditorCanvas and the snap math in SelectionOverlay BOTH use this single
// constant so what Daniela sees lines up exactly with where elements land.
// 5% → a 20×N grid on the artboard: fine enough to be useful, coarse enough
// to read. Kept in sync with state.gridSize (legacy field still consumed by
// SelectionOverlay's snap rounding).
export const GRID_PERCENT = 5

export const isDirty = computed(() => {
  if (!state.site || !state.originalSite) return false
  return JSON.stringify(state.site) !== state.originalSite
})

export function loadSite(site: Site, projectType: 'eventos' | 'site', slug: string) {
  state.site = site
  state.originalSite = JSON.stringify(site)
  state.projectType = projectType
  state.slug = slug
  state.selectedPath = null
  state.undoStack = []
  state.redoStack = []
  state.errors = []
  state.clipboard = null
  state.pasteHint = null
  state.overviewMode = false
  state.overviewContentHeight = 0
  state.preOverview = null
  // Hydrate editor-local locks from the OPTIONAL additive field if the saved
  // JSON carries one (kept out of the engine schema; sites ignore it).
  const persisted = (site as any).editorLocks
  state.lockedIds = Array.isArray(persisted) ? persisted.filter((x: any) => typeof x === 'string') : []
}

export function closeSite() {
  state.site = null
  state.originalSite = null
  state.slug = null
  state.selectedPath = null
  state.undoStack = []
  state.redoStack = []
  state.clipboard = null
  state.pasteHint = null
  state.lockedIds = []
  state.overviewMode = false
  state.overviewContentHeight = 0
  state.preOverview = null
}

function pushUndo() {
  if (!state.site) return
  state.undoStack.push(JSON.stringify(state.site))
  if (state.undoStack.length > 50) state.undoStack.shift()
  state.redoStack = []
}

export function undo() {
  if (state.undoStack.length === 0 || !state.site) return
  state.redoStack.push(JSON.stringify(state.site))
  const prev = state.undoStack.pop()!
  state.site = JSON.parse(prev)
}

export function redo() {
  if (state.redoStack.length === 0 || !state.site) return
  state.undoStack.push(JSON.stringify(state.site))
  const next = state.redoStack.pop()!
  state.site = JSON.parse(next)
}

// Get a value at a VIEW-RELATIVE dot-path like
// "sections.0.layers.1.elements.2". The leading "sections" token is rewritten
// to the active view's root ("views.mobile.sections...") in independent mode,
// so every caller stays view-agnostic.
export function getAtPath(path: string): any {
  if (!state.site) return undefined
  const parts = toCanonicalPath(path).split('.')
  let obj: any = state.site
  for (const p of parts) {
    if (obj == null) return undefined
    obj = typeof obj === 'object' && p in obj ? obj[p] : obj[Number(p)]
  }
  return obj
}

// Set a value at a view-relative dot-path, with undo
export function setAtPath(path: string, value: any) {
  if (!state.site) return
  pushUndo()
  const parts = toCanonicalPath(path).split('.')
  let obj: any = state.site
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    obj = typeof obj === 'object' && p in obj ? obj[p] : obj[Number(p)]
    if (obj == null) return
  }
  const last = parts[parts.length - 1]
  if (Array.isArray(obj)) {
    obj[Number(last)] = value
  } else {
    obj[last] = value
  }
}

// Get the selected element/layer/section
export function getSelected(): { type: 'section' | 'layer' | 'element'; data: any; path: string } | null {
  if (!state.selectedPath || !state.site) return null
  const parts = state.selectedPath.split('.')
  const data = getAtPath(state.selectedPath)
  if (!data) return null

  if (parts.length === 2) return { type: 'section', data, path: state.selectedPath }
  if (parts.length === 4) return { type: 'layer', data, path: state.selectedPath }
  if (parts.length === 6) return { type: 'element', data, path: state.selectedPath }
  return null
}

// Move an item in an array (for drag reorder within one parent).
export function moveInArray(arrayPath: string, fromIndex: number, toIndex: number) {
  pushUndo()
  const arr = getAtPath(arrayPath)
  if (!Array.isArray(arr)) return
  const item = arr.splice(fromIndex, 1)[0]
  arr.splice(toIndex, 0, item)
}

// ─── Drag-reorder ACROSS parents (sections / layers / elements) ────────────────
//
// `sourcePath` and `targetArrayPath` are VIEW-RELATIVE ("sections.0.layers.1
// .elements.2" / "sections.0.layers.1.elements"). The node is *moved* (not
// copied): the SAME object — ids and all — is spliced out of its source array
// and into the target array at `toIndex`. Works within one parent (reorder) and
// across parents (element→other layer/section, layer→other section, section
// reorder). All view-aware via getAtPath's canonical rebasing, so it operates
// on whichever view (compartido / independiente desktop|mobile) is active.
//
// Returns the node's new VIEW-RELATIVE path (so the caller can follow the
// selection), or null if the move was rejected (kind mismatch / locked / bad
// path).
function levelOfArrayPath(arrayPath: string): 'section' | 'layer' | 'element' | null {
  // "sections" → sections array (holds sections)
  // "sections.0.layers" → layers array (holds layers)
  // "sections.0.layers.1.elements" → elements array (holds elements)
  const n = arrayPath.split('.').length
  if (arrayPath === 'sections' || n === 1) return 'section'
  if (n === 3) return 'layer'
  if (n === 5) return 'element'
  return null
}

export function moveNode(
  sourcePath: string,
  targetArrayPath: string,
  toIndex: number,
): string | null {
  if (!state.site) return null
  const srcParts = sourcePath.split('.')
  const sourceParentPath = srcParts.slice(0, -1).join('.')
  const sourceIndex = Number(srcParts[srcParts.length - 1])

  // Levels must match (a section can only land among sections, etc.).
  const srcLevel = levelOfArrayPath(sourceParentPath)
  const dstLevel = levelOfArrayPath(targetArrayPath)
  if (!srcLevel || srcLevel !== dstLevel) return null

  const srcArr = getAtPath(sourceParentPath)
  const dstArr = getAtPath(targetArrayPath)
  if (!Array.isArray(srcArr) || !Array.isArray(dstArr)) return null
  if (sourceIndex < 0 || sourceIndex >= srcArr.length) return null

  const node = srcArr[sourceIndex]
  // Locked nodes can't be drag-reordered.
  if (node && node.id && state.lockedIds.includes(node.id)) {
    flashPasteHint('Nodo bloqueado — desbloquéalo para moverlo')
    return null
  }

  const sameArray = srcArr === dstArr
  // No-op: dropping onto its own slot in the same array.
  if (sameArray && (toIndex === sourceIndex || toIndex === sourceIndex + 1)) {
    return sourcePath
  }

  pushUndo()
  srcArr.splice(sourceIndex, 1)
  // When moving within the same array and removing an earlier item, the
  // destination index shifts left by one.
  let insertAt = toIndex
  if (sameArray && sourceIndex < toIndex) insertAt = toIndex - 1
  insertAt = Math.max(0, Math.min(insertAt, dstArr.length))
  dstArr.splice(insertAt, 0, node)

  // Re-derive the moved node's path so the selection follows it even across
  // parents. Prefer locating by id (robust if indices shifted); fall back to
  // the literal target slot when the node has no id.
  const byId = node?.id ? pathOfNodeInActiveView(node.id, srcLevel) : null
  const movedPath = byId || `${targetArrayPath}.${insertAt}`
  state.selectedPath = movedPath
  return movedPath
}

// ─── Per-node visibility ───────────────────────────────────────────────────────
//
// Elements have a schema `visible` field (engine honors it → preview updates).
// Sections/layers have NO schema field; we still write a `visible:false` key on
// them (additive, ignored by the engine/sites) and the editor's previewSite
// computed strips hidden layers/sections from the throwaway render copy so the
// canvas preview reflects it. Absence of `visible` = visible.
export function isNodeVisible(node: any): boolean {
  return !node || node.visible !== false
}

export function toggleVisibility(path: string) {
  const node = getAtPath(path)
  if (!node) return
  pushUndo()
  // Treat missing as visible → first toggle hides.
  node.visible = node.visible === false ? true : false
}

// ─── Per-node lock ─────────────────────────────────────────────────────────────
//
// Editor-local: a Set-like list of node ids. Locked nodes can't be canvas-
// dragged/resized or tree-reordered. Persisted only via the OPTIONAL additive
// `site.editorLocks` array (synced on save by syncLocksToSite); the engine
// schema and the sites are untouched.
export function isNodeLockedById(id: string | undefined | null): boolean {
  return !!id && state.lockedIds.includes(id)
}

export function isPathLocked(path: string | null | undefined): boolean {
  if (!path) return false
  const node = getAtPath(path)
  return !!node && isNodeLockedById(node.id)
}

export function toggleLock(path: string) {
  const node = getAtPath(path)
  if (!node || !node.id) return
  const i = state.lockedIds.indexOf(node.id)
  if (i >= 0) state.lockedIds.splice(i, 1)
  else state.lockedIds.push(node.id)
  syncLocksToSite()
}

// Mirror the lock set into the site's OPTIONAL additive `editorLocks` field so
// it survives a save/reload. Absent when nothing is locked (keeps diffs clean
// and legacy files untouched until the user actually locks something).
export function syncLocksToSite() {
  if (!state.site) return
  const s = state.site as any
  if (state.lockedIds.length === 0) {
    if ('editorLocks' in s) delete s.editorLocks
  } else {
    s.editorLocks = [...state.lockedIds]
  }
}

// Delete the selected element
export function deleteSelected() {
  if (!state.selectedPath || !state.site) return
  pushUndo()
  const parts = state.selectedPath.split('.')
  const parentPath = parts.slice(0, -1).join('.')
  const index = Number(parts[parts.length - 1])
  const arr = getAtPath(parentPath)
  if (Array.isArray(arr)) {
    arr.splice(index, 1)
    state.selectedPath = null
  }
}

// Duplicate the selected element
export function duplicateSelected() {
  if (!state.selectedPath || !state.site) return
  pushUndo()
  const parts = state.selectedPath.split('.')
  const parentPath = parts.slice(0, -1).join('.')
  const index = Number(parts[parts.length - 1])
  const arr = getAtPath(parentPath)
  if (Array.isArray(arr)) {
    const copy = JSON.parse(JSON.stringify(arr[index]))
    if (copy.id) copy.id = `${copy.id}-copy`
    if (copy.position) {
      copy.position.x = (copy.position.x || 0) + 2
      copy.position.y = (copy.position.y || 0) + 2
    }
    arr.splice(index + 1, 0, copy)
    state.selectedPath = `${parentPath}.${index + 1}`
  }
}

// ─── Animations on the selected element ────────────────────────────────────────

export function addAnimation() {
  if (!state.selectedPath) return
  const el = getAtPath(state.selectedPath)
  if (!el) return
  pushUndo()
  if (!Array.isArray(el.animations)) el.animations = []
  el.animations.push({
    type: 'fadeIn',
    trigger: 'enter',
    from: 0,
    to: 1,
    duration: 800,
    delay: 0,
    easing: 'easeOut',
  })
}

export function removeAnimation(index: number) {
  if (!state.selectedPath) return
  const el = getAtPath(state.selectedPath)
  if (!el || !Array.isArray(el.animations)) return
  pushUndo()
  el.animations.splice(index, 1)
}

// ─── Clipboard: copy / cut / paste in the CAPAS tree ───────────────────────────
//
// Works for a whole Section, a Layer, or an individual Element — within the
// active view, between layers/sections, AND across views (copy in desktop,
// switch to mobile, paste). Paste ALWAYS deep-regenerates ids (collision-free),
// pushes undo, marks dirty, selects the pasted node.

function kindForPath(path: string): ClipboardKind | null {
  const n = path.split('.').length
  if (n === 2) return 'section' // sections.0
  if (n === 4) return 'layer' // sections.0.layers.1
  if (n === 6) return 'element' // sections.0.layers.1.elements.2
  return null
}

// Deep-clone a node and regenerate EVERY id (section/layer/element) so a paste
// can never collide with an existing node — even across views.
function regenerateIds(node: any, kind: ClipboardKind): any {
  const copy = JSON.parse(JSON.stringify(node))
  if (kind === 'section') {
    copy.id = uid('section')
    for (const layer of copy.layers || []) {
      layer.id = uid('layer')
      for (const el of layer.elements || []) el.id = uid(el.type || 'el')
    }
  } else if (kind === 'layer') {
    copy.id = uid('layer')
    for (const el of copy.elements || []) el.id = uid(el.type || 'el')
  } else {
    copy.id = uid(copy.type || 'el')
  }
  return copy
}

function flashPasteHint(msg: string) {
  state.pasteHint = msg
  setTimeout(() => {
    if (state.pasteHint === msg) state.pasteHint = null
  }, 2600)
}

// Snapshot the current selection into the clipboard.
function clip(op: 'copy' | 'cut') {
  if (!state.selectedPath) return
  const kind = kindForPath(state.selectedPath)
  if (!kind) return
  const data = getAtPath(state.selectedPath)
  if (!data) return
  state.clipboard = {
    kind,
    op,
    data: JSON.parse(JSON.stringify(data)),
    sourceId: data.id,
  }
  if (op === 'cut') flashPasteHint('Cortado — pega donde quieras (Cmd+V)')
  else flashPasteHint('Copiado — pega donde quieras (Cmd+V)')
}

export function copySelected() {
  clip('copy')
}

export function cutSelected() {
  clip('cut')
}

// Locate a node by id anywhere in the CURRENT site (any view) and return its
// canonical parent array + index, so a "cut" can delete the original even if
// the user switched views before pasting.
function findNodeLocationById(
  id: string,
  kind: ClipboardKind,
): { arr: any[]; index: number } | null {
  if (!state.site) return null
  const roots: Section[][] = []
  const site = state.site as any
  if (site.views) {
    if (site.views.desktop) roots.push(site.views.desktop.sections)
    if (site.views.mobile) roots.push(site.views.mobile.sections)
  } else {
    roots.push(site.sections ?? [])
  }
  for (const sections of roots) {
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si] as any
      if (kind === 'section' && section.id === id) return { arr: sections, index: si }
      for (let li = 0; li < (section.layers || []).length; li++) {
        const layer = section.layers[li]
        if (kind === 'layer' && layer.id === id) return { arr: section.layers, index: li }
        for (let ei = 0; ei < (layer.elements || []).length; ei++) {
          if (kind === 'element' && layer.elements[ei].id === id) {
            return { arr: layer.elements, index: ei }
          }
        }
      }
    }
  }
  return null
}

// View-relative path ("sections.i[.layers.l[.elements.e]]") of a node located
// by id within the ACTIVE view's tree, or null if not present in this view.
function pathOfNodeInActiveView(id: string, kind: ClipboardKind): string | null {
  const sections = activeSections()
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si] as any
    if (kind === 'section' && section.id === id) return `sections.${si}`
    for (let li = 0; li < (section.layers || []).length; li++) {
      const layer = section.layers[li]
      if (kind === 'layer' && layer.id === id) return `sections.${si}.layers.${li}`
      for (let ei = 0; ei < (layer.elements || []).length; ei++) {
        if (kind === 'element' && layer.elements[ei].id === id) {
          return `sections.${si}.layers.${li}.elements.${ei}`
        }
      }
    }
  }
  return null
}

/**
 * Paste the clipboard relative to the current selection (active view).
 *
 * Targets:
 *  - Section  → appended after the selected section (or at the end of the
 *               active view's sections).
 *  - Layer    → into the selected section (or the selected layer's section),
 *               after the selected layer when one is selected.
 *  - Element  → into the selected layer (or the selected element's layer),
 *               after the selected element when one is selected.
 * If no sensible target exists for the clipboard kind, no-op + subtle hint.
 */
export function pasteClipboard() {
  if (!state.site || !state.clipboard) {
    if (!state.clipboard) flashPasteHint('Nada en el portapapeles')
    return
  }
  const cb = state.clipboard
  const sel = state.selectedPath
  const selParts = sel ? sel.split('.') : []
  const selKind = sel ? kindForPath(sel) : null

  // ── Resolve the destination array + insert index FIRST (no mutation yet) ──
  // so a no-op (wrong target / nothing sensible) leaves undo/redo untouched
  // and only shows a subtle hint.
  let targetArr: any[] | null = null
  let insertAt = 0
  let pathFor: (idx: number) => string = () => ''

  if (cb.kind === 'section') {
    const sections = activeSections()
    insertAt = selKind ? Number(selParts[1]) + 1 : sections.length
    targetArr = sections
    pathFor = (idx) => `sections.${idx}`
  } else if (cb.kind === 'layer') {
    let si: number | null = null
    let at: number | null = null
    if (selKind === 'section') si = Number(selParts[1])
    else if (selKind === 'layer') { si = Number(selParts[1]); at = Number(selParts[3]) + 1 }
    else if (selKind === 'element') { si = Number(selParts[1]); at = Number(selParts[3]) + 1 }
    else {
      if (activeSections().length === 0) { flashPasteHint('Crea una sección primero'); return }
      si = 0
    }
    const section = getAtPath(`sections.${si}`) as any
    if (!section || !Array.isArray(section.layers)) { flashPasteHint('No hay sección destino'); return }
    targetArr = section.layers
    insertAt = at == null ? section.layers.length : at
    pathFor = (idx) => `sections.${si}.layers.${idx}`
  } else {
    let si: number | null = null
    let li: number | null = null
    let at: number | null = null
    if (selKind === 'layer') { si = Number(selParts[1]); li = Number(selParts[3]) }
    else if (selKind === 'element') { si = Number(selParts[1]); li = Number(selParts[3]); at = Number(selParts[5]) + 1 }
    else if (selKind === 'section') {
      si = Number(selParts[1])
      const section = getAtPath(`sections.${si}`) as any
      if (!section || !Array.isArray(section.layers) || section.layers.length === 0) {
        flashPasteHint('Selecciona una capa para pegar el elemento'); return
      }
      li = 0
    } else {
      flashPasteHint('Selecciona una capa para pegar el elemento'); return
    }
    const layer = getAtPath(`sections.${si}.layers.${li}`) as any
    if (!layer || !Array.isArray(layer.elements)) { flashPasteHint('No hay capa destino'); return }
    targetArr = layer.elements
    insertAt = at == null ? layer.elements.length : at
    pathFor = (idx) => `sections.${si}.layers.${li}.elements.${idx}`
  }

  // Target is valid → commit (undoable).
  pushUndo()
  const fresh = regenerateIds(cb.data, cb.kind)
  targetArr!.splice(insertAt, 0, fresh)
  let newPath: string | null = pathFor(insertAt)

  // A cut consumes the original on the first paste (find by id so it works
  // even after a view switch). Subsequent pastes behave like copy.
  if (cb.op === 'cut' && cb.sourceId && cb.sourceId !== fresh.id) {
    const loc = findNodeLocationById(cb.sourceId, cb.kind)
    if (loc) loc.arr.splice(loc.index, 1)
    state.clipboard = { ...cb, op: 'copy', sourceId: undefined }
    // The splice above can shift the freshly-pasted index when source and
    // target share the same array and the source preceded it. Re-derive the
    // selection path from the fresh node's actual location in the ACTIVE view.
    newPath = pathOfNodeInActiveView(fresh.id, cb.kind)
  }

  if (newPath) state.selectedPath = newPath
  flashPasteHint('Pegado')
}

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 667 },
}

// ─── Zoom limits ───────────────────────────────────────────────────────────────

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 3

export function setZoom(z: number) {
  state.canvasZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100))
}

// Manual zoom while in overview is intentionally NON-confusing for a
// non-technical user: it simply turns "Vista completa" OFF and KEEPS whatever
// zoom the user just chose (no snapping back). The pre-overview snapshot is
// discarded since the user is now driving the zoom themselves.
export function exitOverviewKeepingZoom() {
  if (!state.overviewMode) return
  state.overviewMode = false
  state.overviewContentHeight = 0
  state.preOverview = null
}

export function zoomIn() {
  exitOverviewKeepingZoom()
  setZoom(state.canvasZoom + 0.1)
}

export function zoomOut() {
  exitOverviewKeepingZoom()
  setZoom(state.canvasZoom - 0.1)
}

// Fit the artboard inside the visible canvas viewport (cmd+0)
export function zoomToFit(canvasW: number, canvasH: number) {
  exitOverviewKeepingZoom()
  const vp = VIEWPORTS[state.deviceMode]
  if (!canvasW || !canvasH) {
    setZoom(0.5)
    state.canvasPan = { x: 0, y: 0 }
    return
  }
  const padding = 48
  const scale = Math.min(
    (canvasW - padding * 2) / vp.width,
    (canvasH - padding * 2) / vp.height,
  )
  setZoom(scale)
  // Center the scaled artboard within the canvas
  const scaledW = vp.width * state.canvasZoom
  const scaledH = vp.height * state.canvasZoom
  state.canvasPan = {
    x: Math.round((canvasW - scaledW) / 2),
    y: Math.round((canvasH - scaledH) / 2),
  }
}

// ─── "Vista completa" (overview / hoja gigante) ────────────────────────────────
//
// Default OFF → today's behavior is byte-for-byte unchanged (device-proportion
// artboard + per-section vertical scroll). ON → the WHOLE composition (every
// section stacked, full total height) is scaled to fit the visible canvas at
// once so Daniela can eyeball the whole sheet, no per-screen scrolling.
//
// Implementation: the canvas already renders a scaled `.preview-frame`
// (vp.width × vp.height) that clips its tall content to a native inner
// scroller. Overview = grow that frame to the FULL stacked height and zoom it
// so the whole thing fits — i.e. exactly "zoom to fit the entire frame", reusing
// the canvas sizing/zoom machinery instead of a parallel renderer. The inner
// scroll is neutralized while active (everything is visible, nothing to scroll).

// Sum of the active view's section heights, resolved to PX against the device
// viewport height the editor uses for the artboard (desktop 900 / mobile 667).
// Section.height is a CSS length: "100vh"/"150vh" → fraction × vp.height;
// "<n>px" → n; "<n>%" → fraction × vp.height; bare number → px. Unknown →
// fall back to one viewport so we never collapse to 0. This is the fallback
// used when a live measurement isn't available (e.g. canvas not mounted yet).
export function overviewContentHeightFromModel(): number {
  const vp = VIEWPORTS[state.deviceMode]
  const sections = activeSections()
  if (!sections.length) return vp.height
  let total = 0
  for (const sec of sections) {
    // Hidden sections are dropped from the rendered preview copy, so exclude
    // them here too (keeps the fit math matching what's actually painted).
    if ((sec as any).visible === false) continue
    const h = (sec as any).height
    let px = vp.height
    if (typeof h === 'number') {
      px = h
    } else if (typeof h === 'string') {
      const m = h.trim().match(/^([\d.]+)\s*(vh|%|px|vw)?$/i)
      if (m) {
        const n = parseFloat(m[1])
        const unit = (m[2] || 'px').toLowerCase()
        if (unit === 'vh' || unit === '%') px = (n / 100) * vp.height
        else if (unit === 'vw') px = (n / 100) * vp.width
        else px = n
      }
    }
    total += px
  }
  return total > 0 ? total : vp.height
}

// The artboard height (px, UNSCALED) the canvas should render. Overview ON →
// the full stacked content height; OFF → the device viewport height (today's
// fixed artboard). Prefers the live-measured height (exact vs. however `vh`
// actually resolved in the engine) and falls back to the model sum.
export function artboardHeight(): number {
  if (!state.overviewMode) return VIEWPORTS[state.deviceMode].height
  return state.overviewContentHeight > 0
    ? state.overviewContentHeight
    : overviewContentHeightFromModel()
}

// Fit the full artboard (vp.width × artboardHeight) inside the visible canvas
// with a small padding, and center it. Same scale/center math as zoomToFit,
// just against the (taller) overview artboard height — so overview is exactly
// "zoom to fit the whole frame".
function fitOverview(canvasW: number, canvasH: number) {
  const vp = VIEWPORTS[state.deviceMode]
  const contentH = artboardHeight()
  if (!canvasW || !canvasH || !contentH) {
    setZoom(0.2)
    state.canvasPan = { x: 0, y: 0 }
    return
  }
  const padding = 32
  const scale = Math.min(
    (canvasW - padding * 2) / vp.width,
    (canvasH - padding * 2) / contentH,
  )
  setZoom(scale)
  const scaledW = vp.width * state.canvasZoom
  const scaledH = contentH * state.canvasZoom
  state.canvasPan = {
    x: Math.round((canvasW - scaledW) / 2),
    y: Math.round((canvasH - scaledH) / 2),
  }
}

/**
 * Turn "Vista completa" ON. Snapshots the current zoom/pan/inner-scroll so
 * disabling restores it EXACTLY, records the live-measured total content
 * height, then fits the whole composition into the canvas.
 *
 * `measuredHeight` is the live `scrollHeight` of the inner preview scroller
 * (what the engine actually painted, however its `vh` resolved). When omitted
 * we fall back to the model sum. `scrollTop/Left` capture the inner scroll so
 * it can be restored on exit.
 */
export function enableOverview(
  canvasW: number,
  canvasH: number,
  opts?: { measuredHeight?: number; scrollTop?: number; scrollLeft?: number },
) {
  if (state.overviewMode) return
  state.preOverview = {
    zoom: state.canvasZoom,
    pan: { x: state.canvasPan.x, y: state.canvasPan.y },
    scrollTop: opts?.scrollTop ?? 0,
    scrollLeft: opts?.scrollLeft ?? 0,
  }
  state.overviewContentHeight =
    opts?.measuredHeight && opts.measuredHeight > 0
      ? opts.measuredHeight
      : overviewContentHeightFromModel()
  state.overviewMode = true
  fitOverview(canvasW, canvasH)
}

/**
 * Turn "Vista completa" OFF. Restores the pre-overview zoom/pan exactly. The
 * inner scroll restore is best-effort and handled by the canvas (it owns the
 * scroller element) reading state.preOverview before we clear it; we expose
 * the snapshot via consumePreOverviewScroll().
 */
export function disableOverview() {
  if (!state.overviewMode) return
  state.overviewMode = false
  state.overviewContentHeight = 0
  const snap = state.preOverview
  if (snap) {
    setZoom(snap.zoom)
    state.canvasPan = { x: snap.pan.x, y: snap.pan.y }
  }
  // preOverview is kept until the canvas consumes the inner-scroll part.
}

// The canvas calls this AFTER overview is disabled and the frame has shrunk
// back, to restore the inner section scroll, then clears the snapshot.
export function consumePreOverviewScroll(): { scrollTop: number; scrollLeft: number } | null {
  const snap = state.preOverview
  state.preOverview = null
  if (!snap) return null
  return { scrollTop: snap.scrollTop, scrollLeft: snap.scrollLeft }
}

// Re-measure + re-fit while overview is ACTIVE (device toggle, view switch,
// or content edits change the total stacked height). No-op when OFF so the
// normal mode is never touched.
export function refitOverview(
  canvasW: number,
  canvasH: number,
  measuredHeight?: number,
) {
  if (!state.overviewMode) return
  if (measuredHeight && measuredHeight > 0) {
    state.overviewContentHeight = measuredHeight
  } else {
    state.overviewContentHeight = overviewContentHeightFromModel()
  }
  fitOverview(canvasW, canvasH)
}

// Toggle entry point used by the toolbar checkbox. The canvas measures the
// live content height + current inner scroll and passes them in.
export function setOverview(
  on: boolean,
  canvasW: number,
  canvasH: number,
  opts?: { measuredHeight?: number; scrollTop?: number; scrollLeft?: number },
) {
  if (on) enableOverview(canvasW, canvasH, opts)
  else disableOverview()
}

// ─── Creation: sections / layers / elements ────────────────────────────────────

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

function newSection(): Section {
  return {
    id: uid('section'),
    height: '100vh',
    scrollBehavior: 'continuous',
    scrollDirection: 'vertical',
    background: { type: 'color', value: '#ffffff' },
    layers: [newLayer()],
  } as Section
}

function newLayer(): Layer {
  return {
    id: uid('layer'),
    depth: 0,
    parallaxMode: [],
    blur: 0,
    opacity: 1,
    perspective3d: false,
    elements: [],
  } as Layer
}

function newTextElement(): AnyElement {
  return {
    type: 'text',
    id: uid('text'),
    position: { x: 50, y: 50 },
    anchor: 'center',
    opacity: 1,
    rotation: 0,
    visible: true,
    interactive: false,
    content: 'Texto nuevo',
    fontSize: '32px',
    fontWeight: 400,
    color: '#000000',
    semanticTag: 'p',
    splitMode: 'none',
    staggerDelay: 0,
    animations: [
      { type: 'fadeIn', trigger: 'enter', from: 0, to: 1, duration: 800, easing: 'easeOut' },
    ],
  } as AnyElement
}

function newPngElement(): AnyElement {
  return {
    type: 'png',
    id: uid('png'),
    position: { x: 50, y: 50 },
    size: { width: 30 },
    anchor: 'center',
    opacity: 1,
    rotation: 0,
    visible: true,
    interactive: false,
    src: '',
    alt: '',
    animations: [
      { type: 'fadeIn', trigger: 'enter', from: 0, to: 1, duration: 800, easing: 'easeOut' },
    ],
  } as AnyElement
}

function newVideoElement(): AnyElement {
  return {
    type: 'video',
    id: uid('video'),
    position: { x: 50, y: 50 },
    size: { width: 40 },
    anchor: 'center',
    opacity: 1,
    rotation: 0,
    visible: true,
    interactive: false,
    src: '',
    autoplay: false,
    muted: true,
    loopMedia: false,
    volume: 1,
    controls: true,
    playsinline: true,
    animations: [],
  } as AnyElement
}

function newAudioElement(): AnyElement {
  return {
    type: 'audio',
    id: uid('audio'),
    position: { x: 50, y: 50 },
    anchor: 'center',
    opacity: 1,
    rotation: 0,
    visible: true,
    interactive: false,
    src: '',
    autoplay: false,
    muted: true,
    loopMedia: false,
    volume: 1,
    controls: true,
    animations: [],
  } as AnyElement
}

// FormBlock is an engine built-in component (type: "component",
// name: "FormBlock"). Default props give Daniela a working RSVP form she
// can edit in the Properties panel (a couple of starter fields).
function newFormElement(): AnyElement {
  return {
    type: 'component',
    id: uid('form'),
    name: 'FormBlock',
    position: { x: 50, y: 50 },
    size: { width: 'min(90%, 500px)' },
    anchor: 'center',
    opacity: 1,
    rotation: 0,
    visible: true,
    interactive: true,
    props: {
      webhookUrl: '',
      fields: [
        { name: 'nombre', label: 'Tu nombre', type: 'text', required: true },
        { name: 'asistencia', label: '¿Asistirás?', type: 'select', options: ['Sí', 'No'], required: true },
      ],
      submitLabel: 'Confirmar',
      successMessage: '¡Gracias por confirmar!',
      errorMessage: 'Hubo un error. Intenta de nuevo.',
      honeypotField: 'website',
      styling: {
        inputBg: 'var(--color-paper)',
        inputBorder: 'var(--color-accent)',
        buttonBg: 'var(--color-ink)',
        buttonText: 'var(--color-paper)',
        fontFamily: 'var(--font-body)',
      },
    },
    animations: [
      { type: 'fadeIn', trigger: 'enter', from: 0, to: 1, duration: 800, easing: 'easeOut' },
    ],
  } as AnyElement
}

export function addSection() {
  if (!state.site) return
  pushUndo()
  const sections = activeSections()
  sections.push(newSection())
  state.selectedPath = `sections.${sections.length - 1}`
}

// sectionPath like "sections.0"
export function addLayer(sectionPath: string) {
  if (!state.site) return
  const section = getAtPath(sectionPath)
  if (!section || !Array.isArray(section.layers)) return
  pushUndo()
  section.layers.push(newLayer())
  state.selectedPath = `${sectionPath}.layers.${section.layers.length - 1}`
}

// UI element kinds → schema element types.
// 'form' → component/FormBlock (engine built-in).
export type ElementKind = 'text' | 'png' | 'video' | 'audio' | 'form'

const ELEMENT_FACTORIES: Record<ElementKind, () => AnyElement> = {
  text: newTextElement,
  png: newPngElement,
  video: newVideoElement,
  audio: newAudioElement,
  form: newFormElement,
}

// layerPath like "sections.0.layers.1"
export function addElement(layerPath: string, kind: ElementKind) {
  if (!state.site) return
  const layer = getAtPath(layerPath)
  if (!layer || !Array.isArray(layer.elements)) return
  const factory = ELEMENT_FACTORIES[kind]
  if (!factory) return
  pushUndo()
  layer.elements.push(factory())
  state.selectedPath = `${layerPath}.elements.${layer.elements.length - 1}`
}

/**
 * Resolve the layer path to add an element into, based on current selection.
 * - element selected → its parent layer
 * - layer selected   → that layer
 * - section selected → its first layer (create one if none)
 * - nothing selected → first layer of first section (create as needed)
 * Returns null only if there is no site.
 */
export function resolveAddElementLayerPath(): string | null {
  if (!state.site) return null
  const sel = getSelected()
  if (sel) {
    if (sel.type === 'element') return state.selectedPath!.split('.').slice(0, -2).join('.')
    if (sel.type === 'layer') return state.selectedPath!
    if (sel.type === 'section') {
      const section = sel.data
      if (!Array.isArray(section.layers) || section.layers.length === 0) {
        addLayer(state.selectedPath!)
        return state.selectedPath
      }
      return `${state.selectedPath}.layers.0`
    }
  }
  // Fallback: ensure section 0 + layer 0 exist (in the ACTIVE view).
  if (activeSections().length === 0) addSection()
  const section = activeSections()[0]
  if (!section.layers || section.layers.length === 0) addLayer('sections.0')
  return 'sections.0.layers.0'
}
