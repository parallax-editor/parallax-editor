<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import {
  getAtPath,
  isNodeVisible,
  isNodeLockedById,
  toggleVisibility,
  toggleLock,
  renameNodeId,
  isCollapsed,
  toggleCollapsed,
  state,
} from '../../stores/editor'

const props = defineProps<{
  label: string
  path: string
  // True when this row is part of the selection (primary OR in the tree
  // multi-set) — every selected row is highlighted (TASK #94).
  selected: boolean
  // True for the PRIMARY (last-clicked) row when a multi-selection is active,
  // so it reads slightly stronger than the secondary selected rows.
  primary?: boolean
  icon?: string
  depth?: number
  // Collapse (TASK #77): a section/layer node has children → render a
  // disclosure chevron. Elements have no children → no chevron.
  hasChildren?: boolean
  // Visual hierarchy (TASK #80 redesign): depth level in the tree
  // (0 = sección, 1 = capa, 2 = elemento). Drives a single, consistent
  // indent + the subtle depth guide line so the tree reads like Figma's.
  level?: number
  // Drag-reorder: every node (section/layer/element) is draggable now.
  // `dragArrayPath` is the VIEW-RELATIVE parent array path
  // ("sections" / "sections.0.layers" / "sections.0.layers.1.elements").
  draggable?: boolean
  dragArrayPath?: string
  dragIndex?: number
}>()

const emit = defineEmits<{
  // Plain click = single select. `additive` (Ctrl on Win/Linux, Cmd on mac)
  // = toggle this node into the tree multi-selection (TASK #94). The parent
  // routes to setTreeSelection vs toggleTreeSelection.
  select: [additive: boolean]
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
const collapsed = computed(() => isCollapsed(node.value?.id, props.path))

// Consistent indent per depth (Sección 0 → Capa 1 → Elemento 2). One step is
// 14px so children align under their parent's disclosure/name. The depth guide
// lines are painted by the indent wrappers in LayersPanel; here we only pad.
const INDENT_STEP = 14
const indentStyle = computed(() => ({
  paddingLeft: `${6 + (props.level || 0) * INDENT_STEP}px`,
}))

// ─── Inline id rename (Finder-style, TASK #77) ─────────────────────────────
// With this node selected, pressing Enter turns the NAME into a text input
// prefilled with the current id. Enter/blur commits, Esc cancels. The store's
// renameNodeId sanitizes, de-collides, remaps depends triggers and keeps
// selection on the (renamed) node (selection is by path, which is unchanged).
const renaming = ref(false)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
const renameHint = ref<string | null>(null)
let hintTimer: any = 0
let committed = false

function flashHint(msg: string) {
  renameHint.value = msg
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    if (renameHint.value === msg) renameHint.value = null
  }, 3000)
}

function beginRename() {
  if (locked.value) return
  committed = false
  renameValue.value = node.value?.id || ''
  renaming.value = true
  nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function commitRename() {
  if (!renaming.value || committed) return
  committed = true
  renaming.value = false
  const res = renameNodeId(props.path, renameValue.value)
  if (!res.ok) {
    if (res.hint) flashHint(res.hint)
    return
  }
  if (res.hint) flashHint(res.hint)
  // Selection is by path; the path didn't change so state.selectedPath still
  // points at this (renamed) node. Make sure it stays selected.
  state.selectedPath = props.path
}

function cancelRename() {
  if (!renaming.value) return
  committed = true
  renaming.value = false
}

function onRowKeydown(e: KeyboardEvent) {
  // Only the PRIMARY (active) node reacts to Enter (Finder-style rename
  // trigger). With a multi-selection every selected row is highlighted, so
  // gate on the store's primary path — not just `props.selected` — to keep
  // the single-active-node rename semantics from #77.
  if (renaming.value) return
  if (
    e.key === 'Enter' &&
    props.selected &&
    state.selectedPath === props.path &&
    !locked.value
  ) {
    e.preventDefault()
    e.stopPropagation()
    beginRename()
  }
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    commitRename()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelRename()
  }
}

// Drop affordance: 'before' | 'after' | null (insertion line position).
const dropEdge = ref<null | 'before' | 'after'>(null)

function sourcePath(): string {
  return `${props.dragArrayPath}.${props.dragIndex}`
}

function onDragStart(e: DragEvent) {
  // A locked node can't be reordered → block the drag entirely.
  if (locked.value || renaming.value) {
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
    emit('select', false)
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

function onToggleCollapse(e: MouseEvent) {
  e.stopPropagation()
  toggleCollapsed(node.value?.id, props.path)
}

function onRowClick(e: MouseEvent) {
  if (renaming.value) return
  // Ctrl (Win/Linux) or Cmd (mac) → additive multi-select toggle. metaKey is
  // Cmd on mac; ctrlKey is Ctrl elsewhere (and also Ctrl on mac, which mac
  // users expect to behave like Cmd here too).
  emit('select', e.metaKey || e.ctrlKey)
}
</script>

<template>
  <div
    :class="['tree-item', `lvl-${level || 0}`, { selected, 'is-primary': primary, locked, hidden: !visible, renaming }]"
    :data-test="`layer-row-${nodeId}`"
    tabindex="0"
    @click="onRowClick"
    @keydown="onRowKeydown"
    :draggable="draggable && !locked && !renaming"
    @dragstart="onDragStart"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Insertion line affordance (the user is non-technical: clear where it lands) -->
    <div v-if="dropEdge === 'before'" class="drop-line drop-before" />
    <div v-if="dropEdge === 'after'" class="drop-line drop-after" />

    <!-- ── Single row: [chevron] [icon] NAME … [depth] [eye][lock][+add] ── -->
    <div class="tree-row" :style="indentStyle">
      <button
        v-if="hasChildren"
        class="collapse-btn"
        :data-test="`tree-collapse-${nodeId}`"
        :aria-expanded="!collapsed"
        :title="collapsed ? 'Expandir' : 'Colapsar'"
        @click="onToggleCollapse"
      ><span class="chev" :class="{ open: !collapsed }">▸</span></button>
      <span v-else class="collapse-spacer" />

      <span class="item-icon" v-html="icon" />

      <input
        v-if="renaming"
        ref="renameInput"
        v-model="renameValue"
        class="rename-input"
        data-test="tree-rename-input"
        @keydown="onInputKeydown"
        @blur="commitRename"
        @click.stop
      />
      <span
        v-else
        class="item-label"
        :title="label"
        @dblclick.stop="props.selected && beginRename()"
      >{{ label }}</span>

      <!-- #99: el badge inline de profundidad se eliminó — la profundidad
           ahora vive en el panel de propiedades como un NumberSlider, lo que
           libera espacio para que el cluster de acciones no obstruya la fila.
           `depth` sigue como prop por compatibilidad pero no se renderiza. -->

      <!-- Action cluster: compact, right-aligned, revealed on hover/selection;
           ALWAYS visible for the selected row + when locked/hidden so a
           non-technical user can always discover & undo those states. -->
      <div class="row-actions" v-if="!renaming">
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

        <!-- Per-node add buttons (+capa / +T / +🖼). Provided by the parent so
             the right buttons appear for sections vs layers. -->
        <slot name="actions" />
      </div>
    </div>

    <!-- Spanish hint when the requested id was sanitized / de-collided / rejected -->
    <div
      v-if="renameHint"
      class="rename-hint"
      data-test="tree-rename-hint"
      :style="indentStyle"
    >{{ renameHint }}</div>
  </div>
</template>

<style scoped>
/* ── Figma/Illustrator-style layer row ──────────────────────────────────────
   One fixed-height row. The NAME is the prominent element; the parallax depth
   badge + type icon are subtle/secondary; action controls stay tidy on the
   right and never crowd the name. Consistent vertical rhythm + indent/depth. */
.tree-item {
  position: relative;
  cursor: pointer;
  border-radius: 5px;
  margin: 1px 4px;
  outline: none;
  color: #cfcfcf;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 6px;
  min-width: 0;
  position: relative;
}
.tree-item:hover { background: #2b2b2b; }
.tree-item.selected { background: var(--accent-soft); }
.tree-item.selected .item-label { color: var(--accent-strong); font-weight: 600; }
.tree-item.selected .item-icon { opacity: 0.95; }
/* Primary (last-clicked) row in a multi-selection: a touch stronger + a left
   accent rail so it's clear which node PROPIEDADES is showing. */
.tree-item.selected.is-primary { background: rgba(98, 118, 160, .30); box-shadow: inset 2px 0 0 var(--accent-strong); }
.tree-item:focus-visible { box-shadow: 0 0 0 1px var(--accent-strong) inset; }
/* Hidden: dim only the name/icon/depth (NOT the whole row — the action
   cluster is a child and an ancestor opacity can't be overridden by it, so
   dim the pieces individually and keep the controls fully usable). */
.tree-item.hidden .item-label,
.tree-item.hidden .item-icon,
.tree-item.hidden .item-depth,
.tree-item.hidden .collapse-btn { opacity: 0.42; }
/* Locked: warm tint + always-shown lock so the state is unmistakable. */
.tree-item.locked { background: #3a2e1a; }
.tree-item.locked:hover { background: #45371f; }
.tree-item.locked.selected { background: #4a3a1f; }
.tree-item.locked.selected .item-label { color: #ffcf80; }

/* Disclosure chevron: aligned across sections + layers; elements get an
   equal-width spacer instead so every NAME starts at the same x for its depth. */
.collapse-btn {
  flex-shrink: 0;
  width: 16px; height: 16px;
  background: transparent; border: none; color: #8a8a8a;
  cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 3px;
}
.collapse-btn:hover { background: #4a4a4a; color: #fff; }
.chev {
  font-size: 9px; line-height: 1;
  display: inline-block;
  transition: transform 0.12s ease;
}
.chev.open { transform: rotate(90deg); }
.collapse-spacer { flex-shrink: 0; width: 16px; }

/* Type icon: small + secondary so the NAME reads first. */
.item-icon {
  font-size: 11px;
  width: 15px;
  text-align: center;
  opacity: 0.6;
  flex-shrink: 0;
}

/* The NAME: the prominent, readable element. It keeps its FULL natural width
   and ellipsizes only when the row itself is too narrow (never crushed by the
   action cluster — that's an absolutely-positioned overlay, out of flow).
   min-width keeps a readable floor so a name never collapses to "c..". */
.item-label {
  flex: 1 1 auto;
  min-width: 40px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  letter-spacing: 0.005em;
  /* The row is draggable; without this, clicking the NAME text starts a native
     text selection/drag that swallows the click so the row never selects (it
     read as a deselect). Make the label a clean click target like the rest of
     the row. Double-click-to-rename still works. */
  user-select: none;
}

/* Parallax depth badge: subtle / secondary chip, never competes with name. */
.item-depth {
  flex-shrink: 0;
  font-size: 9.5px;
  color: #8a8a8a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #00000033;
  border-radius: 4px;
  padding: 1px 5px;
  min-width: 18px;
  text-align: center;
}
.tree-item.selected .item-depth { color: var(--accent-strong); background: var(--accent-soft); }

.rename-input {
  flex: 1 1 auto;
  min-width: 0;
  background: #111;
  border: 1px solid var(--accent-strong);
  border-radius: 4px;
  color: #fff;
  font-size: 12.5px;
  padding: 3px 6px;
  font-family: inherit;
}
.rename-hint {
  font-size: 10px;
  color: #e0a52a;
  padding-top: 2px;
  padding-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Action cluster ─────────────────────────────────────────────────────────
   ABSOLUTELY positioned over the right edge of the row (out of the flex flow)
   so it NEVER consumes width / crushes the name — the name always keeps its
   full natural width (Figma/Illustrator behaviour). It is ALWAYS present and
   ALWAYS clickable (pointer-events stay on, opacity never hits 0): a
   non-technical user can always see & reach visibility/lock/+add (no purely
   hover-hidden controls), and automated clicks aren't blocked. It is just
   visually QUIET when the row is idle and brightens on hover/selection /
   locked/hidden so it never visually crowds the name. A short fade behind it
   lets a long name dissolve under the controls instead of a hard clip. */
.row-actions {
  position: absolute;
  right: 4px;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  padding-left: 22px;
  opacity: 0.32;
  pointer-events: auto;
  transition: opacity 0.1s ease;
  /* fade so the name dissolves under the cluster instead of a hard clip */
  background: linear-gradient(to right, transparent 0, #242424 22px);
}
.tree-item:hover .row-actions { background: linear-gradient(to right, transparent 0, #2b2b2b 22px); }
.tree-item.selected .row-actions { background: linear-gradient(to right, transparent 0, #1f3450 22px); }
.tree-item.locked .row-actions { background: linear-gradient(to right, transparent 0, #3a2e1a 22px); }
.tree-item.locked:hover .row-actions { background: linear-gradient(to right, transparent 0, #45371f 22px); }
.tree-item:hover .row-actions,
.tree-item.selected .row-actions,
.tree-item:focus-within .row-actions,
.tree-item.locked .row-actions,
.tree-item.hidden .row-actions {
  opacity: 1;
}
.node-btn {
  flex-shrink: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 3px 4px;
  border-radius: 4px;
  opacity: 0.55;
  filter: grayscale(1);
}
.node-btn:hover { background: #00000055; opacity: 1; filter: none; }
/* Active states stay vivid even when the cluster is shown un-hovered. */
.vis-btn.off { opacity: 1; filter: none; }
.lock-btn.on { opacity: 1; filter: none; }

/* Per-node add buttons passed through the #actions slot. Compact "pill"
   buttons consistent with the cluster; appear with it on hover/selection. */
.row-actions :slotted(.add-mini) {
  background: #343434;
  border: 1px solid #454545;
  color: #b6b6b6;
  padding: 2px 7px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  margin-left: 3px;
  flex-shrink: 0;
}
.row-actions :slotted(.add-mini:hover) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}

/* Drop insertion line — clear where a dragged node lands. */
.drop-line {
  position: absolute;
  left: 4px; right: 4px;
  height: 2px;
  background: var(--accent-strong);
  z-index: 2;
  pointer-events: none;
  border-radius: 1px;
}
.drop-line::before {
  content: '';
  position: absolute;
  left: -3px; top: -2px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent-strong);
}
.drop-before { top: -1px; }
.drop-after { bottom: -1px; }
</style>
