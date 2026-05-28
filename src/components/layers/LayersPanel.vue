<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  state,
  moveNode,
  addSection,
  addLayer,
  addElement,
  activeSections,
  isIndependent,
  copySelected,
  cutSelected,
  pasteClipboard,
  selectGlobal,
  GLOBAL_SITE,
  GLOBAL_THEME,
  GLOBAL_RESOURCES,
  isCollapsed,
  setTreeSelection,
  toggleTreeSelection,
} from '../../stores/editor'
import { usePanelScroll } from '../../composables/usePanelScroll'
import LayerTreeItem from './LayerTreeItem.vue'
import AddElementMenu from './AddElementMenu.vue'

// Wheel scrolling fix: keep wheel events over this panel away from the
// engine's window-level Lenis listener (see usePanelScroll).
const { panelScrollRef } = usePanelScroll()

const showAddMenu = ref(false)

// The tree always reflects the ACTIVE view (compartido → shared tree;
// independiente → site.views[deviceMode]). Paths stay view-relative; the
// store rebases them to the active view's canonical root.
const sections = computed(() => activeSections())

// Singular/plural Spanish noun for a clipboard kind (count-aware).
function kindNoun(kind: 'section' | 'layer' | 'element', n: number): string {
  if (kind === 'section') return n === 1 ? 'sección' : 'secciones'
  if (kind === 'layer') return n === 1 ? 'capa' : 'capas'
  return n === 1 ? 'elemento' : 'elementos'
}

// Status text reflects HOW MANY nodes are on the clipboard (task #107). One
// node → "Copiado: Elemento" (capitalized, as before). Many of the same kind →
// "Copiado: 3 elementos". Mixed kinds → "Copiado: 3 nodos".
const clipboardLabel = computed(() => {
  const c = state.clipboard
  if (!c) return ''
  const verb = c.op === 'cut' ? 'Cortado' : 'Copiado'
  const items = c.items && c.items.length ? c.items : [{ kind: c.kind }]
  if (items.length === 1) {
    const k = items[0].kind
    const cap = k === 'section' ? 'Sección' : k === 'layer' ? 'Capa' : 'Elemento'
    return `${verb}: ${cap}`
  }
  const kinds = new Set(items.map((i) => i.kind))
  if (kinds.size === 1) {
    const k = items[0].kind
    return `${verb}: ${items.length} ${kindNoun(k, items.length)}`
  }
  return `${verb}: ${items.length} nodos`
})

// A row is highlighted if it's the primary OR part of the tree multi-set
// (TASK #94: ALL selected rows highlight, not just the primary).
function isRowSelected(path: string): boolean {
  return state.selectedPath === path || state.selectedPaths.includes(path)
}

// The primary (last-clicked) row, distinguished only when a multi-selection
// is active (2+ rows) so a normal single select looks exactly like before.
function isRowPrimary(path: string): boolean {
  return state.selectedPaths.length >= 2 && state.selectedPath === path
}

// Plain click → single select (clears the multi-set, current behavior).
// Ctrl/Cmd+click → toggle into the tree multi-selection.
function selectPath(path: string, additive: boolean) {
  if (additive) toggleTreeSelection(path)
  else setTreeSelection(path)
}

// Drag-reorder across parents: a node can be moved within its parent OR into
// another parent (element → other layer/section, layer → other section,
// section reorder). moveNode validates the level match, preserves the node
// (ids intact — it's a MOVE), follows the selection, pushes undo + marks dirty,
// and is view-aware (operates on the active view's tree).
function onMove(sourcePath: string, targetArrayPath: string, toIndex: number) {
  moveNode(sourcePath, targetArrayPath, toIndex)
}
</script>

<template>
  <div class="layers-panel">
    <div class="panel-header">
      <span>Capas</span>
      <div class="header-actions">
        <button
          v-if="state.site"
          class="add-btn add-btn-el"
          @click="showAddMenu = true"
          title="Agregar elemento"
          aria-label="Agregar elemento"
        >+ Elemento</button>
        <button
          v-if="state.site"
          class="add-btn"
          @click="addSection()"
          title="Agregar seccion"
          aria-label="Agregar seccion"
        >+ Seccion</button>
      </div>
    </div>

    <!-- Active-view banner: makes it unambiguous WHICH tree is being edited.
         Compartido = one shared tree. Independiente = this is the desktop OR
         mobile tree; the device toggle switches which one. -->
    <div
      v-if="state.site"
      class="view-banner"
      :class="isIndependent ? 'vb-indep' : 'vb-shared'"
      data-test="layers-active-view"
      :data-active-view="isIndependent ? state.deviceMode : 'shared'"
    >
      <template v-if="isIndependent">
        Editando: <strong>{{ state.deviceMode === 'mobile' ? 'Móvil' : 'Escritorio' }}</strong>
        <span class="vb-sub">configuración independiente</span>
      </template>
      <template v-else>
        Configuración <strong>compartida</strong>
        <span class="vb-sub">escritorio y móvil</span>
      </template>
    </div>

    <!-- Tree clipboard affordances (the user is non-technical: explicit buttons
         in addition to Cmd+C / Cmd+X / Cmd+V). Operate on the tree selection;
         paste targets the active view → enables cross-view copy/paste. -->
    <div v-if="state.site" class="clip-bar">
      <button
        class="clip-btn"
        data-test="layers-copy"
        :disabled="!state.selectedPath"
        title="Copiar selección (Cmd+C)"
        @click="copySelected()"
      >⧉ Copiar</button>
      <button
        class="clip-btn"
        data-test="layers-cut"
        :disabled="!state.selectedPath"
        title="Cortar selección (Cmd+X)"
        @click="cutSelected()"
      >✂ Cortar</button>
      <button
        class="clip-btn"
        data-test="layers-paste"
        :disabled="!state.clipboard"
        title="Pegar aquí / en la vista activa (Cmd+V)"
        @click="pasteClipboard()"
      >⎘ Pegar</button>
    </div>
    <div v-if="state.clipboard || state.pasteHint" class="clip-status" data-test="layers-clip-status">
      <span v-if="state.clipboard" class="clip-chip">{{ clipboardLabel }}</span>
      <span v-if="state.pasteHint" class="clip-hint">{{ state.pasteHint }}</span>
    </div>

    <AddElementMenu v-if="showAddMenu && state.site" @close="showAddMenu = false" />
    <div class="panel-body" :ref="panelScrollRef">
    <div class="layers-tree" v-if="state.site">
      <!-- Global (site-level) targets, ABOVE the sections. "Sitio" edits the
           shared meta (title/description/lang/og/favicon/fonts/transition);
           "Tema" edits the shared theme colors + typography. Both are
           view-agnostic (NOT per desktop/mobile) and selecting them clears
           any element selection / hides the canvas overlay. -->
      <div class="tree-global" data-test="tree-global-group">
        <div
          class="global-item"
          :class="{ selected: state.selectedPath === GLOBAL_SITE }"
          data-test="tree-site"
          @click="selectGlobal('site')"
          title="Propiedades generales del sitio"
        >
          <span class="item-icon">&#x1F310;</span>
          <span class="item-label">Sitio</span>
        </div>
        <div
          class="global-item"
          :class="{ selected: state.selectedPath === GLOBAL_THEME }"
          data-test="tree-theme"
          @click="selectGlobal('theme')"
          title="Tema global (colores y tipografía)"
        >
          <span class="item-icon">&#x1F3A8;</span>
          <span class="item-label">Tema</span>
        </div>
        <div
          class="global-item"
          :class="{ selected: state.selectedPath === GLOBAL_RESOURCES }"
          data-test="tree-resources"
          @click="selectGlobal('resources')"
          title="Recursos del proyecto (imágenes, fuentes, audio, video)"
        >
          <span class="item-icon">&#x1F4C1;</span>
          <span class="item-label">Recursos</span>
        </div>
      </div>

      <div v-for="(section, si) in sections" :key="section.id || si" class="tree-section">
        <LayerTreeItem
          :label="section.id || `Seccion ${si + 1}`"
          :path="`sections.${si}`"
          :selected="isRowSelected(`sections.${si}`)"
          :primary="isRowPrimary(`sections.${si}`)"
          @select="selectPath(`sections.${si}`, $event)"
          icon="&#x25A3;"
          :level="0"
          has-children
          draggable
          drag-array-path="sections"
          :drag-index="si"
          @move="onMove"
        >
          <template #actions>
            <button
              class="add-mini"
              @click.stop="addLayer(`sections.${si}`)"
              title="Agregar capa a esta seccion"
              aria-label="Agregar capa"
            >+ capa</button>
          </template>
        </LayerTreeItem>

        <div
          v-show="!isCollapsed(section.id, `sections.${si}`)"
          class="subtree"
        >
          <div v-for="(layer, li) in section.layers" :key="layer.id || li" class="tree-layer">
            <LayerTreeItem
              :label="layer.id || `Layer ${li + 1}`"
              :path="`sections.${si}.layers.${li}`"
              :selected="isRowSelected(`sections.${si}.layers.${li}`)"
              :primary="isRowPrimary(`sections.${si}.layers.${li}`)"
              @select="selectPath(`sections.${si}.layers.${li}`, $event)"
              icon="&#x25A1;"
              :depth="layer.depth"
              :level="1"
              has-children
              draggable
              :drag-array-path="`sections.${si}.layers`"
              :drag-index="li"
              @move="onMove"
            >
              <template #actions>
                <button
                  class="add-mini"
                  @click.stop="addElement(`sections.${si}.layers.${li}`, 'text')"
                  title="Agregar texto a esta capa"
                  aria-label="Agregar texto"
                >+ T</button>
                <button
                  class="add-mini"
                  @click.stop="addElement(`sections.${si}.layers.${li}`, 'png')"
                  title="Agregar imagen PNG a esta capa"
                  aria-label="Agregar imagen"
                >+ &#x1F5BC;</button>
              </template>
            </LayerTreeItem>

            <div
              v-show="!isCollapsed(layer.id, `sections.${si}.layers.${li}`)"
              class="subtree"
            >
              <LayerTreeItem
                v-for="(el, ei) in layer.elements"
                :key="el.id || ei"
                :label="el.id || el.type"
                :path="`sections.${si}.layers.${li}.elements.${ei}`"
                :selected="isRowSelected(`sections.${si}.layers.${li}.elements.${ei}`)"
                :primary="isRowPrimary(`sections.${si}.layers.${li}.elements.${ei}`)"
                @select="selectPath(`sections.${si}.layers.${li}.elements.${ei}`, $event)"
                :icon="el.type === 'png' ? '&#x1F5BC;' : el.type === 'text' ? 'T' : '&#x25C6;'"
                :level="2"
                draggable
                :drag-array-path="`sections.${si}.layers.${li}.elements`"
                :drag-index="ei"
                @move="onMove"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.layers-panel { background: #1e1e1e; font-size: 13px; position: relative; height: 100%; display: flex; flex-direction: column; min-height: 0; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #333; flex-shrink: 0; }
.panel-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.header-actions { display: flex; gap: 4px; }
.add-btn-el { background: #2a7d2a; }
.add-btn-el:hover { background: #339933; }
.layers-tree { padding: 6px 0 10px; }
/* Children container: a subtle depth GUIDE LINE (left rail) makes the
   hierarchy scannable without the rows themselves looking noisy. The actual
   per-row indent is driven by LayerTreeItem's `level` prop so chevrons/names
   align consistently per depth. */
.subtree { position: relative; }
.subtree::before {
  content: '';
  position: absolute;
  top: 0; bottom: 2px;
  left: 18px;
  width: 1px;
  background: #ffffff12;
  pointer-events: none;
}
.tree-section + .tree-section { margin-top: 1px; }
.add-btn { background: var(--accent); border: none; color: var(--accent-fg); padding: 4px 11px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0; transition: background .12s ease; }
.add-btn:hover { background: var(--accent-hover); }
.add-btn:active { background: var(--accent); }
.add-btn:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
/* Base look of the per-node add buttons; the cluster reveal/hover accents
   live in LayerTreeItem (:slotted). */
.add-mini { background: #343434; border: 1px solid #454545; color: #b6b6b6; padding: 2px 7px; border-radius: 5px; cursor: pointer; font-size: 10px; font-weight: 600; flex-shrink: 0; }
.add-mini:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.view-banner { padding: 6px 12px; font-size: 11px; color: #ccc; border-bottom: 1px solid #333; flex-shrink: 0; display: flex; align-items: baseline; gap: 6px; }
.view-banner strong { color: #fff; }
.vb-shared { background: #232323; }
.vb-indep { background: #3a2b52; }
.vb-sub { color: #888; font-size: 10px; }
.clip-bar { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid #333; flex-shrink: 0; }
.clip-btn { flex: 1; background: #2a2a2a; border: 1px solid #3a3a3a; color: #bbb; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; }
.clip-btn:hover:not(:disabled) { background: #383838; color: #fff; }
.clip-btn:disabled { opacity: 0.35; cursor: default; }
.clip-status { padding: 4px 10px; font-size: 10px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid #333; flex-shrink: 0; }
.clip-chip { background: #6b3fa0; color: #fff; border-radius: 3px; padding: 1px 6px; font-weight: 600; }
.clip-hint { color: #9c9; }

/* Global (site-level) tree group: visually set apart from the section tree
   (it's config, not content) but uses the SAME row contract as LayerTreeItem
   so it reads as part of the CAPAS tree. */
/* Global (site-level) group: same row rhythm as the redesigned tree so it
   reads as one panel, but set apart (it's config, not content). */
.tree-global { padding: 4px 0 6px; margin-bottom: 6px; border-bottom: 1px solid #333; }
.global-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 12px;
  cursor: pointer;
  border-radius: 5px;
  margin: 1px 4px;
  color: #cfcfcf;
}
.global-item:hover { background: #2b2b2b; }
.global-item.selected { background: var(--accent-soft); }
.global-item.selected .item-label { color: var(--accent-strong); }
.global-item .item-icon { font-size: 13px; width: 16px; text-align: center; opacity: 0.85; flex-shrink: 0; }
.global-item .item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12.5px; }
</style>
