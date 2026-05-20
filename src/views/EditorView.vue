<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { projectsApi, gitApi } from '../composables/useApi'
import { useShortcuts } from '../composables/useShortcuts'
import { useWebSocket } from '../composables/useWebSocket'
import { usePanelResize } from '../composables/usePanelResize'
import { useLiveBroadcast } from '../composables/useLivePreview'
import { state, loadSite, isDirty, fetchComponentRegistry, selectedNodes } from '../stores/editor'
import { validateSite, assignIds } from 'parallax-engine/schema'
import { resolveSections } from 'parallax-engine'
import { buildCommitMessage } from '../composables/commitMessage'
import Toolbar from '../components/toolbar/Toolbar.vue'
import EditorCanvas from '../components/canvas/EditorCanvas.vue'
import LayersPanel from '../components/layers/LayersPanel.vue'
import PropertiesPanel from '../components/properties/PropertiesPanel.vue'
import ClaudePanel from '../components/claude/ClaudePanel.vue'
import GitPanel from '../components/git/GitPanel.vue'

const props = defineProps<{ type: string; slug: string }>()
const router = useRouter()
const loading = ref(true)
const bottomPanel = ref<'claude' | 'git' | null>(null)
// Imperative handle to the canvas so applyExternalChange can scroll the preview
// to the (restored) selected element after a Claude edit.
const canvasComp = ref<{ scrollToElement: (id: string) => void } | null>(null)

// Resizable panels (TASK #84). `sizes` are reactive px values bound to the
// panels' fixed flex main-axis size; the drag handles below drive them. The
// center canvas stays `flex:1 1 0` so it absorbs the remaining space — the
// 3-column flex contract is unchanged, only the panels' basis varies.
const { sizes, onHandlePointerDown, resetPanel } = usePanelResize()

// Mirror the current (possibly unsaved) doc to any open "Vista en vivo" tab.
// Pure in-memory broadcast — no save/commit, content repos untouched.
useLiveBroadcast()

async function loadProject() {
  loading.value = true
  const data = await projectsApi.get(props.type, props.slug)
  if (!data || data.error) {
    alert('Proyecto no encontrado')
    router.push('/')
    return
  }
  const result = validateSite(data)
  if (!result.ok) {
    state.errors = result.errors.map((e) => `${e.path}: ${e.message}`)
  }
  const site = result.ok ? assignIds(result.data) : assignIds(data as any)
  loadSite(site, props.type as any, props.slug)
  // Discover the project type's registered custom components (eventos → none;
  // site → NavButtons/HeroCTA/PortfolioCard/WorldNav/SocialLinks). Fire and
  // forget — resilient, never blocks the editor from opening.
  fetchComponentRegistry(props.type as any)
  loading.value = false
}

// A finished `claude -p` run (or a hand edit) wrote new content to disk. Merge
// it into the live doc FLUIDLY: patch state.site in place — NO loading screen,
// NO browser confirm, NO full reload, NO banner. Selection/zoom/undo/registry/
// locks are left intact so there's no "refresh" flash. The last-saved baseline
// (originalSite) is NOT touched, so isDirty flips true and "Guardar" lights up —
// Daniela sees the change in the canvas, reads Claude's reply in the chat, and
// saves only if she wants. Claude never auto-commits (#120). The watcher already
// suppresses the editor's OWN writes, so this only fires for external changes.
async function applyExternalChange() {
  const data = await projectsApi.get(props.type, props.slug)
  if (!data || data.error) return
  const result = validateSite(data)
  state.errors = result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`)
  const site = result.ok ? assignIds(result.data) : assignIds(data as any)
  // Preserve the user's working context across Claude's edit. Selection is
  // remembered by stable element ID, NOT by index path: Claude may have
  // restructured the tree (added/removed/reordered), which shifts paths but not
  // ids. After the new content paints we re-find those ids → restore the
  // selection AND scroll the preview so the selected element is in view. The
  // overview re-fit is suppressed (same guard a live drag uses) so zoom/pan
  // don't jump. selectedNodes is empty for the global @site/@theme/@resources
  // selections, so those are left untouched.
  const before = selectedNodes.value
  const keepIds = before.map((n) => n.id).filter((id) => id && id !== '(sin id)')
  const primaryId =
    (before.find((n) => n.path === state.selectedPath) || before[0])?.id || keepIds[0] || null

  state.site = site
  nextTick(() => {
    if (keepIds.length) {
      const newPaths = keepIds
        .map((id) => findElementPath(site, id))
        .filter((p): p is string => !!p)
      if (newPaths.length > 1) {
        state.selectedPaths = newPaths
        state.selectedPath = newPaths[newPaths.length - 1]
      } else if (newPaths.length === 1) {
        state.selectedPaths = []
        state.selectedPath = newPaths[0]
      }
      // No match (rare: element genuinely removed) → KEEP the prior selection
      // as-is. Never clear: a stale highlight is far less jarring than the whole
      // selection vanishing on every Claude reply.
    }
    // Bring the (primary) selected element back into view (no-op in overview,
    // where the whole sheet re-fits on the content change).
    if (primaryId) canvasComp.value?.scrollToElement(primaryId)
  })
}

// Locate an element/layer/section by its stable id, returning its index path in
// the store's "sections.N[.layers.M[.elements.K]]" form. Searches the active
// view first (what the preview renders), then falls back to every tree (root +
// both views) so a device/view mismatch can't drop the selection.
function findElementPath(site: any, id: string): string | null {
  const trees: any[][] = []
  try { trees.push(resolveSections(site, state.deviceMode) as any[]) } catch { /* no-op */ }
  if (Array.isArray(site?.sections)) trees.push(site.sections)
  if (Array.isArray(site?.views?.desktop?.sections)) trees.push(site.views.desktop.sections)
  if (Array.isArray(site?.views?.mobile?.sections)) trees.push(site.views.mobile.sections)
  for (const sections of trees) {
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si]
      if (sec?.id === id) return `sections.${si}`
      const layers = sec?.layers || []
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li]
        if (layer?.id === id) return `sections.${si}.layers.${li}`
        const els = layer?.elements || []
        for (let ei = 0; ei < els.length; ei++) {
          if (els[ei]?.id === id) return `sections.${si}.layers.${li}.elements.${ei}`
        }
      }
    }
  }
  return null
}

// In-flight guard: a manual Cmd+S, the Guardar button and the autosave timer
// all funnel through here; never run two PUTs at once.
let saving = false

async function save() {
  if (!state.site || !state.projectType || !state.slug) return
  if (saving) return
  saving = true
  const wasAutosave = state.autosave
  if (wasAutosave) state.autosaveStatus = 'saving'
  try {
    // Generate a short descriptive message by diffing the last-saved JSON
    // against the current site (GAP7 / PLAN §9) — no more static
    // `edit: <slug>`. Built BEFORE we overwrite originalSite. Same path for
    // manual Cmd+S, the Guardar button and autosave (all funnel here).
    const commitMsg = buildCommitMessage(state.slug, state.originalSite, state.site)
    await projectsApi.save(state.projectType, state.slug, state.site)
    await gitApi.commit(state.projectType, commitMsg)
    state.originalSite = JSON.stringify(state.site)
    // Let an open GitPanel refresh its log so history isn't stale (GAP7).
    state.gitLogNonce++
    if (wasAutosave) {
      state.autosaveStatus = 'saved'
      setTimeout(() => {
        // Only clear if nothing newer is in progress.
        if (state.autosaveStatus === 'saved') state.autosaveStatus = 'idle'
      }, 1500)
    }
  } finally {
    saving = false
  }
}

// ─── Autosave ──────────────────────────────────────────────────────────────
//
// When the "Autosave" pref is ON, debounce a save ~1.5s after the LAST change
// while the document is dirty. Reuses save() verbatim (same PUT + commit +
// originalSite reset) — no duplicated save logic. When OFF, behavior is
// unchanged (manual Guardar / Cmd+S only). The watch is on isDirty + autosave
// so flipping autosave ON with pending changes also schedules a save, and a
// save that clears isDirty naturally stops the loop.
const AUTOSAVE_DEBOUNCE_MS = 1500
let autosaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    if (state.autosave && isDirty.value && !saving) save()
  }, AUTOSAVE_DEBOUNCE_MS)
}

watch(
  // Re-trigger the debounce on EVERY edit (not just the dirty 0→1 edge), so a
  // burst of changes keeps pushing the save to 1.5s after the last one. The
  // site stringify is the same comparison isDirty uses.
  () => [state.autosave, isDirty.value, state.site && JSON.stringify(state.site)],
  () => {
    if (state.autosave && isDirty.value) scheduleAutosave()
  },
  { deep: false },
)

onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
})

// File watcher: an external change (a finished `claude -p` run from the chat,
// or a hand edit) wrote site.json. Merge it FLUIDLY — no confirm, no reload,
// no banner. The doc just updates in place and "Guardar" lights up; the chat
// reply is the only notification. The watcher suppresses the editor's OWN
// writes (#56), so this only fires for genuinely external changes.
useWebSocket((data) => {
  if (data.type !== 'file-changed' || !state.slug || !data.path?.includes(state.slug)) return
  applyExternalChange()
})

useShortcuts(save)

onMounted(loadProject)
</script>

<template>
  <div v-if="loading" class="loading-screen">Cargando...</div>
  <div v-else class="editor-layout">
    <Toolbar
      @save="save"
      @close="router.push('/')"
      @toggle-claude="bottomPanel = bottomPanel === 'claude' ? null : 'claude'"
      @toggle-git="bottomPanel = bottomPanel === 'git' ? null : 'git'"
    />
    <div class="editor-body">
      <LayersPanel
        class="panel-left"
        :style="{ flexBasis: sizes.capas.value + 'px', width: sizes.capas.value + 'px' }"
      />
      <!-- CAPAS resize handle: lives on the panel's RIGHT edge. Drag right →
           grows CAPAS (direction +1). Double-click resets to default. -->
      <div
        class="resize-handle resize-handle-x"
        data-test="resize-handle-capas"
        title="Arrastra para cambiar el ancho · doble clic para restablecer"
        @pointerdown="onHandlePointerDown($event, 'capas', 'x', 1)"
        @dblclick="resetPanel('capas')"
      ><span class="grip" /></div>
      <div class="canvas-area">
        <EditorCanvas ref="canvasComp" />
        <template v-if="bottomPanel">
          <!-- Claude dock resize handle: only present (and only active) when
               the Claude panel is open. Lives on the dock's TOP edge; drag up
               → grows the dock (axis y, direction -1). Not rendered for Git. -->
          <div
            v-if="bottomPanel === 'claude'"
            class="resize-handle resize-handle-y"
            data-test="resize-handle-claude"
            title="Arrastra para cambiar la altura · doble clic para restablecer"
            @pointerdown="onHandlePointerDown($event, 'claude', 'y', -1)"
            @dblclick="resetPanel('claude')"
          ><span class="grip" /></div>
          <div
            class="bottom-panel"
            :style="bottomPanel === 'claude' ? { height: sizes.claude.value + 'px' } : undefined"
          >
            <!-- Claude's post-reply reload must be FLUID (applyExternalChange):
                 a full loadProject() here was wiping the selection, preview
                 scroll and context every time a reply landed in the chat. -->
            <ClaudePanel v-if="bottomPanel === 'claude'" @reload="applyExternalChange" />
            <GitPanel v-if="bottomPanel === 'git'" @reload="loadProject" />
          </div>
        </template>
      </div>
      <!-- PROPIEDADES resize handle: lives on the panel's LEFT edge. Drag left
           → grows PROPIEDADES (direction -1). Double-click resets. -->
      <div
        class="resize-handle resize-handle-x"
        data-test="resize-handle-props"
        title="Arrastra para cambiar el ancho · doble clic para restablecer"
        @pointerdown="onHandlePointerDown($event, 'props', 'x', -1)"
        @dblclick="resetPanel('props')"
      ><span class="grip" /></div>
      <PropertiesPanel
        class="panel-right"
        :style="{ flexBasis: sizes.props.value + 'px', width: sizes.props.value + 'px' }"
      />
    </div>
  </div>
</template>

<style scoped>
.loading-screen { display: flex; align-items: center; justify-content: center; height: 100vh; color: #888; }
/* Root is a fixed-height column: 100dvh (falls back to vh) so the whole
   layout is height-bounded. min-height:0 lets the flex children actually
   shrink instead of growing to content. */
.editor-layout { display: flex; flex-direction: column; height: 100vh; height: 100dvh; min-height: 0; }
/* The body row must (a) be height-bounded and (b) stretch its children to
   that height so each panel gets a DEFINITE height to scroll within.
   align-items:stretch is the default but is stated explicitly because the
   panel's own internal scroll depends on this constraint propagating. */
.editor-body { display: flex; flex: 1 1 0; min-height: 0; overflow: hidden; align-items: stretch; }
/* Panels manage their own internal scroll (fixed header + scrollable body),
   so the outer container must NOT scroll — otherwise the header scrolls away
   and a double scrollbar appears. flex:0 0 <w> fixes the width on the main
   axis; align-self:stretch + min-height:0 + height:100% guarantees the panel
   root resolves to the body's height (so its .panel-body overflow triggers). */
.panel-left {
  flex: 0 0 240px; width: 240px; border-right: 1px solid #333;
  overflow: hidden; align-self: stretch; height: 100%; min-height: 0;
}
.panel-right {
  flex: 0 0 280px; width: 280px; border-left: 1px solid #333;
  overflow: hidden; align-self: stretch; height: 100%; min-height: 0;
}
.canvas-area { flex: 1 1 0; display: flex; flex-direction: column; position: relative; overflow: hidden; min-height: 0; min-width: 0; }
/* The bottom panel is a DEFINITE-height box. It must NOT scroll itself —
   the embedded panel (Claude/Git) manages its own internal scroll with a
   fixed header + fixed footer + scrollable middle. A scroll here would let
   the header/footer scroll away and create a double scrollbar (same class
   of bug fixed for CAPAS/PROPIEDADES). overflow:hidden + min-height:0 give
   the child a bounded height to scroll within. */
.bottom-panel { height: 240px; border-top: 1px solid #333; overflow: hidden; flex-shrink: 0; min-height: 0; display: flex; }
.bottom-panel > * { flex: 1 1 0; min-height: 0; }

/* ─── Resizable panel grab handles (TASK #84) ──────────────────────────────
   A thin (6px) hit strip between a panel and the canvas. It sits in normal
   flow as a flex sibling so the 3-column row's geometry is preserved (the
   panel keeps its own fixed basis; the canvas keeps flex:1). Subtle by
   default, an accent line appears on hover/drag so it's discoverable without
   competing with the panel content. The horizontal ones don't shrink so the
   row can't collapse them away; the vertical (Claude) one is flex:0 0 auto
   inside the canvas column. */
.resize-handle {
  position: relative;
  z-index: 5;
  flex: 0 0 6px;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none; /* let pointermove drive the drag, no scroll/zoom */
}
.resize-handle-x { width: 6px; cursor: col-resize; align-self: stretch; }
.resize-handle-y { height: 6px; width: 100%; cursor: row-resize; }
/* The visible grip: a faint center line that brightens on hover/active. */
.resize-handle .grip {
  position: absolute;
  background: #4a4a4a;
  border-radius: 2px;
  transition: background 0.12s ease;
}
.resize-handle-x .grip { width: 2px; height: 36px; }
.resize-handle-y .grip { height: 2px; width: 36px; }
.resize-handle:hover .grip,
.resize-handle:active .grip { background: var(--accent-strong); }
</style>
