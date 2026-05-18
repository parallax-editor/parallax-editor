<script setup lang="ts">
const props = defineProps<{
  label: string
  path: string
  selected: boolean
  icon?: string
  depth?: number
  draggable?: boolean
  dragPath?: string
  dragIndex?: number
}>()

const emit = defineEmits<{ select: [] }>()

function onDragStart(e: DragEvent) {
  if (props.dragPath !== undefined && props.dragIndex !== undefined) {
    e.dataTransfer?.setData('text/plain', `${props.dragPath}.${props.dragIndex}`)
  }
}

function onDrop(e: DragEvent) {
  emit('select')
}
</script>

<template>
  <div
    :class="['tree-item', { selected }]"
    @click="emit('select')"
    :draggable="draggable"
    @dragstart="onDragStart"
    @dragover.prevent
    @drop="onDrop"
  >
    <span class="item-icon" v-html="icon" />
    <span class="item-label">{{ label }}</span>
    <span v-if="depth !== undefined" class="item-depth">{{ depth }}</span>
  </div>
</template>

<style scoped>
.tree-item { display: flex; align-items: center; gap: 6px; padding: 4px 12px; cursor: pointer; border-radius: 4px; margin: 1px 4px; }
.tree-item:hover { background: #2a2a2a; }
.tree-item.selected { background: #0066cc33; color: #6cb3ff; }
.item-icon { font-size: 12px; width: 16px; text-align: center; opacity: 0.7; }
.item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-depth { font-size: 10px; color: #666; font-family: monospace; }
</style>
