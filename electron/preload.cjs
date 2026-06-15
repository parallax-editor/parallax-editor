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

  // Renderer → main: el switcher / el setLocale de Vue le avisa al menú nativo
  // qué locale activo está usando, para reconstruir labels en el mismo idioma.
  setLocale: (locale) => ipcRenderer.send('app:set-locale', locale),

  // Main → renderer: cuando el usuario elige "Ventana → Idioma / Window →
  // Language" en el menú nativo, main empuja `app:locale-changed` con el
  // nuevo código. El renderer aplica via i18n.setLocale (que también
  // bumpea engine + localStorage). Sin este bridge el menú cambiaba sus
  // propios labels pero la UI Vue quedaba pegada al locale de boot.
  onLocaleChanged: (cb) => {
    const handler = (_e, locale) => cb(locale)
    ipcRenderer.on('app:locale-changed', handler)
    return () => ipcRenderer.removeListener('app:locale-changed', handler)
  },

})

// ── SecretsBus (Fase 2) ────────────────────────────────────────────────────
// Bridge tipado y mínimo al keychain del SO (via safeStorage). El renderer NO
// tiene acceso al filesystem ni al módulo safeStorage; solo a estas 5 ops.
// Expuesto bajo `window.parallax.secrets` como contrato único (el wrapper del
// renderer `useSecrets` lo busca por ahí). Una sola fachada = una sola
// superficie de ataque IPC para auditar.
contextBridge.exposeInMainWorld('parallax', {
  secrets: {
    set: (key, value) => ipcRenderer.invoke('secrets:set', key, value),
    get: (key) => ipcRenderer.invoke('secrets:get', key),
    delete: (key) => ipcRenderer.invoke('secrets:delete', key),
    list: () => ipcRenderer.invoke('secrets:list'),
    backend: () => ipcRenderer.invoke('secrets:backend'),
  },
})
