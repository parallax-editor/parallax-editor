// ─── Preload — puente seguro renderer ⇄ main (FASE 3) ────────────────────────
//
// contextIsolation ON + nodeIntegration OFF: el SPA NO tiene acceso a Node. Este
// preload expone, vía contextBridge, SOLO las capacidades nativas que el editor
// necesita y que deben correr en el proceso principal:
//   • pickFolder()  → diálogo nativo de carpeta (mejor que osascript; además
//                     concede permiso TCC sobre la carpeta elegida).
//   • get/setAutoStart() → "Iniciar al encender la Mac" desde la UI (doctor).
//   • onOpenDoctor()     → el menú "Ayuda → Diagnóstico" abre la pantalla doctor.
//
// En el navegador normal (`yarn editor`, sin Electron) `window.electronAPI` no
// existe → el cliente cae al endpoint HTTP/osascript. Ver src/composables/useElectron.ts.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // Diálogo nativo de carpeta. Devuelve { ok, path?, canceled? }.
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  // Auto-inicio al encender la Mac. { ok, enabled }.
  getAutoStart: () => ipcRenderer.invoke('login-item:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('login-item:set', !!enabled),
  // El menú nativo "Ayuda → Diagnóstico" empuja este evento al renderer.
  onOpenDoctor: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('open-doctor', handler)
    // Devolvemos un disposer por si el componente quiere desuscribirse.
    return () => ipcRenderer.removeListener('open-doctor', handler)
  },
  // Acciones del menú nativo (Archivo/Edición/Elemento/Git/Publicar/Ver/…). El
  // main manda un id de acción ('file.save', 'git.pull', …) y el renderer lo
  // despacha a la función correspondiente (ver src/composables/useMenu.ts).
  onMenuAction: (cb) => {
    const handler = (_e, action) => cb(action)
    ipcRenderer.on('menu:action', handler)
    return () => ipcRenderer.removeListener('menu:action', handler)
  },
  // El renderer reporta las capacidades del workspace ACTIVO ({ useGit, hasS3 })
  // para que el menú nativo habilite/deshabilite Git y Publicar.
  setWorkspaceCapabilities: (caps) => ipcRenderer.send('workspace:capabilities', caps),
  // El renderer reporta si hay cambios SIN GUARDAR. El main lo usa para avisar
  // al cerrar la ventana (X / Cmd+Q) y no perder trabajo.
  setDirty: (dirty) => ipcRenderer.send('editor:dirty', !!dirty),
})
