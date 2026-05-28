import { reactive, computed, watch } from 'vue'
import type { Site, Section, Layer, AnyElement } from '@parallax-editor/parallax-engine/schema'
import { toViews, resolveSections } from '@parallax-editor/parallax-engine'
import { componentsApi, type ComponentRegistration, type EditablePropSchema } from '../composables/useApi'

export type { ComponentRegistration, EditablePropSchema }

export type Tool = 'select' | 'hand' | 'zoom'
export type DeviceMode = 'desktop' | 'mobile'

// Clipboard kinds mirror the three tree node levels.
export type ClipboardKind = 'section' | 'layer' | 'element'
// One snapshotted node (used for multi-selection copy/cut — task #107). Each
// node keeps its OWN kind so a mixed-kind multi-selection round-trips faithfully.
export interface ClipboardItem {
  kind: ClipboardKind
  // Deep snapshot taken at copy/cut time (ids regenerated on every paste).
  data: any
  // Id the node lived under at copy/cut time (so a 'cut' paste can delete the
  // original by re-locating it, even after a view switch).
  sourceId?: string
}
export interface Clipboard {
  // ── Legacy single-node fields (UNCHANGED) ────────────────────────────────
  // Always mirror items[0] so every existing single-select surface
  // (clipboardLabel, etc.) keeps working byte-for-byte.
  kind: ClipboardKind
  // Deep snapshot taken at copy/cut time (ids regenerated on every paste).
  data: any
  // 'cut' removes the source on the first paste; 'copy' keeps it.
  op: 'copy' | 'cut'
  // Path the cut node lived at (so the first paste can delete it). View-aware
  // bookkeeping is unnecessary because cut deletes by re-locating the node id.
  sourceId?: string
  // ── Multi-selection (task #107) ──────────────────────────────────────────
  // ALL snapshotted nodes in tree order. Single-select copies a 1-length array;
  // multi-select copies the whole set. Paste replays every item.
  items: ClipboardItem[]
}
// 'edit'   → elements manipulable, parallax/animations paused (design view)
// 'preview'→ engine runs animations/parallax so the effect is visible
export type PreviewMode = 'edit' | 'preview'

export interface EditorState {
  // Fase 2: this is the active WORKSPACE ID (was the hardcoded 'eventos'|'site'
  // type). The two seeded defaults still use those exact ids, so per-project
  // localStorage keys (tree-collapsed:<ws>:<slug>, grid-guias:<ws>:<slug>) and
  // every :ws API route stay byte-for-byte compatible.
  projectType: string | null
  slug: string | null
  site: Site | null
  originalSite: string | null
  // Blindaje de autoría (#claude-prefix): cuando un cambio en disco vino de una
  // corrida de `claude -p`, guardamos aquí el JSON resultante. Al guardar, si el
  // contenido sigue siendo IDÉNTICO a este baseline (the user no editó a mano
  // encima), el commit se prefija con "Claude:". Cualquier edición manual lo hace
  // diferir → sin prefijo. Se auto-invalida solo, sin enganchar cada mutación.
  claudeBaseline: string | null
  selectedPath: string | null
  // ── Multi-selection (GAP5) ───────────────────────────────────────────────
  // `selectedPath` stays the PRIMARY selection — every existing single-select
  // surface (PROPIEDADES, single-element resize/rotate, CAPAS, animations,
  // copy/paste, getSelected) keys off it UNCHANGED. `selectedPaths` is the
  // ADDITIVE multi-set used ONLY by the canvas: shift+click on the canvas
  // adds/removes element paths here. Invariants:
  //   • length 0 or 1  → behaves exactly like today (single select). The
  //     overlay renders the normal box with resize/rotate handles.
  //   • length ≥ 2     → the overlay renders a GROUP bounding box with a
  //     move-area only (group resize/rotate intentionally out of scope per
  //     the plan); a group drag moves EVERY selected element by the same
  //     delta through the SAME anchor-aware + unit-preserving + clamp logic.
  // Element-only (sections/layers aren't multi-selectable on the canvas).
  // Always kept in sync so `selectedPath` is the last entry when non-empty.
  selectedPaths: string[]
  tool: Tool
  deviceMode: DeviceMode
  previewMode: PreviewMode
  canvasZoom: number
  canvasPan: { x: number; y: number }
  // ── Space = temporary pan modifier (GAP9) ────────────────────────────────
  // While Space is held (and not typing in a field) the canvas behaves like
  // the Mano/hand tool: cursor → grab, drag pans the workspace. Releasing
  // Space restores whatever tool was active. This is a TRANSIENT modifier, not
  // a tool: state.tool is untouched (so V/H/Z stay intact) — useCanvas and
  // EditorCanvas just treat `spacePanning` as "pan like hand right now".
  spacePanning: boolean
  undoStack: string[]
  redoStack: string[]
  isClaudeLoading: boolean
  // Grid OVERLAY visibility — INDEPENDENT of snapping. The visible blue grid
  // can be on without snap, and snap can be on without the overlay drawn.
  gridVisible: boolean
  // "Ajustar a la grid": snap moved/resized elements to the grid step. Used to
  // mean both visibility AND snap; now ONLY the snap.
  snapToGrid: boolean
  // Grid cell size as a PERCENT of the artboard (drives both the overlay
  // density and the snap step). Sensible range ~2–25%. The exported
  // GRID_PERCENT getter mirrors this so existing importers stay reactive.
  gridPercent: number
  // Smart alignment guides (the purple relation lines vs other elements) — on by
  // default in Edición; toggled like the grid.
  smartGuides: boolean
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
  // (1440×900 / 390×844) with vertical scroll through the sections.
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
  // ── Autosave (UI pref, persisted) ─────────────────────────────────────────
  // OFF (default) = behavior unchanged: manual "Guardar" only. ON = the editor
  // debounces a save (~1.5s after the last change) whenever the document is
  // dirty, reusing the SAME save path as the manual button (EditorView.save()).
  autosave: boolean
  // Transient autosave status for the subtle toolbar indicator. 'idle' shows
  // nothing; 'saving' while the PUT is in flight; 'saved' briefly after.
  autosaveStatus: 'idle' | 'saving' | 'saved'
  // ── Congelar animaciones (UI pref, persisted) ─────────────────────────────
  // OFF (default) = Edición anima igual que Preview (refleja la realidad). ON =
  // Edición congela los movimientos (scale/translate/rotate/loop) en su estado
  // base para posicionar con precisión — equivale a staticMotion del engine.
  // Solo afecta EDICIÓN; Preview siempre anima.
  freezeAnims: boolean
  // Bumped to force EditorCanvas to re-mount the preview ParallaxSite so all
  // engine animations replay from the start ("Reiniciar mesa"), WITHOUT
  // reloading the app or losing selection/view/zoom/dirty state.
  previewNonce: number
  // ── Custom component registry (GAP1 / PLAN §13) ──────────────────────────
  // Serializable registry of the active project type's registered custom
  // components (parallax.config.ts in the neighbor repo), fetched on project
  // load. Keyed by component name → { name, label, description, editableProps }.
  // The actual Vue refs are NOT here (stripped server-side); the canvas
  // dynamically imports the real SFCs. eventos → {} (built-ins only).
  componentRegistry: Record<string, ComponentRegistration>
  // Non-fatal: present when the neighbor's parallax.config.ts exists but
  // failed to load (the editor still works on built-ins). Surfaced subtly.
  componentRegistryError: string | null
  // Bumped after every successful save/commit so an open GitPanel can refresh
  // its log reactively (history was stale after autosave/manual save — GAP7).
  gitLogNonce: number
  // Bumped whenever the project's ASSETS change (any panel uploads/deletes an
  // asset, or the file-watcher sees an external change). Every panel that LISTS
  // resources (PropertiesPanel autocomplete, ComponentPropsEditor image picker,
  // ResourcesPanel) watches this so the lists/thumbnails never go stale mid-
  // session — previously they only refreshed on mount, so a newly uploaded (or
  // Claude-added) image didn't appear until you exited and re-entered the
  // project. Single shared signal = all asset consumers stay in sync.
  assetsNonce: number
}

export const state = reactive<EditorState>({
  projectType: null,
  slug: null,
  site: null,
  originalSite: null,
  claudeBaseline: null,
  selectedPath: null,
  selectedPaths: [],
  tool: 'select',
  deviceMode: 'desktop',
  previewMode: 'edit',
  canvasZoom: 0.5,
  canvasPan: { x: 0, y: 0 },
  spacePanning: false,
  undoStack: [],
  redoStack: [],
  isClaudeLoading: false,
  gridVisible: false,
  snapToGrid: false,
  gridPercent: 5,
  smartGuides: true,
  gridSize: 10,
  errors: [],
  clipboard: null,
  pasteHint: null,
  lockedIds: [],
  overviewMode: false,
  overviewContentHeight: 0,
  preOverview: null,
  autosave: false,
  autosaveStatus: 'idle',
  freezeAnims: false,
  previewNonce: 0,
  componentRegistry: {},
  componentRegistryError: null,
  gitLogNonce: 0,
  assetsNonce: 0,
})

/**
 * Fetch + cache the custom-component registry for a project `type`
 * (`eventos` | `site`) from the editor's discovery route. Called on project
 * load. Resilient: a network/parse failure clears the registry rather than
 * throwing — the add menu/properties just fall back to built-ins only.
 */
export async function fetchComponentRegistry(type: string) {
  try {
    const r = await componentsApi.list(type)
    // Guard against the project being closed/switched mid-flight.
    if (state.projectType !== type) return
    state.componentRegistry = r?.components ?? {}
    state.componentRegistryError = r?.error ?? null
  } catch {
    if (state.projectType !== type) return
    state.componentRegistry = {}
    state.componentRegistryError = null
  }
}

// Custom components registered for the active project (excludes the engine
// built-in FormBlock, which keeps its dedicated add/edit path). Used by the
// add menu and the generic properties renderer.
export const customComponents = computed<ComponentRegistration[]>(() =>
  Object.values(state.componentRegistry).filter((c) => c.name !== 'FormBlock'),
)

export function getComponentRegistration(
  name: string | undefined | null,
): ComponentRegistration | null {
  if (!name) return null
  return state.componentRegistry[name] || null
}

// ─── Persisted UI preferences (localStorage) ───────────────────────────────────
//
// ONLY the three config checkboxes are persisted — Autosave, Grid
// (snapToGrid) and "Vista completa" (overviewMode) — under a single stable
// namespace. Transient per-project state (selection, zoom/pan, undo stack,
// the loaded site) is intentionally NOT persisted. `overviewMode` is restored
// as a *pending* flag (see prefsWantOverview): the canvas re-enables it via
// the real enable/fit path once the project + canvas are measured, never by
// blindly setting state.overviewMode (which would skip the fit math).

const PREFS_KEY = 'parallax-editor:prefs'

// Set true at hydration time when the saved prefs asked for overview. The
// canvas consumes it after the project + canvas are ready and calls the
// normal enableOverview/fit path, then clears it. We do NOT set
// state.overviewMode directly on load.
export const prefsWantOverview = { value: false }

interface PersistedPrefs {
  autosave?: boolean
  overviewMode?: boolean
  freezeAnims?: boolean
  // NOTE: grid/guías settings (gridVisible, snapToGrid, gridPercent,
  // smartGuides) are NOT here — they are PER-PROJECT (see GridGuias* below).
  // Configurable artboard sizes (#90): both mobile and desktop are
  // user-configurable and persisted.
  mobileWidth?: number
  mobileHeight?: number
  desktopWidth?: number
  desktopHeight?: number
  // Last selected device toggle (Escritorio/Móvil) — remembered across reloads.
  deviceMode?: DeviceMode
}

function readPrefs(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePrefs(prefs: PersistedPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* localStorage unavailable / quota — non-fatal, prefs just won't persist */
  }
}

/**
 * Hydrate the persisted UI prefs into the store BEFORE the editor first
 * renders. Autosave + Grid are plain booleans applied directly. Overview is
 * recorded as a pending intent only (prefsWantOverview) — the canvas applies
 * it through the real enable/fit path once it has measurements.
 */
export function hydratePrefs() {
  const p = readPrefs()
  if (typeof p.autosave === 'boolean') state.autosave = p.autosave
  if (typeof p.freezeAnims === 'boolean') state.freezeAnims = p.freezeAnims
  prefsWantOverview.value = p.overviewMode === true
  // Mobile artboard size (#90): hydrate the reactive viewport so the saved
  // device size survives reloads. Validated/clamped to a sane range.
  if (isFinitePositive(p.mobileWidth) && isFinitePositive(p.mobileHeight)) {
    mobileViewport.width = clampDimension(p.mobileWidth as number)
    mobileViewport.height = clampDimension(p.mobileHeight as number)
  }
  if (isFinitePositive(p.desktopWidth) && isFinitePositive(p.desktopHeight)) {
    desktopViewport.width = clampDimension(p.desktopWidth as number)
    desktopViewport.height = clampDimension(p.desktopHeight as number)
  }
  if (p.deviceMode === 'mobile' || p.deviceMode === 'desktop') {
    state.deviceMode = p.deviceMode
  }
}

// Write the current value of the persisted prefs through to localStorage.
// `overviewMode` reflects the LIVE store flag so toggling it in the toolbar
// persists immediately; on next load it becomes a pending intent. The mobile
// artboard size persists alongside (#90).
export function persistPrefs() {
  writePrefs({
    autosave: state.autosave,
    overviewMode: state.overviewMode,
    freezeAnims: state.freezeAnims,
    mobileWidth: mobileViewport.width,
    mobileHeight: mobileViewport.height,
    desktopWidth: desktopViewport.width,
    desktopHeight: desktopViewport.height,
    deviceMode: state.deviceMode,
  })
}
// Persist the device toggle (Escritorio/Móvil) whenever it changes, from any
// path (toolbar click, enableIndependentViews, …).
watch(() => state.deviceMode, () => persistPrefs())

export function setAutosave(on: boolean) {
  state.autosave = on
  persistPrefs()
}

export function setFreezeAnims(on: boolean) {
  state.freezeAnims = on
  persistPrefs()
}

// ─── Tree collapse state (TASK #77) ────────────────────────────────────────
//
// Which section/layer nodes are collapsed in the CAPAS tree, persisted PER
// PROJECT under `parallax-editor:tree-collapsed:<type>:<slug>` (same namespace
// convention as the other persisted prefs, #50). The key is the node's id when
// it has one, else its view-relative path — so a node with no id yet still
// collapses, and once it gets an id the state follows it. Reactive so the tree
// re-renders on toggle; lazily hydrated when a project loads.
const TREE_COLLAPSE_PREFIX = 'parallax-editor:tree-collapsed'
export const collapsedNodes = reactive<Record<string, true>>({})

function treeCollapseKey(): string | null {
  if (!state.projectType || !state.slug) return null
  return `${TREE_COLLAPSE_PREFIX}:${state.projectType}:${state.slug}`
}

// ── Grid & guías settings — PER PROJECT (user decision) ──────────────────────
// Grid visibility / snap / cell-size and the smart (purple) guides are
// remembered PER SITE — like the tree-collapse state and Claude history — NOT
// in the global editor prefs. Keyed by type:slug; hydrated when a project opens
// (loadSite) and written on every change (GridGuidesControl → persistGridGuias).
const GRID_GUIAS_PREFIX = 'parallax-editor:grid-guias'
function gridGuiasKey(): string | null {
  if (!state.projectType || !state.slug) return null
  return `${GRID_GUIAS_PREFIX}:${state.projectType}:${state.slug}`
}
export function hydrateGridGuias() {
  // Reset to defaults FIRST so one project's grid never bleeds into the next.
  state.gridVisible = false
  state.snapToGrid = false
  state.gridPercent = 5
  state.smartGuides = true
  const key = gridGuiasKey()
  if (!key) return
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return
    const p = JSON.parse(raw) || {}
    if (typeof p.gridVisible === 'boolean') state.gridVisible = p.gridVisible
    if (typeof p.snapToGrid === 'boolean') state.snapToGrid = p.snapToGrid
    if (typeof p.smartGuides === 'boolean') state.smartGuides = p.smartGuides
    if (isFinitePositive(p.gridPercent)) {
      state.gridPercent = Math.min(GRID_PERCENT_MAX, Math.max(GRID_PERCENT_MIN, p.gridPercent))
    }
  } catch { /* corrupt entry → keep defaults */ }
}
export function persistGridGuias() {
  const key = gridGuiasKey()
  if (!key) return
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        gridVisible: state.gridVisible,
        snapToGrid: state.snapToGrid,
        gridPercent: state.gridPercent,
        smartGuides: state.smartGuides,
      }),
    )
  } catch { /* quota / unavailable — non-fatal */ }
}

export function hydrateTreeCollapse() {
  for (const k of Object.keys(collapsedNodes)) delete collapsedNodes[k]
  const key = treeCollapseKey()
  if (!key) return
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === 'string') collapsedNodes[id] = true
      }
    }
  } catch {
    /* corrupt → start expanded */
  }
}

function persistTreeCollapse() {
  const key = treeCollapseKey()
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(Object.keys(collapsedNodes)))
  } catch {
    /* quota / disabled — non-fatal */
  }
}

// Stable collapse key for a node: prefer its id (survives reorders), else the
// view-relative path.
export function collapseKeyFor(nodeId: string | undefined | null, path: string): string {
  return nodeId ? `id:${nodeId}` : `path:${path}`
}

export function isCollapsed(nodeId: string | undefined | null, path: string): boolean {
  return collapsedNodes[collapseKeyFor(nodeId, path)] === true
}

export function toggleCollapsed(nodeId: string | undefined | null, path: string) {
  const k = collapseKeyFor(nodeId, path)
  if (collapsedNodes[k]) delete collapsedNodes[k]
  else collapsedNodes[k] = true
  persistTreeCollapse()
}

// "Reiniciar mesa": bump the nonce so EditorCanvas re-mounts the preview
// ParallaxSite (engine animations replay from 0). Pure editor view state —
// never touches site.json, selection, view mode, zoom/pan or dirty state.
export function restartPreview() {
  state.previewNonce++
}

// ─── View model: compartido (legacy) vs independiente (v1.1 views) ─────────────
//
// A legacy/compartido site keeps ONE shared `site.sections` tree (current
// behavior, per-element mobile/desktop overrides intact). It is NEVER
// auto-migrated. The user opts in via the "Configuración independiente
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
// in EditorCanvas and the snap math in SelectionOverlay BOTH use this so what
// The user sees lines up exactly with where elements land.
//
// The cell size is now user-configurable (state.gridPercent, default 5%). This
// is a LIVE export binding kept mirrored to state.gridPercent by a watcher:
// SelectionOverlay reads it imperatively at drag time, so it always sees the
// current value WITHOUT us editing SelectionOverlay (not in scope). EditorCanvas
// reads state.gridPercent directly for its reactive overlay style.
export let GRID_PERCENT = state.gridPercent
watch(
  () => state.gridPercent,
  (v) => {
    GRID_PERCENT = v
  },
  { immediate: true },
)

// Allowed cell-size range (% of artboard). Kept here so the toolbar control and
// any clamping share one source of truth.
export const GRID_PERCENT_MIN = 2
export const GRID_PERCENT_MAX = 25

// A canvas move/resize/rotate drag ends with a `mouseup` that the browser
// turns into a `click` bubbling to the canvas. Without this guard that click
// hits handleCanvasClick and — if the pointer was released over the pasteboard
// or a different element — DESELECTS what was just dragged (selection box
// vanishes mid-edit). The SelectionOverlay stamps a timestamp on drag end and
// handleCanvasClick swallows the one click that immediately follows.
export const dragGuard = { lastDragEnd: 0 }
export function markDragEnded() {
  dragGuard.lastDragEnd = Date.now()
}
export function shouldSwallowCanvasClick(): boolean {
  return Date.now() - dragGuard.lastDragEnd < 300
}

// True while an element move/resize/rotate drag is actively in progress on the
// canvas. Module-level (NOT in the reactive `state`) so flipping it never
// triggers reactive watchers / re-renders. Item #2: while "Vista completa"
// (overview) is ON, dragging an element mutates `state.site` (the element's
// position), which fires the canvas' deep site watcher → refitOverview →
// setZoom, RESETTING the zoom/pan mid-drag. The overview-refit watcher consults
// this flag and skips refitting while a drag is live, so the current zoom/pan
// stay put. A genuine content-driven height change (section add/edit) still
// refits because that doesn't happen during a drag.
export const canvasDrag = { active: false }
export function setCanvasDragActive(active: boolean) {
  canvasDrag.active = active
}
export function isCanvasDragActive(): boolean {
  return canvasDrag.active
}

export const isDirty = computed(() => {
  if (!state.site || !state.originalSite) return false
  return JSON.stringify(state.site) !== state.originalSite
})

export function loadSite(site: Site, projectType: string, slug: string) {
  state.site = site
  state.originalSite = JSON.stringify(site)
  state.claudeBaseline = null
  state.projectType = projectType
  state.slug = slug
  state.selectedPath = null
  state.selectedPaths = []
  state.undoStack = []
  state.redoStack = []
  state.errors = []
  // Reset the custom-component registry for the newly-opened project; the
  // EditorView kicks off fetchComponentRegistry(type) right after this.
  state.componentRegistry = {}
  state.componentRegistryError = null
  state.clipboard = null
  state.pasteHint = null
  state.overviewMode = false
  state.overviewContentHeight = 0
  state.preOverview = null
  // Re-arm the persisted "Vista completa" intent for THIS project load (the
  // canvas applies it via the real enable/fit path once measured). Read fresh
  // so reopening any project — not just the first after a tab reload —
  // restores the pref.
  prefsWantOverview.value = readPrefs().overviewMode === true
  // Hydrate editor-local locks from the OPTIONAL additive field if the saved
  // JSON carries one (kept out of the engine schema; sites ignore it).
  const persisted = (site as any).editorLocks
  state.lockedIds = Array.isArray(persisted) ? persisted.filter((x: any) => typeof x === 'string') : []
  // Restore the per-project CAPAS tree collapse state (#77).
  hydrateTreeCollapse()
  // Restore this project's own Grid & guías settings (per-project decision).
  hydrateGridGuias()
}

export function closeSite() {
  state.site = null
  state.originalSite = null
  state.slug = null
  state.selectedPath = null
  state.selectedPaths = []
  state.undoStack = []
  state.redoStack = []
  state.clipboard = null
  state.pasteHint = null
  state.lockedIds = []
  state.overviewMode = false
  state.overviewContentHeight = 0
  state.preOverview = null
  state.componentRegistry = {}
  state.componentRegistryError = null
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

// ─── Global (site-level) selection: "Sitio" (meta) + "Tema" (theme) ────────────
//
// `meta` and `theme` are TOP-LEVEL site config (NOT per section/layer/element
// and NOT per desktop/mobile view — they're shared regardless of independent-
// views mode). The CAPAS tree can only select section/layer/element paths, so
// there was no way to edit them. We model the two global targets as SENTINEL
// selection paths that aren't real dot-paths into the tree:
//
//   GLOBAL_SITE  = '@site'   → PROPIEDADES shows the meta form
//   GLOBAL_THEME = '@theme'  → PROPIEDADES shows the theme form
//
// Why a sentinel and not a path: getSelected() returns null for them (they're
// not section/layer/element), so the canvas SelectionOverlay (which keys off
// getAtPath(selectedPath)?.id) naturally renders nothing — no .selection-box,
// element selection is cleared. The forms read/write the REAL top-level paths
// ("meta.title", "theme.colors.accent") through getAtPath/setAtPath, which
// pass non-"sections" paths through verbatim → undo + dirty + view-agnostic
// (toCanonicalPath only rebases the leading "sections" token).
export const GLOBAL_SITE = '@site'
export const GLOBAL_THEME = '@theme'
// "Recursos" (TASK #85): a THIRD global sentinel, same model as @site/@theme.
// PROPIEDADES shows a per-project asset browser (images/fonts/audio/video).
// Assets are per project (NOT per desktop/mobile view) so this is fully
// view-agnostic, exactly like meta/theme. getSelected() returns null for it
// (not a tree node) so the canvas overlay hides — element selection cleared.
export const GLOBAL_RESOURCES = '@resources'

export function isGlobalPath(p: string | null | undefined): p is '@site' | '@theme' | '@resources' {
  return p === GLOBAL_SITE || p === GLOBAL_THEME || p === GLOBAL_RESOURCES
}

export const selectedGlobal = computed<'site' | 'theme' | 'resources' | null>(() => {
  if (state.selectedPath === GLOBAL_SITE) return 'site'
  if (state.selectedPath === GLOBAL_THEME) return 'theme'
  if (state.selectedPath === GLOBAL_RESOURCES) return 'resources'
  return null
})

// Select a global target. Clearing any element selection is implicit: the
// sentinel path makes getSelected() null and the overlay hides.
export function selectGlobal(which: 'site' | 'theme' | 'resources') {
  state.selectedPath =
    which === 'theme' ? GLOBAL_THEME : which === 'resources' ? GLOBAL_RESOURCES : GLOBAL_SITE
}

// Effective theme tokens used to scaffold `site.theme` on a legacy file that
// has none. We DON'T force-change rendering: this mirrors the engine's own
// fallbacks (ParallaxSite only applies CSS vars when theme exists; with no
// theme the page is browser-default black-on-white). Scaffolding only happens
// when the user actively edits a theme value, and seeds sensible neutrals so
// the very first edit doesn't repaint everything to an arbitrary palette.
// Exported so color controls (FormColorField) can paint their theme-preset
// swatches with the real resolved theme, falling back to these neutrals when
// `state.site.theme` is absent — instead of each control hardcoding a palette
// (the bug where the "accent" swatch always showed a fixed café).
export const DEFAULT_THEME = {
  colors: { ink: '#1a1a1a', paper: '#ffffff', accent: '#c8a04b' },
  typography: { display: 'Georgia, serif', body: 'system-ui, sans-serif' },
}

/**
 * Resolve the current site theme color for a token (ink/paper/accent),
 * falling back to DEFAULT_THEME when the site has no theme (or that token
 * is unset). Used by swatch controls to PREVIEW the real palette while the
 * value they store stays the CSS token (`var(--color-accent)`).
 */
export function resolvedThemeColor(token: 'ink' | 'paper' | 'accent'): string {
  const c = (state.site as any)?.theme?.colors
  const v = c && typeof c[token] === 'string' ? c[token].trim() : ''
  return v || DEFAULT_THEME.colors[token]
}

/**
 * Ensure `site.theme` exists before writing a theme field on a legacy site.
 * Additive: absent → cloned from DEFAULT_THEME (neutral, close to the
 * no-theme browser default). Pushes undo so the scaffold is itself undoable.
 * No-op when a theme already exists. Returns the (now guaranteed) theme.
 */
export function ensureTheme(): any {
  if (!state.site) return null
  const s = state.site as any
  if (!s.theme || typeof s.theme !== 'object') {
    pushUndo()
    s.theme = JSON.parse(JSON.stringify(DEFAULT_THEME))
  }
  return s.theme
}

// ─── Cursor (top-level, view-agnostic) ─────────────────────────────────────────
//
// `site.cursor` is OPTIONAL & additive (engine cursorSchema). It is NOT written
// until the user enables the follow-cursor — an untouched legacy file stays
// byte-identical (no `cursor` key). Mirrors the engine defaults so the saved
// object is a complete, valid CursorConfig. Shared across desktop/mobile.
export const DEFAULT_CURSOR = {
  enabled: true,
  color: '#000000',
  size: 20,
  hoverScale: 2,
  blendMode: 'difference',
}

// Toggle the follow-cursor. Enabling on a site with no `cursor` scaffolds the
// full default object (so color/size/blend controls have something to bind).
// Disabling just flips `enabled:false` (keeps the user's color/size choices for
// when they re-enable). pushUndo via setAtPath / here so the scaffold is
// undoable; setAtPath marks dirty.
export function setCursorEnabled(on: boolean) {
  if (!state.site) return
  const s = state.site as any
  if (on && (!s.cursor || typeof s.cursor !== 'object')) {
    pushUndo()
    s.cursor = JSON.parse(JSON.stringify(DEFAULT_CURSOR))
    return
  }
  setAtPath('cursor.enabled', on)
}

// Write one cursor sub-field (color/size/blendMode). Only callable while the
// cursor object exists (the form shows these controls only when enabled).
export function updateCursor(key: string, value: any) {
  if (!state.site) return
  const s = state.site as any
  if (!s.cursor || typeof s.cursor !== 'object') return
  setAtPath(`cursor.${key}`, value)
}

// Get the selected element/layer/section
export function getSelected(): { type: 'section' | 'layer' | 'element'; data: any; path: string } | null {
  if (!state.selectedPath || !state.site) return null
  // Global (meta/theme) selection is NOT a tree node — no overlay, no
  // element/section/layer props.
  if (isGlobalPath(state.selectedPath)) return null
  const parts = state.selectedPath.split('.')
  const data = getAtPath(state.selectedPath)
  if (!data) return null

  if (parts.length === 2) return { type: 'section', data, path: state.selectedPath }
  if (parts.length === 4) return { type: 'layer', data, path: state.selectedPath }
  if (parts.length === 6) return { type: 'element', data, path: state.selectedPath }
  return null
}

// ─── Multi-selection helpers (GAP5 + TASK #94) ─────────────────────────────
//
// `selectedPath` remains the PRIMARY/last selection so every existing
// single-select surface is byte-for-byte unchanged. `selectedPaths` is the
// multi-set. Originally (GAP5) it was canvas-only and element-only. TASK #94
// extends it so the CAPAS tree can Ctrl/Cmd+click ANY node (section / layer /
// element) into it — the user wants several nodes selected to feed Claude as
// context. To NOT break canvas group-move (which is element-only by design),
// the canvas reads `multiSelectedElementPaths` (the element-only subset) and
// `hasMultiSelection` (2+ ELEMENTS) — adding a section/layer to the set never
// turns on the canvas group box / group drag. The tree highlights every path
// in `selectedPaths` regardless of kind.

function isElementPath(p: string | null | undefined): boolean {
  return !!p && !isGlobalPath(p) && p.split('.').length === 6
}

// A real tree node path (section/layer/element), i.e. not a @global sentinel.
function isTreeNodePath(p: string | null | undefined): boolean {
  if (!p || isGlobalPath(p)) return false
  const n = p.split('.').length
  return n === 2 || n === 4 || n === 6
}

// Element-only subset of the multi-set — the canvas group overlay/move ONLY
// ever sees these, so a section/layer in the set can't drive a canvas drag.
export const multiSelectedElementPaths = computed(() =>
  state.selectedPaths.filter(isElementPath),
)

// True when 2+ ELEMENTS are multi-selected (canvas group overlay / group
// move). Deliberately element-scoped (NOT selectedPaths.length) so a tree
// multi-select that includes sections/layers never engages the canvas group.
export const hasMultiSelection = computed(
  () => multiSelectedElementPaths.value.length >= 2,
)

// Kind of a tree node path, for the Claude context chip / block labels.
function nodeKind(p: string): 'section' | 'layer' | 'element' | null {
  const n = p.split('.').length
  return n === 2 ? 'section' : n === 4 ? 'layer' : n === 6 ? 'element' : null
}

const KIND_ES: Record<'section' | 'layer' | 'element', string> = {
  section: 'sección',
  layer: 'capa',
  element: 'elemento',
}

export interface SelectedNodeInfo {
  path: string
  kind: 'section' | 'layer' | 'element'
  kindEs: string
  id: string
}

// The current multi-selection (or single selection) as a list of tree nodes,
// in selection order, for the Claude context chip. Falls back to the single
// `selectedPath` when the multi-set is empty so a plain click still shows the
// "1 elemento seleccionado" context.
export const selectedNodes = computed<SelectedNodeInfo[]>(() => {
  if (!state.site) return []
  const paths = state.selectedPaths.length
    ? state.selectedPaths
    : isTreeNodePath(state.selectedPath)
      ? [state.selectedPath as string]
      : []
  const out: SelectedNodeInfo[] = []
  for (const p of paths) {
    const kind = nodeKind(p)
    if (!kind) continue
    const node = getAtPath(p)
    if (!node) continue
    out.push({ path: p, kind, kindEs: KIND_ES[kind], id: node.id || '(sin id)' })
  }
  return out
})

// Build the concise context block PREPENDED to a Claude prompt so it knows
// which part of site.json to analyze/edit. Bounded: per-node JSON snippet is
// capped, and the overall block is capped, so a huge selection can't blow the
// prompt. The active view is resolved (independent views) by going through
// getAtPath, which rebases a leading "sections" onto the active view root.
const CTX_NODE_SNIPPET_CAP = 1800
const CTX_TOTAL_CAP = 14000
export function buildClaudeContextBlock(): string {
  const nodes = selectedNodes.value
  if (!nodes.length) return ''
  const lines: string[] = [
    'CONTEXTO DE SELECCIÓN (el usuario seleccionó estos nodos en el editor;',
    'analiza/edita SOLO lo relevante a ellos dentro de site.json):',
  ]
  for (const n of nodes) {
    const node = getAtPath(n.path)
    let snippet = ''
    try {
      snippet = JSON.stringify(node, null, 2)
    } catch {
      snippet = '(no serializable)'
    }
    if (snippet.length > CTX_NODE_SNIPPET_CAP) {
      snippet = snippet.slice(0, CTX_NODE_SNIPPET_CAP) + '\n… (recortado)'
    }
    lines.push(
      `\n- ${n.kindEs} "${n.id}" — ruta JSON: ${n.path}\n${snippet}`,
    )
  }
  let block = lines.join('\n')
  if (block.length > CTX_TOTAL_CAP) {
    block = block.slice(0, CTX_TOTAL_CAP) + '\n… (contexto recortado)\n'
  }
  return block + '\n\n— Fin del contexto —\n\n'
}

// Shift+click toggle on the canvas. Adds the path to the multi-set (seeding it
// with the current single selection first so the FIRST shift+click promotes
// "1 selected" → "2 selected"), or removes it if already present. Keeps
// `selectedPath` pointing at the most-recently-touched element so PROPIEDADES
// etc. still show something sensible.
export function toggleCanvasSelection(path: string) {
  if (!isElementPath(path)) return
  const set = state.selectedPaths.length
    ? [...state.selectedPaths]
    : isElementPath(state.selectedPath)
      ? [state.selectedPath as string]
      : []
  const i = set.indexOf(path)
  if (i >= 0) {
    set.splice(i, 1)
    state.selectedPaths = set
    // Primary follows the last remaining (or clears).
    state.selectedPath = set.length ? set[set.length - 1] : null
  } else {
    set.push(path)
    state.selectedPaths = set
    state.selectedPath = path
  }
}

// Plain (non-shift) canvas selection: single element, multi-set collapses.
export function setCanvasSelection(path: string | null) {
  state.selectedPath = path
  state.selectedPaths = isElementPath(path) ? [path as string] : []
}

// Selección por RECUADRO (marquee / rubber-band, #152): fija de una vez todos
// los elementos que el recuadro tocó. 0 → limpia; 1 → selección simple
// (selectedPaths vacío, selectedPath = ese); 2+ → multi-selección (misma
// convención que el resto: selectedPaths solo cuando hay >1). Filtra a rutas de
// elemento válidas (el recuadro nunca selecciona secciones/capas).
export function setCanvasMultiSelection(paths: string[]) {
  const valid = paths.filter((p) => isElementPath(p))
  state.selectedPaths = valid.length > 1 ? valid : []
  state.selectedPath = valid.length ? valid[valid.length - 1] : null
}

// Ctrl/Cmd+click on a CAPAS tree node (TASK #94). Toggles ANY node kind
// (section / layer / element) into the multi-set, seeding it with the current
// single selection so the FIRST modified click promotes "1 selected" → "2
// selected". `selectedPath` follows the most-recently-touched node so
// PROPIEDADES / single-select surfaces still show something sensible. Mirrors
// toggleCanvasSelection but is kind-agnostic (the canvas stays element-only
// via multiSelectedElementPaths / hasMultiSelection).
export function toggleTreeSelection(path: string) {
  if (!isTreeNodePath(path)) return
  const set = state.selectedPaths.length
    ? [...state.selectedPaths]
    : isTreeNodePath(state.selectedPath)
      ? [state.selectedPath as string]
      : []
  const i = set.indexOf(path)
  if (i >= 0) {
    set.splice(i, 1)
    state.selectedPaths = set
    state.selectedPath = set.length ? set[set.length - 1] : null
  } else {
    set.push(path)
    state.selectedPaths = set
    state.selectedPath = path
  }
}

// Plain (non-modifier) tree click: single select, multi-set collapses to it.
// Used by LayersPanel for a normal row click so it matches current behavior.
export function setTreeSelection(path: string | null) {
  state.selectedPath = path
  state.selectedPaths = isTreeNodePath(path) ? [path as string] : []
}

// Keep `selectedPaths` consistent whenever `selectedPath` changes by ANY other
// route (paste, addElement, delete, undo, global select, single tree click…).
// If the new primary is already part of the multi-set, the set is preserved
// (a tree Ctrl/Cmd+click moves the primary WITHIN the set). Otherwise the set
// collapses to the new primary (or empties). This writes ONLY selectedPaths
// (never selectedPath) so it cannot loop, and makes every legacy single-select
// call site automatically exit multi mode without touching any of them.
watch(
  () => state.selectedPath,
  (p) => {
    if (state.selectedPaths.length === 0) return
    if (p && state.selectedPaths.includes(p)) return
    state.selectedPaths = isTreeNodePath(p) ? [p as string] : []
  },
)

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

// ─── Inline id rename (Finder-style, TASK #77) ─────────────────────────────
//
// Rename the `id` of ANY tree node (section / layer / element). Sections and
// layers may not have an id yet — this allows SETTING one. The new id is
// sanitized to a valid kebab-ish id (no spaces/accents, lowercase), collisions
// with ANY existing id anywhere in the site are auto-suffixed (-2, -3, …), and
// any animations[].dependsOn referencing the OLD id is best-effort updated so
// cross-element "depends" triggers don't break. Pushes undo + marks dirty
// (setAtPath-style: one pushUndo for the whole rename). Returns the FINAL id
// applied (may differ from requested due to sanitize/collision) or null.

// Strip accents, lowercase, spaces/invalid → '-', collapse repeats, trim '-'.
export function sanitizeId(raw: string): string {
  const noAccents = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
  return noAccents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Every id currently used by any section/layer/element across BOTH the legacy
// tree and (if present) every independent view — the full collision space.
function collectAllIds(): Set<string> {
  const ids = new Set<string>()
  const site = state.site as any
  if (!site) return ids
  const roots: any[] = []
  if (site.views) {
    if (site.views.desktop?.sections) roots.push(site.views.desktop.sections)
    if (site.views.mobile?.sections) roots.push(site.views.mobile.sections)
  }
  if (Array.isArray(site.sections)) roots.push(site.sections)
  for (const sections of roots) {
    for (const sec of sections || []) {
      if (sec?.id) ids.add(sec.id)
      for (const layer of sec?.layers || []) {
        if (layer?.id) ids.add(layer.id)
        for (const el of layer?.elements || []) {
          if (el?.id) ids.add(el.id)
        }
      }
    }
  }
  return ids
}

// Walk every element in the site and rewrite animations[].dependsOn that
// pointed at `oldId` → `newId` (cross-element "depends" trigger). Best-effort:
// runs over all views so a cross-view reference is fixed too.
function remapDependsOn(oldId: string, newId: string) {
  const site = state.site as any
  if (!site || !oldId) return
  const roots: any[] = []
  if (site.views) {
    if (site.views.desktop?.sections) roots.push(site.views.desktop.sections)
    if (site.views.mobile?.sections) roots.push(site.views.mobile.sections)
  }
  if (Array.isArray(site.sections)) roots.push(site.sections)
  for (const sections of roots) {
    for (const sec of sections || []) {
      for (const layer of sec?.layers || []) {
        for (const el of layer?.elements || []) {
          if (Array.isArray(el?.animations)) {
            for (const anim of el.animations) {
              if (anim && anim.dependsOn === oldId) anim.dependsOn = newId
            }
          }
        }
      }
    }
  }
}

export interface RenameResult {
  ok: boolean
  id?: string
  // Spanish hint when the requested id was changed (sanitized or de-collided)
  // or rejected (empty), so the UI can surface why.
  hint?: string
}

export function renameNodeId(path: string, requested: string): RenameResult {
  if (!state.site || !path || isGlobalPath(path)) {
    return { ok: false, hint: 'No se puede renombrar.' }
  }
  const node = getAtPath(path)
  if (!node || typeof node !== 'object') {
    return { ok: false, hint: 'No se encontró el nodo.' }
  }
  const oldId: string | undefined = node.id
  let next = sanitizeId(requested)
  if (!next) {
    return { ok: false, hint: 'El nombre no puede quedar vacío.' }
  }
  if (next === oldId) {
    return { ok: true, id: oldId }
  }
  // Collision with ANY existing id (excluding this node's own current id) →
  // auto-suffix -2, -3, … until free.
  const taken = collectAllIds()
  if (oldId) taken.delete(oldId)
  let final = next
  let collided = false
  if (taken.has(final)) {
    collided = true
    let n = 2
    while (taken.has(`${next}-${n}`)) n++
    final = `${next}-${n}`
  }
  pushUndo()
  node.id = final
  // Best-effort: keep cross-element "depends" triggers pointing at this node.
  if (oldId) remapDependsOn(oldId, final)
  // If this node's id is in the editor-local lock set, move the lock to the
  // new id so the lock survives the rename.
  if (oldId) {
    const li = state.lockedIds.indexOf(oldId)
    if (li >= 0) state.lockedIds.splice(li, 1, final)
    syncLocksToSite()
  }
  let hint: string | undefined
  if (collided) {
    hint = `Ese id ya existe; se renombró a "${final}".`
  } else if (final !== requested.trim()) {
    hint = `Renombrado a "${final}".`
  }
  return { ok: true, id: final, hint }
}

// Delete the selected element
export function deleteSelected() {
  if (!state.selectedPath || !state.site) return
  if (isGlobalPath(state.selectedPath)) return // meta/theme aren't deletable
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
  if (isGlobalPath(state.selectedPath)) return // nothing to duplicate
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

// ─── Copy/paste id derivation (#123) ────────────────────────────────────────
//
// On paste the TOP-LEVEL node's new id is derived from the SOURCE id so the
// base stays recognizable in CAPAS:
//   "seccion-hero"           → "seccion-hero-copy-a3f9"
// Pasting a node that is ALREADY a copy must NOT stack endlessly — the trailing
// "-copy-xxxx" is stripped first, then a fresh one appended:
//   "seccion-hero-copy-a3f9" → "seccion-hero-copy-9b2c"
// Uniqueness within the document is guaranteed against `taken` (collectAllIds()
// plus ids minted earlier in the same multi-paste); on the rare suffix
// collision we re-roll. If there's no usable source id we fall back to uid().
const COPY_SUFFIX_RE = /-copy-[a-z0-9]{4}$/
function copySuffix(): string {
  // 4 lowercase-alphanumeric chars (base36 of a random number, padded).
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}
function deriveCopyId(sourceId: string | undefined, taken: Set<string>): string {
  if (!sourceId) {
    // No recognizable base → keep the old random-id behavior, still unique.
    let id = uid('el')
    while (taken.has(id)) id = uid('el')
    return id
  }
  // Strip an existing "-copy-xxxx" so copies of copies don't grow unbounded.
  const base = sourceId.replace(COPY_SUFFIX_RE, '')
  let id = `${base}-copy-${copySuffix()}`
  while (taken.has(id)) id = `${base}-copy-${copySuffix()}`
  return id
}

// Deep-clone a node and regenerate EVERY id (section/layer/element) so a paste
// can never collide with an existing node — even across views. The TOP-LEVEL
// node's id is DERIVED from `sourceId` (#123: "<source>-copy-<rand>"); nested
// layer/element ids stay freshly-minted random ids. `taken` accumulates every
// id already present plus those minted earlier in the same multi-paste so the
// whole operation stays collision-free.
function regenerateIds(
  node: any,
  kind: ClipboardKind,
  sourceId?: string,
  taken: Set<string> = collectAllIds(),
): any {
  const copy = JSON.parse(JSON.stringify(node))
  // Top-level id derived from the source (recognizable base + -copy- suffix).
  copy.id = deriveCopyId(sourceId, taken)
  taken.add(copy.id)
  // Nested ids: fresh random uids, deduped against `taken`.
  const mint = (prefix: string) => {
    let id = uid(prefix)
    while (taken.has(id)) id = uid(prefix)
    taken.add(id)
    return id
  }
  if (kind === 'section') {
    for (const layer of copy.layers || []) {
      layer.id = mint('layer')
      for (const el of layer.elements || []) el.id = mint(el.type || 'el')
    }
  } else if (kind === 'layer') {
    for (const el of copy.elements || []) el.id = mint(el.type || 'el')
  }
  return copy
}

function flashPasteHint(msg: string) {
  state.pasteHint = msg
  setTimeout(() => {
    if (state.pasteHint === msg) state.pasteHint = null
  }, 2600)
}

// Document (tree) order comparator for two tree-node paths. Compares each
// numeric segment so "sections.0.layers.1.elements.2" sorts before
// "sections.0.layers.1.elements.10". So a multi-paste reproduces nodes in the
// same top-to-bottom order they appear in CAPAS, regardless of click order.
function compareTreePaths(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i])
    const nb = Number(pb[i])
    const an = Number.isFinite(na)
    const bn = Number.isFinite(nb)
    if (an && bn) { if (na !== nb) return na - nb; continue }
    if ((pa[i] ?? '') !== (pb[i] ?? '')) return (pa[i] ?? '') < (pb[i] ?? '') ? -1 : 1
  }
  return 0
}

// The set of tree-node paths to snapshot: the multi-selection when 2+ are
// selected, otherwise the single primary selection. Sorted in document order
// so a multi-paste preserves top-to-bottom tree order (task #107).
function clipboardSourcePaths(): string[] {
  const raw = state.selectedPaths.length
    ? state.selectedPaths.filter(isTreeNodePath)
    : isTreeNodePath(state.selectedPath)
      ? [state.selectedPath as string]
      : []
  return [...new Set(raw)].sort(compareTreePaths)
}

// Snapshot the current selection (one OR many nodes) into the clipboard.
function clip(op: 'copy' | 'cut') {
  const paths = clipboardSourcePaths()
  if (!paths.length) return
  const items: ClipboardItem[] = []
  for (const p of paths) {
    const kind = kindForPath(p)
    if (!kind) continue
    const data = getAtPath(p)
    if (!data) continue
    items.push({ kind, data: JSON.parse(JSON.stringify(data)), sourceId: data.id })
  }
  if (!items.length) return
  // items[0] mirrors the legacy single-node fields so clipboardLabel and any
  // existing single-select surface keep reading the same shape.
  state.clipboard = {
    kind: items[0].kind,
    op,
    data: items[0].data,
    sourceId: items[0].sourceId,
    items,
  }
  const verb = op === 'cut' ? 'Cortado' : 'Copiado'
  if (items.length > 1) flashPasteHint(`${verb} — pega donde quieras (Cmd+V)`)
  else flashPasteHint(`${verb} — pega donde quieras (Cmd+V)`)
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

// A resolved paste destination for one clipboard KIND: the array to splice
// into, the index of the FIRST insert, and a path builder. `targetArr` mutates
// in place (it's a live reference into state.site), so a sequential multi-paste
// of the same kind just keeps incrementing the running insert index.
type PasteTarget = { targetArr: any[]; insertAt: number; pathFor: (idx: number) => string }

// Resolve where a node of `kind` should be pasted, given the current single
// selection (selKind/selParts). Returns null when no sensible target exists for
// that kind (caller skips the item with a subtle hint). This is the SAME rule
// set the single paste always used — extracted so multi-paste reuses it
// verbatim (section→active view, layer→section, element→layer).
function resolvePasteTarget(
  kind: ClipboardKind,
  selKind: ClipboardKind | null,
  selParts: string[],
): PasteTarget | null {
  if (kind === 'section') {
    const sections = activeSections()
    const insertAt = selKind ? Number(selParts[1]) + 1 : sections.length
    return { targetArr: sections, insertAt, pathFor: (idx) => `sections.${idx}` }
  }
  if (kind === 'layer') {
    let si: number | null = null
    let at: number | null = null
    if (selKind === 'section') si = Number(selParts[1])
    else if (selKind === 'layer') { si = Number(selParts[1]); at = Number(selParts[3]) + 1 }
    else if (selKind === 'element') { si = Number(selParts[1]); at = Number(selParts[3]) + 1 }
    else {
      if (activeSections().length === 0) return null
      si = 0
    }
    const section = getAtPath(`sections.${si}`) as any
    if (!section || !Array.isArray(section.layers)) return null
    return {
      targetArr: section.layers,
      insertAt: at == null ? section.layers.length : at,
      pathFor: (idx) => `sections.${si}.layers.${idx}`,
    }
  }
  // element
  let si: number | null = null
  let li: number | null = null
  let at: number | null = null
  if (selKind === 'layer') { si = Number(selParts[1]); li = Number(selParts[3]) }
  else if (selKind === 'element') { si = Number(selParts[1]); li = Number(selParts[3]); at = Number(selParts[5]) + 1 }
  else if (selKind === 'section') {
    si = Number(selParts[1])
    const section = getAtPath(`sections.${si}`) as any
    if (!section || !Array.isArray(section.layers) || section.layers.length === 0) return null
    li = 0
  } else {
    return null
  }
  const layer = getAtPath(`sections.${si}.layers.${li}`) as any
  if (!layer || !Array.isArray(layer.elements)) return null
  return {
    targetArr: layer.elements,
    insertAt: at == null ? layer.elements.length : at,
    pathFor: (idx) => `sections.${si}.layers.${li}.elements.${idx}`,
  }
}

/**
 * Paste the clipboard relative to the current selection (active view).
 *
 * Targets (per item KIND — same rules for single and multi paste):
 *  - Section  → appended after the selected section (or at the end of the
 *               active view's sections).
 *  - Layer    → into the selected section (or the selected layer's section),
 *               after the selected layer when one is selected.
 *  - Element  → into the selected layer (or the selected element's layer),
 *               after the selected element when one is selected.
 *
 * Multi-paste (task #107): every snapshotted item is pasted. Same-kind items go
 * sequentially into the resolved target (preserving copy/tree order). Mixed
 * kinds each route to their own sensible target; items whose kind has no
 * sensible target for the current selection are skipped (subtle hint). A cut
 * removes ALL originals. ONE undo for the whole operation; the pasted nodes
 * become the new selection. A single-item clipboard behaves EXACTLY as before.
 */
export function pasteClipboard() {
  if (!state.site || !state.clipboard) {
    if (!state.clipboard) flashPasteHint('Nada en el portapapeles')
    return
  }
  const cb = state.clipboard
  // Back-compat: a clipboard written by older code (no items[]) → wrap the
  // legacy single-node fields into a 1-item list.
  const items: ClipboardItem[] =
    cb.items && cb.items.length
      ? cb.items
      : [{ kind: cb.kind, data: cb.data, sourceId: cb.sourceId }]

  const sel = state.selectedPath
  const selParts = sel ? sel.split('.') : []
  const selKind = sel ? kindForPath(sel) : null

  // ── Resolve a target per KIND FIRST (no mutation yet) so a no-op leaves
  // undo/redo untouched. The running insertAt advances as we paste, keeping
  // multiple same-kind items in order; a cached live array reference means the
  // sequential splices land contiguously. ──
  const targets = new Map<ClipboardKind, PasteTarget>()
  const pasteable: ClipboardItem[] = []
  let skipped = 0
  for (const it of items) {
    let tgt = targets.get(it.kind)
    if (!tgt) {
      const resolved = resolvePasteTarget(it.kind, selKind, selParts)
      if (!resolved) { skipped++; continue }
      targets.set(it.kind, resolved)
      tgt = resolved
    }
    pasteable.push(it)
  }

  if (!pasteable.length) {
    // Nothing routed → mirror the single-paste hints (kind-specific guidance).
    if (items.some((i) => i.kind === 'layer')) flashPasteHint('Crea una sección primero')
    else if (items.some((i) => i.kind === 'element')) flashPasteHint('Selecciona una capa para pegar el elemento')
    else flashPasteHint('No hay destino para pegar')
    return
  }

  // Target(s) valid → commit (single undo for the whole multi-paste).
  pushUndo()
  const freshIds: { id: string; kind: ClipboardKind }[] = []
  const cutOriginals: { sourceId: string; kind: ClipboardKind }[] = []
  // #123: derive each pasted node's id from its SOURCE id ("<src>-copy-xxxx").
  // Share ONE `taken` set across the whole multi-paste so every minted id —
  // top-level copy ids AND nested layer/element ids — stays unique within the
  // document, even when several items derive from the same base.
  const taken = collectAllIds()
  for (const it of pasteable) {
    const tgt = targets.get(it.kind)!
    // Derive the copy base from the snapshot's OWN id (it.data.id), not from
    // it.sourceId: sourceId is cleared once a 'cut' is consumed, but the
    // snapshot id is always present, so copies-of-a-cut still get a
    // recognizable "<base>-copy-xxxx" name on every paste.
    const fresh = regenerateIds(it.data, it.kind, it.data?.id, taken)
    tgt.targetArr.splice(tgt.insertAt, 0, fresh)
    tgt.insertAt++ // next same-kind item lands right after this one
    freshIds.push({ id: fresh.id, kind: it.kind })
    if (cb.op === 'cut' && it.sourceId && it.sourceId !== fresh.id) {
      cutOriginals.push({ sourceId: it.sourceId, kind: it.kind })
    }
  }

  // A cut consumes ALL originals on the first paste (find by id so it works even
  // after a view switch). Do this AFTER pasting so target indices stay valid;
  // subsequent pastes behave like copy.
  if (cutOriginals.length) {
    for (const o of cutOriginals) {
      const loc = findNodeLocationById(o.sourceId, o.kind)
      if (loc) loc.arr.splice(loc.index, 1)
    }
    state.clipboard = {
      ...cb,
      op: 'copy',
      sourceId: undefined,
      items: cb.items.map((i) => ({ ...i, sourceId: undefined })),
    }
  }

  // Select the freshly-pasted nodes (re-derive paths from ids in the ACTIVE
  // view so a cut's source-removal can't leave stale indices). Primary =
  // last pasted, mirroring the single-paste behavior.
  const newPaths = freshIds
    .map((f) => pathOfNodeInActiveView(f.id, f.kind))
    .filter((p): p is string => !!p)
  if (newPaths.length) {
    state.selectedPaths = newPaths.length > 1 ? newPaths : []
    state.selectedPath = newPaths[newPaths.length - 1]
  }

  if (skipped > 0) flashPasteHint(`Pegado (${freshIds.length}) — ${skipped} no aplica${skipped > 1 ? 'n' : ''} aquí`)
  else flashPasteHint(freshIds.length > 1 ? `Pegado: ${freshIds.length}` : 'Pegado')
}

// Artboard sizes for the preview. Mobile is a modern standard phone
// (iPhone 12/13/14/15 ≈ 390×844) rather than the old iPhone SE (375×667): the
// short 667px height crowded `vh`-based sections so elements overlapped in the
// editor while looking fine on a real (taller) phone. 390×844 matches what most
// visitors actually see and tracks Chrome's mobile emulation closely.
//
// MOBILE is now CONFIGURABLE (#90) and persisted (see prefs). Desktop stays
// fixed at 1440×900. To keep every consumer (`VIEWPORTS[state.deviceMode]` in
// EditorCanvas computeds, useCanvas, etc.) reactive WITHOUT changing how they
// read it, the mobile dimensions live in a `reactive` object exposed through a
// getter: reads inside a computed/watch re-track its `.width`/`.height`, so
// changing the size live-resizes the artboard AND re-runs the vw/vh→px remap.

// Sane bounds for a hand-entered custom artboard size (phones up to 4K desktop).
const ARTBOARD_DIM_MIN = 200
const ARTBOARD_DIM_MAX = 3840
function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}
function clampDimension(n: number): number {
  return Math.max(ARTBOARD_DIM_MIN, Math.min(ARTBOARD_DIM_MAX, Math.round(n)))
}

// BOTH artboards are reactive + persisted so changing the size live-resizes the
// preview AND re-runs the vw/vh→px remap. Exposed through getters so every
// consumer keeps reading `VIEWPORTS[state.deviceMode]` unchanged.
const mobileViewport = reactive({ width: 390, height: 844 })
const desktopViewport = reactive({ width: 1440, height: 900 })

export const VIEWPORTS = {
  get desktop() {
    return desktopViewport
  },
  get mobile() {
    return mobileViewport
  },
}

// Device presets surfaced in the toolbar size dropdown (#90). CSS-viewport
// sizes, portrait for phones/tablets. Values are 2026-current.
export interface MobilePreset {
  id: string
  label: string
  width: number
  height: number
}
export const MOBILE_PRESETS: MobilePreset[] = [
  { id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', width: 440, height: 956 },
  { id: 'iphone-16-plus', label: 'iPhone 16 Plus', width: 430, height: 932 },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874 },
  { id: 'iphone-16', label: 'iPhone 16 / 15', width: 393, height: 852 },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'galaxy-s24-ultra', label: 'Galaxy S24 Ultra', width: 384, height: 824 },
  { id: 'galaxy-s25', label: 'Galaxy S25', width: 360, height: 800 },
  { id: 'galaxy-a', label: 'Galaxy A', width: 412, height: 915 },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915 },
]
export const DESKTOP_PRESETS: MobilePreset[] = [
  { id: 'pc-fhd', label: 'PC Full HD', width: 1920, height: 1080 },
  { id: 'pc-hd', label: 'PC HD', width: 1366, height: 768 },
  { id: 'pc-qhd', label: 'PC 2K', width: 2560, height: 1440 },
  { id: 'mac-air', label: 'MacBook Air', width: 1470, height: 956 },
  { id: 'mac-pro-14', label: 'MacBook Pro 14"', width: 1512, height: 982 },
  { id: 'imac', label: 'iMac / Mac', width: 1440, height: 900 },
  { id: 'ipad-pro-13', label: 'iPad Pro 13"', width: 1032, height: 1376 },
  { id: 'ipad-pro-11', label: 'iPad Pro 11"', width: 834, height: 1194 },
  { id: 'ipad', label: 'iPad / iPad Air', width: 820, height: 1180 },
]

// Update an artboard size reactively + persist it. Dimensions are clamped.
export function setMobileViewport(width: number, height: number) {
  if (!isFinitePositive(width) || !isFinitePositive(height)) return
  mobileViewport.width = clampDimension(width)
  mobileViewport.height = clampDimension(height)
  persistPrefs()
}
export function setDesktopViewport(width: number, height: number) {
  if (!isFinitePositive(width) || !isFinitePositive(height)) return
  desktopViewport.width = clampDimension(width)
  desktopViewport.height = clampDimension(height)
  persistPrefs()
}

// ─── Zoom limits ───────────────────────────────────────────────────────────────

export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 3

export function setZoom(z: number) {
  state.canvasZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100))
}

// Manual zoom (cmd/ctrl+wheel, zoom tool, zoom +/- buttons, cmd+0) while
// "Vista completa" is ON must NOT exit overview: the user is intentionally
// zooming in to inspect the giant sheet, and "Vista completa" only turns OFF
// when she explicitly unchecks the toggle (disableOverview, which restores the
// pre-overview snapshot). So this is now a deliberate NO-OP — overview stays
// ON, the checkbox stays checked, the persisted pref stays ON, and crucially we
// do NOT re-fit/snap-back here (the manual zoom is applied freely by the
// caller). Kept as a function so every existing zoom call site stays a
// one-liner; the (overview-OFF) early-return was already a no-op, so behaviour
// with overview OFF is byte-for-byte unchanged.
//
// The overview fit still runs through the proper paths: enableOverview (toggle
// ON), refitOverview (device/view/content change) and the persisted-pref
// restore on project open — none of which go through here.
// (There used to be an exitOverviewKeepingZoom() called from every zoom site;
// it was removed — the zoom call sites just zoom now.)

// zoom +/- buttons & cmd+/-: just change the zoom. If "Vista completa" is ON
// it STAYS ON (the user is inspecting the giant sheet); it only turns OFF when
// she unchecks the toggle.
export function zoomIn() {
  setZoom(state.canvasZoom + 0.1)
}

export function zoomOut() {
  setZoom(state.canvasZoom - 0.1)
}

// ─── Zoom tool: zoom IN/OUT around a cursor point (GAP9) ────────────────────
//
// The Zoom tool (Z) zooms toward where you click (alt/option+click zooms out),
// Illustrator-style. The artboard is a `transform: scale(zoom)` box
// (transform-origin: top-left) sitting at `canvasPan` inside the canvas, so the
// on-screen position of an artboard-local point `a` is
//   screen = canvasRectOrigin + canvasPan + a*zoom
// To keep the point under the cursor pinned while zoom changes z0→z1 we solve
//   a = (cursorOffset − pan0) / z0   then   pan1 = cursorOffset − a*z1
// `offsetX/offsetY` are the cursor position RELATIVE to the canvas element's
// top-left (clientX − canvasRect.left). Reuses setZoom (clamping/rounding). If
// "Vista completa" is ON it STAYS ON — zooming the giant sheet around the
// cursor does NOT exit overview (only unchecking the toggle does).
export function zoomAroundPoint(offsetX: number, offsetY: number, zoomIn: boolean) {
  const z0 = state.canvasZoom
  const factor = zoomIn ? 1.25 : 0.8
  // Round-trip through setZoom so the same clamp/round rules apply; read back
  // the actual applied zoom for an exact pan compensation.
  setZoom(z0 * factor)
  const z1 = state.canvasZoom
  if (z1 === z0) return // already at a zoom limit → don't drift the pan
  const ax = (offsetX - state.canvasPan.x) / z0
  const ay = (offsetY - state.canvasPan.y) / z0
  state.canvasPan = {
    x: Math.round(offsetX - ax * z1),
    y: Math.round(offsetY - ay * z1),
  }
}

// Fit the artboard inside the visible canvas viewport (cmd+0). Does NOT exit
// "Vista completa": if it's ON it stays ON (only unchecking the toggle exits).
export function zoomToFit(canvasW: number, canvasH: number) {
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

// Initial framing when a project opens: the artboard must NOT be jammed in the
// top-left corner. Center it HORIZONTALLY with a small TOP margin (gallery-like
// framing — top of the composition visible, room to scroll down through it),
// at the default zoom, in NORMAL mode. zoomToFit/cmd+0 (full centering) and the
// overview fit are untouched — this only replaces the (0,0) cold-start.
export function centerArtboardOnLoad(canvasW: number, canvasH: number) {
  if (state.overviewMode) return
  const vp = VIEWPORTS[state.deviceMode]
  if (!canvasW || !canvasH) {
    // No measurements yet: keep the default zoom, leave pan at origin (the
    // canvas re-invokes this once it has a real size).
    return
  }
  const TOP_MARGIN = 32
  // Pick a zoom that comfortably fits the artboard WIDTH with side breathing
  // room, capped at the default 0.5 (don't zoom a small canvas in past the
  // editor's normal default), and never below ZOOM_MIN.
  const widthFit = (canvasW - 96) / vp.width
  setZoom(Math.max(ZOOM_MIN, Math.min(0.5, widthFit)))
  const scaledW = vp.width * state.canvasZoom
  state.canvasPan = {
    x: Math.round((canvasW - scaledW) / 2),
    y: TOP_MARGIN,
  }
}

// ─── "Vista completa" (overview / hoja gigante) ────────────────────────────────
//
// Default OFF → today's behavior is byte-for-byte unchanged (device-proportion
// artboard + per-section vertical scroll). ON → the WHOLE composition (every
// section stacked, full total height) is scaled to fit the visible canvas at
// once so the user can eyeball the whole sheet, no per-screen scrolling.
//
// Implementation: the canvas already renders a scaled `.preview-frame`
// (vp.width × vp.height) that clips its tall content to a native inner
// scroller. Overview = grow that frame to the FULL stacked height and zoom it
// so the whole thing fits — i.e. exactly "zoom to fit the entire frame", reusing
// the canvas sizing/zoom machinery instead of a parallel renderer. The inner
// scroll is neutralized while active (everything is visible, nothing to scroll).

// Sum of the active view's section heights, resolved to PX against the device
// viewport height the editor uses for the artboard (desktop 900 / mobile 844).
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
  persistPrefs()
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
  persistPrefs()
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
// name: "FormBlock"). Default props give the user a working RSVP form she
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
      // Defaults reference the SITE THEME tokens (parallax-engine
      // ParallaxSite exposes --color-paper/ink/accent + --font-body) so a
      // freshly-added form adopts the project's palette instead of a fixed
      // café look. The CTA uses the ACCENT colour (not the dark ink, which
      // read as an out-of-place brown block) with paper text for contrast;
      // inputs are paper on an ink-tinted hairline border. Every value is a
      // theme-driven CSS token, all editable via the FormColorField swatches.
      // Existing forms in content are NOT touched — this only seeds NEW forms.
      styling: {
        inputBg: 'var(--color-paper)',
        inputBorder: 'var(--color-ink)',
        buttonBg: 'var(--color-accent)',
        buttonText: 'var(--color-paper)',
        fontFamily: 'var(--font-body)',
      },
    },
    animations: [
      { type: 'fadeIn', trigger: 'enter', from: 0, to: 1, duration: 800, easing: 'easeOut' },
    ],
  } as AnyElement
}

// Derive a default value for a single editableProp. Honors an explicit
// `default`; else a sensible empty per type so a freshly-added component is
// valid and renderable (array → [], number → 0, boolean → false, etc.).
function defaultForProp(schema: EditablePropSchema): unknown {
  if (schema.default !== undefined) {
    // Clone so two instances never share a reference (arrays/objects).
    return JSON.parse(JSON.stringify(schema.default))
  }
  switch (schema.type) {
    case 'number': return 0
    case 'boolean': return false
    case 'array': return []
    case 'select': return schema.options?.[0] ?? ''
    default: return '' // string | color | image
  }
}

// Build the props object for a NEW custom-component element from its
// registered editableProps schema (defaults only — the user edits in
// PROPIEDADES afterwards).
function defaultPropsFor(reg: ComponentRegistration): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(reg.editableProps || {})) {
    props[key] = defaultForProp(schema)
  }
  return props
}

// A new custom-component element (type:"component", name:<registered name>).
// Same common-element shape as the other kinds so the canvas overlay /
// properties / drag machinery all work unchanged.
function newCustomComponentElement(reg: ComponentRegistration): AnyElement {
  return {
    type: 'component',
    id: uid(reg.name.toLowerCase()),
    name: reg.name,
    position: { x: 50, y: 50 },
    anchor: 'center',
    opacity: 1,
    rotation: 0,
    visible: true,
    interactive: true,
    props: defaultPropsFor(reg),
    animations: [
      { type: 'fadeIn', trigger: 'enter', from: 0, to: 1, duration: 800, easing: 'easeOut' },
    ],
  } as AnyElement
}

/**
 * Add a registered custom component (by name) into the resolved layer, same
 * pattern as addElement: valid node, auto id, undo, selected, dirty. No-op if
 * the name isn't in the active registry (defensive).
 */
export function addCustomComponent(layerPath: string, name: string) {
  if (!state.site) return
  const reg = getComponentRegistration(name)
  if (!reg) return
  const layer = getAtPath(layerPath)
  if (!layer || !Array.isArray(layer.elements)) return
  pushUndo()
  layer.elements.push(newCustomComponentElement(reg))
  state.selectedPath = `${layerPath}.elements.${layer.elements.length - 1}`
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

/**
 * Capa destino al ARRASTRAR un recurso a la mesa (#154). Prioridad:
 *   1) selección explícita (capa, o la capa del elemento seleccionado),
 *   2) la sección donde se SOLTÓ (`sectionId`) → su última capa,
 *   3) la sección seleccionada → su última capa,
 *   4) la ÚLTIMA capa de la ÚLTIMA sección.
 * Crea capa/sección si hicieran falta. Rutas view-relativas (las rebasa
 * getAtPath/setAtPath), igual que resolveAddElementLayerPath.
 */
function resolveDropLayerPath(sectionId?: string): string | null {
  if (!state.site) return null
  const sel = getSelected()
  if (sel) {
    if (sel.type === 'element') return state.selectedPath!.split('.').slice(0, -2).join('.')
    if (sel.type === 'layer') return state.selectedPath!
  }
  const sections = activeSections()
  if (sectionId) {
    const si = sections.findIndex((s) => s.id === sectionId)
    if (si >= 0) {
      const section = sections[si]
      if (!section.layers || section.layers.length === 0) {
        addLayer(`sections.${si}`)
        return `sections.${si}.layers.0`
      }
      return `sections.${si}.layers.${section.layers.length - 1}`
    }
  }
  if (sel && sel.type === 'section') {
    const section = sel.data
    if (!Array.isArray(section.layers) || section.layers.length === 0) {
      addLayer(state.selectedPath!)
      return state.selectedPath
    }
    return `${state.selectedPath}.layers.${section.layers.length - 1}`
  }
  if (sections.length === 0) {
    addSection()
    return 'sections.0.layers.0'
  }
  const li = sections.length - 1
  const last = sections[li]
  if (!last.layers || last.layers.length === 0) {
    addLayer(`sections.${li}`)
    return `sections.${li}.layers.0`
  }
  return `sections.${li}.layers.${last.layers.length - 1}`
}

/**
 * Crea un elemento a partir de un RECURSO arrastrado a la mesa (#154):
 * imagen → png · video → video · audio → audio, con el `src` del recurso. La
 * capa destino la decide resolveDropLayerPath; `pos` (% de la sección) ubica el
 * elemento donde se soltó (clamp 0–100), o al centro si no se da. Auto-id, undo,
 * queda seleccionado y marca dirty — mismo patrón que addElement.
 */
export function addElementFromResource(
  resourceKind: 'image' | 'video' | 'audio',
  src: string,
  opts: { sectionId?: string; pos?: { x: number; y: number } } = {},
): void {
  if (!state.site || !src) return
  const kind: ElementKind = resourceKind === 'image' ? 'png' : resourceKind
  const layerPath = resolveDropLayerPath(opts.sectionId)
  if (!layerPath) return
  const layer = getAtPath(layerPath)
  if (!layer || !Array.isArray(layer.elements)) return
  const factory = ELEMENT_FACTORIES[kind]
  if (!factory) return
  pushUndo()
  const el = factory() as AnyElement & { src?: string; position?: { x: number; y: number } }
  el.src = src
  if (opts.pos) {
    const clamp = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10
    el.position = { x: clamp(opts.pos.x), y: clamp(opts.pos.y) }
  }
  layer.elements.push(el as AnyElement)
  state.selectedPath = `${layerPath}.elements.${layer.elements.length - 1}`
  state.selectedPaths = []
}
