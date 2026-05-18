import { reactive, computed } from 'vue'
import type { Site, Section, Layer, AnyElement } from 'parallax-engine/schema'

export type Tool = 'select' | 'hand' | 'zoom'
export type DeviceMode = 'desktop' | 'mobile'

export interface EditorState {
  projectType: 'eventos' | 'site' | null
  slug: string | null
  site: Site | null
  originalSite: string | null
  selectedPath: string | null
  tool: Tool
  deviceMode: DeviceMode
  canvasZoom: number
  canvasPan: { x: number; y: number }
  undoStack: string[]
  redoStack: string[]
  isClaudeLoading: boolean
  snapToGrid: boolean
  gridSize: number
  errors: string[]
}

export const state = reactive<EditorState>({
  projectType: null,
  slug: null,
  site: null,
  originalSite: null,
  selectedPath: null,
  tool: 'select',
  deviceMode: 'desktop',
  canvasZoom: 0.5,
  canvasPan: { x: 0, y: 0 },
  undoStack: [],
  redoStack: [],
  isClaudeLoading: false,
  snapToGrid: false,
  gridSize: 10,
  errors: [],
})

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
}

export function closeSite() {
  state.site = null
  state.originalSite = null
  state.slug = null
  state.selectedPath = null
  state.undoStack = []
  state.redoStack = []
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

// Get a value at a dot-path like "sections.0.layers.1.elements.2"
export function getAtPath(path: string): any {
  if (!state.site) return undefined
  const parts = path.split('.')
  let obj: any = state.site
  for (const p of parts) {
    if (obj == null) return undefined
    obj = typeof obj === 'object' && p in obj ? obj[p] : obj[Number(p)]
  }
  return obj
}

// Set a value at a dot-path, with undo
export function setAtPath(path: string, value: any) {
  if (!state.site) return
  pushUndo()
  const parts = path.split('.')
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

// Move an item in an array (for drag reorder)
export function moveInArray(arrayPath: string, fromIndex: number, toIndex: number) {
  pushUndo()
  const arr = getAtPath(arrayPath)
  if (!Array.isArray(arr)) return
  const item = arr.splice(fromIndex, 1)[0]
  arr.splice(toIndex, 0, item)
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

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 667 },
}
