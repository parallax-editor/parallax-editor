import { onMounted, onUnmounted } from 'vue'
import { state, undo, redo, deleteSelected, duplicateSelected } from '../stores/editor'

export function useShortcuts(onSave: () => void) {
  function handleKey(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey
    const target = e.target as HTMLElement
    // Don't capture when typing in inputs
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return

    // Tool shortcuts (single key, no modifier)
    if (!meta && !e.shiftKey) {
      if (e.key === 'v' || e.key === 'V') { state.tool = 'select'; e.preventDefault(); return }
      if (e.key === 'h' || e.key === 'H') { state.tool = 'hand'; e.preventDefault(); return }
      if (e.key === 'z' && !meta) { state.tool = 'zoom'; e.preventDefault(); return }
    }

    // Meta shortcuts
    if (meta) {
      if (e.key === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return }
      if (e.key === 'z' && e.shiftKey) { redo(); e.preventDefault(); return }
      if (e.key === 'Z') { redo(); e.preventDefault(); return }
      if (e.key === 's') { onSave(); e.preventDefault(); return }
      if (e.key === 'd') { duplicateSelected(); e.preventDefault(); return }
      if (e.key === '0') {
        state.canvasZoom = 0.5
        state.canvasPan = { x: 0, y: 0 }
        e.preventDefault()
        return
      }
      if (e.key === '=' || e.key === '+') {
        state.canvasZoom = Math.min(3, state.canvasZoom + 0.1)
        e.preventDefault()
        return
      }
      if (e.key === '-') {
        state.canvasZoom = Math.max(0.1, state.canvasZoom - 0.1)
        e.preventDefault()
        return
      }
    }

    // Delete
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedPath) { deleteSelected(); e.preventDefault() }
    }
  }

  onMounted(() => window.addEventListener('keydown', handleKey))
  onUnmounted(() => window.removeEventListener('keydown', handleKey))
}
