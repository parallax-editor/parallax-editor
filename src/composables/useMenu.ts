// ─── Bus de acciones del menú nativo ─────────────────────────────────────────
//
// El menú de Electron manda un id de acción ('file.save', 'git.pull', …). App.vue
// recibe el evento IPC (useElectron.onMenuAction) y lo reemite por este bus; las
// vistas (EditorView, etc.) se suscriben con `onMenu` y manejan SOLO las acciones
// que les aplican (las que no, se ignoran — no-op). Así una acción de editor no
// hace nada si estás en el selector, y viceversa.

type MenuHandler = (action: string) => void

const handlers = new Set<MenuHandler>()

/** Registra un handler de acciones de menú. Devuelve un disposer. */
export function onMenu(handler: MenuHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

/** Reemite una acción de menú a todos los suscriptores. */
export function emitMenu(action: string): void {
  for (const h of handlers) {
    try {
      h(action)
    } catch {
      /* un handler que falle no debe romper a los demás */
    }
  }
}
