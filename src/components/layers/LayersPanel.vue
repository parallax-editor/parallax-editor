<script setup lang="ts">
import { state, moveInArray } from '../../stores/editor'
import LayerTreeItem from './LayerTreeItem.vue'

function selectPath(path: string) {
  state.selectedPath = path
}

function handleDrop(e: DragEvent, targetPath: string, targetIndex: number) {
  e.preventDefault()
  const sourcePath = e.dataTransfer?.getData('text/plain')
  if (!sourcePath) return
  const sourceParent = sourcePath.split('.').slice(0, -1).join('.')
  const sourceIndex = Number(sourcePath.split('.').pop())
  if (sourceParent === targetPath) {
    moveInArray(targetPath, sourceIndex, targetIndex)
  }
}
</script>

<template>
  <div class="layers-panel">
    <div class="panel-header">Capas</div>
    <div class="layers-tree" v-if="state.site">
      <div v-for="(section, si) in state.site.sections" :key="section.id || si" class="tree-section">
        <LayerTreeItem
          :label="section.id || `Seccion ${si + 1}`"
          :path="`sections.${si}`"
          :selected="state.selectedPath === `sections.${si}`"
          @select="selectPath(`sections.${si}`)"
          icon="&#x25A3;"
        />
        <div class="indent">
          <div v-for="(layer, li) in section.layers" :key="layer.id || li" class="tree-layer">
            <LayerTreeItem
              :label="layer.id || `Layer ${li + 1}`"
              :path="`sections.${si}.layers.${li}`"
              :selected="state.selectedPath === `sections.${si}.layers.${li}`"
              @select="selectPath(`sections.${si}.layers.${li}`)"
              icon="&#x25A1;"
              :depth="layer.depth"
            />
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
                :drag-path="`sections.${si}.layers.${li}.elements`"
                :drag-index="ei"
                @drop="(e: DragEvent) => handleDrop(e, `sections.${si}.layers.${li}.elements`, ei)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layers-panel { background: #1e1e1e; font-size: 13px; }
.panel-header { padding: 10px 12px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #333; }
.layers-tree { padding: 4px 0; }
.indent { padding-left: 16px; }
</style>
