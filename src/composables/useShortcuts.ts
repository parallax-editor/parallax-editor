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

// True when the event originates from a text-entry control (or any
// contenteditable). Shared by the keydown handler AND the Space modifier so
// neither hijacks typing.
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}

export function useShortcuts(onSave: () => void) {
  function handleKey(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey
    const target = e.target as HTMLElement
    // No capturar cuando se escribe en un campo (input/textarea/contenteditable).
    // Chequeamos el target del evento Y el document.activeElement: a veces el
    // keydown llega con target = body aunque el foco esté en un input (p.ej. el
    // panel de Claude), y entonces Cmd+C/V/X disparaban el copiar/pegar del
    // ELEMENTO del árbol en vez del texto del campo. Con ambos chequeos, si hay
    // un campo enfocado, el editor deja pasar el copy/paste/cut nativo del texto.
    if (isTypingTarget(target) || isTypingTarget(document.activeElement)) return

    // ── Space = temporary pan modifier (GAP9) ────────────────────────────
    // Hold Space → canvas pans like the Mano tool (cursor grab, drag pans);
    // release restores the prior tool. state.tool is intentionally NOT
    // changed (V/H/Z stay intact). Swallow Space so the page never scrolls
    // and a focused button isn't "clicked". Ignore auto-repeat.
    if (e.code === 'Space' || e.key === ' ') {
      if (!e.repeat) state.spacePanning = true
      e.preventDefault()
      return
    }

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

  // Release the Space pan modifier. Also cleared on window blur / tab hide so
  // it can never get "stuck" if the keyup is missed (alt-tab, devtools, etc.).
  function handleKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space' || e.key === ' ') {
      state.spacePanning = false
    }
  }
  function clearSpace() {
    state.spacePanning = false
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKey)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', clearSpace)
    document.addEventListener('visibilitychange', clearSpace)
  })
  onUnmounted(() => {
    window.removeEventListener('keydown', handleKey)
    window.removeEventListener('keyup', handleKeyUp)
    window.removeEventListener('blur', clearSpace)
    document.removeEventListener('visibilitychange', clearSpace)
    state.spacePanning = false
  })
}
