<script setup lang="ts">
import { ref, computed } from 'vue'
import { getAtPath, isNodeVisible, isNodeLockedById, toggleVisibility, toggleLock } from '../../stores/editor'

const props = defineProps<{
  label: string
  path: string
  selected: boolean
  icon?: string
  depth?: number
  // Drag-reorder: every node (section/layer/element) is draggable now.
  // `dragArrayPath` is the VIEW-RELATIVE parent array path
  // ("sections" / "sections.0.layers" / "sections.0.layers.1.elements").
  draggable?: boolean
  dragArrayPath?: string
  dragIndex?: number
}>()

const emit = defineEmits<{
  select: []
  // Cross-parent move: (sourcePath, targetArrayPath, toIndex). toIndex is the
  // slot to insert AT (before the dropped-on row, or after if dropped on its
  // lower half).
  move: [sourcePath: string, targetArrayPath: string, toIndex: number]
}>()

// Slugged id for stable data-test hooks (label may contain spaces/accents).
const node = computed(() => getAtPath(props.path))
const nodeId = computed(() => node.value?.id || props.path.replace(/\./g, '-'))
const visible = computed(() => isNodeVisible(node.value))
const locked = computed(() => isNodeLockedById(node.value?.id))

// Drop affordance: 'before' | 'after' | null (insertion line position).
const dropEdge = ref<null | 'before' | 'after'>(null)

function sourcePath(): string {
  return `${props.dragArrayPath}.${props.dragIndex}`
}

function onDragStart(e: DragEvent) {
  // A locked node can't be reordered → block the drag entirely.
  if (locked.value) {
    e.preventDefault()
    return
  }
  if (props.dragArrayPath !== undefined && props.dragIndex !== undefined) {
    e.dataTransfer?.setData('text/plain', sourcePath())
    e.dataTransfer!.effectAllowed = 'move'
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (props.dragArrayPath === undefined) {
    dropEdge.value = null
    return
  }
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropEdge.value = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

function onDragLeave() {
  dropEdge.value = null
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  const src = e.dataTransfer?.getData('text/plain')
  const edge = dropEdge.value
  dropEdge.value = null
  if (!src || props.dragArrayPath === undefined || props.dragIndex === undefined) {
    emit('select')
    return
  }
  const toIndex = edge === 'after' ? props.dragIndex + 1 : props.dragIndex
  emit('move', src, props.dragArrayPath, toIndex)
}

function onToggleVisible(e: MouseEvent) {
  e.stopPropagation()
  toggleVisibility(props.path)
}

function onToggleLock(e: MouseEvent) {
  e.stopPropagation()
  toggleLock(props.path)
}
</script>

<template>
  <div
    :class="['tree-item', { selected, locked, hidden: !visible }]"
    :data-test="`layer-row-${nodeId}`"
    @click="emit('select')"
    :draggable="draggable && !locked"
    @dragstart="onDragStart"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Insertion line affordance (Daniela is non-technical: clear where it lands) -->
    <div v-if="dropEdge === 'before'" class="drop-line drop-before" />
    <div v-if="dropEdge === 'after'" class="drop-line drop-after" />

    <span class="item-icon" v-html="icon" />
    <span class="item-label">{{ label }}</span>
    <span v-if="depth !== undefined" class="item-depth">{{ depth }}</span>

    <button
      class="node-btn vis-btn"
      :class="{ off: !visible }"
      :data-test="`layer-visibility-${nodeId}`"
      :title="visible ? 'Ocultar' : 'Mostrar'"
      :aria-label="visible ? 'Ocultar' : 'Mostrar'"
      @click="onToggleVisible"
    >{{ visible ? '👁' : '🚫' }}</button>
    <button
      class="node-btn lock-btn"
      :class="{ on: locked }"
      :data-test="`layer-lock-${nodeId}`"
      :title="locked ? 'Desbloquear' : 'Bloquear'"
      :aria-label="locked ? 'Desbloquear' : 'Bloquear'"
      @click="onToggleLock"
    >{{ locked ? '🔒' : '🔓' }}</button>
  </div>
</template>

<style scoped>
.tree-item { position: relative; display: flex; align-items: center; gap: 6px; padding: 4px 12px; cursor: pointer; border-radius: 4px; margin: 1px 4px; }
.tree-item:hover { background: #2a2a2a; }
.tree-item.selected { background: #0066cc33; color: #6cb3ff; }
.tree-item.hidden { opacity: 0.45; }
.tree-item.locked { background: #3a2e1a; }
.tree-item.locked.selected { background: #4a3a1f; color: #ffcf80; }
.item-icon { font-size: 12px; width: 16px; text-align: center; opacity: 0.7; flex-shrink: 0; }
.item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-depth { font-size: 10px; color: #666; font-family: monospace; flex-shrink: 0; }
.node-btn {
  flex-shrink: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: 3px;
  opacity: 0.35;
  filter: grayscale(1);
}
.tree-item:hover .node-btn { opacity: 0.7; }
.node-btn:hover { background: #444; opacity: 1; filter: none; }
/* Active states stay visible even when not hovering the row. */
.vis-btn.off { opacity: 0.95; filter: none; }
.lock-btn.on { opacity: 0.95; filter: none; }
.drop-line { position: absolute; left: 4px; right: 4px; height: 2px; background: #0099ff; z-index: 2; pointer-events: none; }
.drop-line::before { content: ''; position: absolute; left: -3px; top: -2px; width: 6px; height: 6px; border-radius: 50%; background: #0099ff; }
.drop-before { top: -1px; }
.drop-after { bottom: -1px; }
</style>
