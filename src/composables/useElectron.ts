// ─── Puente del renderer hacia Electron (FASE 3/4) ───────────────────────────
//
// Envuelve `window.electronAPI` (expuesto por electron/preload.cjs) con una API
// tipada y segura para el navegador: si el editor corre como web normal
// (`yarn editor`, sin Electron) todo degrada limpio (isElectron=false, los
// setters son no-op, onOpenDoctor no se dispara). Así los componentes no tienen
// que comprobar `window` a mano.

interface ElectronBridge {
  isElectron: true
  pickFolder: () => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  getAutoStart: () => Promise<{ ok: boolean; enabled: boolean }>
  setAutoStart: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; error?: string }>
  onOpenDoctor: (cb: () => void) => () => void
  onMenuAction: (cb: (action: string) => void) => () => void
  setWorkspaceCapabilities: (caps: { useGit: boolean; hasS3: boolean; inEditor: boolean }) => void
}

function bridge(): ElectronBridge | null {
  const el = (globalThis as any).electronAPI
  return el && el.isElectron ? (el as ElectronBridge) : null
}

export function useElectron() {
  const el = bridge()
  return {
    /** ¿Corremos dentro de la app de escritorio (Electron)? */
    isElectron: !!el,
    /** Lee el estado de auto-inicio. En web: { ok:false, enabled:false }. */
    async getAutoStart(): Promise<boolean> {
      if (!el) return false
      try {
        const r = await el.getAutoStart()
        return !!r?.enabled
      } catch {
        return false
      }
    },
    /** Cambia auto-inicio. Devuelve el estado REAL tras aplicarlo (web: false). */
    async setAutoStart(enabled: boolean): Promise<boolean> {
      if (!el) return false
      try {
        const r = await el.setAutoStart(enabled)
        return !!r?.enabled
      } catch {
        return false
      }
    },
    /** Suscribe al evento "Ayuda → Diagnóstico" del menú nativo. Devuelve disposer. */
    onOpenDoctor(cb: () => void): () => void {
      if (!el) return () => {}
      return el.onOpenDoctor(cb)
    },
    /** Suscribe a las acciones del menú nativo (id de acción). Devuelve disposer. */
    onMenuAction(cb: (action: string) => void): () => void {
      if (!el) return () => {}
      return el.onMenuAction(cb)
    },
    /** Reporta al menú nativo las capacidades del workspace activo (web: no-op). */
    setWorkspaceCapabilities(caps: { useGit: boolean; hasS3: boolean; inEditor: boolean }): void {
      if (!el) return
      try {
        el.setWorkspaceCapabilities(caps)
      } catch {
        /* no-op */
      }
    },
  }
}
