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

const clipboardLabel = computed(() => {
  const c = state.clipboard
  if (!c) return ''
  const kind = c.kind === 'section' ? 'Sección' : c.kind === 'layer' ? 'Capa' : 'Elemento'
  return `${c.op === 'cut' ? 'Cortado' : 'Copiado'}: ${kind}`
})

function selectPath(path: string) {
  state.selectedPath = path
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

    <!-- Tree clipboard affordances (Daniela is non-technical: explicit buttons
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
      <div v-for="(section, si) in sections" :key="section.id || si" class="tree-section">
        <div class="row-with-action">
          <LayerTreeItem
            class="grow"
            :label="section.id || `Seccion ${si + 1}`"
            :path="`sections.${si}`"
            :selected="state.selectedPath === `sections.${si}`"
            @select="selectPath(`sections.${si}`)"
            icon="&#x25A3;"
            draggable
            drag-array-path="sections"
            :drag-index="si"
            @move="onMove"
          />
          <button
            class="add-mini"
            @click.stop="addLayer(`sections.${si}`)"
            title="Agregar capa a esta seccion"
            aria-label="Agregar capa"
          >+ capa</button>
        </div>
        <div class="indent">
          <div v-for="(layer, li) in section.layers" :key="layer.id || li" class="tree-layer">
            <div class="row-with-action">
              <LayerTreeItem
                class="grow"
                :label="layer.id || `Layer ${li + 1}`"
                :path="`sections.${si}.layers.${li}`"
                :selected="state.selectedPath === `sections.${si}.layers.${li}`"
                @select="selectPath(`sections.${si}.layers.${li}`)"
                icon="&#x25A1;"
                :depth="layer.depth"
                draggable
                :drag-array-path="`sections.${si}.layers`"
                :drag-index="li"
                @move="onMove"
              />
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
            </div>
            <div class="indent">
              <LayerTreeItem
                v-for="(el, ei) in layer.elements"
                :key="el.id || ei"
                :label="el.id || el.type"
                :path="`sections.${si}.layers.${li}.elements.${ei}`"
                :selected="state.selectedPath === `sections.${si}.layers.${li}.elements.${ei}`"
                @select="selectPath(`sections.${si}.layers.${li}.elements.${ei}`)"
                :icon="el.type === 'png' ? '&#x1F5BC;' : el.type === 'text' ? 'T' : '&#x25C6;'"
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
.layers-tree { padding: 4px 0; }
.indent { padding-left: 16px; }
.row-with-action { display: flex; align-items: center; }
.grow { flex: 1; min-width: 0; }
.add-btn { background: #0066cc; border: none; color: #fff; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0; }
.add-btn:hover { background: #0077e6; }
.add-mini { background: #2a2a2a; border: 1px solid #3a3a3a; color: #999; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px; margin-right: 4px; flex-shrink: 0; }
.add-mini:hover { background: #383838; color: #ddd; }
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
</style>
