import { onMounted, onUnmounted } from 'vue'
import {
  state,
  undo,
  redo,
  deleteSelected,
  duplicateSelected,
  zoomIn,
  zoomOut,
  zoomToFit,
  copySelected,
  cutSelected,
  pasteClipboard,
} from '../stores/editor'

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
      // Tree clipboard: copy / cut / paste (within & across views). Only act
      // when something is selected (copy/cut) or always (paste handles empty
      // clipboard with a hint), so it never clobbers a native field copy —
      // typing-in-input is already excluded above.
      if (e.key === 'c' && !e.shiftKey) {
        if (state.selectedPath) { copySelected(); e.preventDefault() }
        return
      }
      if (e.key === 'x' && !e.shiftKey) {
        if (state.selectedPath) { cutSelected(); e.preventDefault() }
        return
      }
      if (e.key === 'v' && !e.shiftKey) {
        if (state.clipboard) { pasteClipboard(); e.preventDefault() }
        return
      }
      if (e.key === '0') {
        const canvas = document.querySelector('.editor-canvas') as HTMLElement | null
        zoomToFit(canvas?.clientWidth || 0, canvas?.clientHeight || 0)
        e.preventDefault()
        return
      }
      if (e.key === '=' || e.key === '+') {
        zoomIn()
        e.preventDefault()
        return
      }
      if (e.key === '-' || e.key === '_') {
        zoomOut()
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
