// ─── Electron — proceso principal (FASE 2: cáscara de escritorio) ────────────
//
// Envuelve el editor en una app nativa de macOS SIN cambiar el flujo de dev.
// NO empaqueta nada todavía (eso es Fase 3). Dos modos:
//
//   DEV  (ELECTRON_DEV=1):  carga el dev server de Vite en :3000. El usuario
//                           corre `yarn editor` en otra terminal; aquí solo
//                           levantamos la ventana apuntando a ese server.
//   PROD (default):         arranca el server standalone IN-PROCESS (start())
//                           y carga http://localhost:<port>. Sirve el SPA ya
//                           compilado de dist/ + la API/WS sin Vite.
//
// Seguridad: contextIsolation ON, nodeIntegration OFF, preload mínimo que
// expone SOLO diálogo de carpeta / auto-inicio / abrir-doctor (ver preload.cjs).
//
// FASE 3: además (a) corregimos el PATH (apps lanzadas desde Finder no ven
// /opt/homebrew/bin etc., y `claude`/`git` "no se encontrarían"), y (b) usamos
// el diálogo NATIVO de carpeta vía IPC (mejor que osascript y concede permiso
// TCC sobre la carpeta elegida).

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { fixPath } = require('./path-fix.cjs')

// CRÍTICO: corregir el PATH ANTES de cualquier spawn (el server in-process
// lanza `claude`/`git`). Idempotente; no-op nocivo en dev.
fixPath()

const IS_DEV = process.env.ELECTRON_DEV === '1'
const DEV_URL = 'http://localhost:3000'
const PRELOAD = path.join(__dirname, 'preload.cjs')

/** Referencias vivas para cierre limpio. */
let mainWindow = null
/** Resultado de start() del server standalone: { port, server, close }. */
let standaloneServer = null

// ─── Server standalone (solo modo PROD) ──────────────────────────────────────
// Buscamos el bundle CJS de `yarn build:server` (dist-server/server.cjs). Si no
// existe (alguien corrió electron:start sin compilar), fallamos con un dialog
// claro en vez de un crash silencioso.
function resolveServerModule() {
  const candidates = [
    path.resolve(__dirname, '..', 'dist-server', 'server.cjs'),
    path.resolve(process.cwd(), 'dist-server', 'server.cjs'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

async function startStandaloneServer() {
  const modPath = resolveServerModule()
  if (!modPath) {
    throw new Error(
      'No se encontró dist-server/server.cjs.\n\n' +
        'Compila primero con `yarn build:server` (o usa `yarn electron:start`, ' +
        'que compila SPA + server antes de abrir la app).',
    )
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { start } = require(modPath)
  // Puerto 0 = el SO asigna uno libre; evitamos chocar con otro editor abierto.
  // start() resuelve con el puerto REAL.
  standaloneServer = await start(0)
  return standaloneServer.port
}

async function closeStandaloneServer() {
  if (standaloneServer && typeof standaloneServer.close === 'function') {
    try {
      await standaloneServer.close()
    } catch {
      /* best-effort: cerramos igual la app */
    }
    standaloneServer = null
  }
}

// ─── Ventana principal ───────────────────────────────────────────────────────
function createWindow(loadTarget) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Parallax Editor',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // window.open / target=_blank:
  //  • URL del MISMO origen (http://localhost:<port>, p.ej. la "Vista en vivo"
  //    que hace window.open('/live?…')) → abrir como VENTANA Electron en la
  //    misma sesión. Crítico: comparte localStorage + BroadcastChannel con la
  //    ventana del editor, que es como se le pasa el documento a la preview
  //    (handoff same-origin). Si se abriera en el navegador del sistema, sería
  //    otro origen y la preview saldría vacía — sobre todo empaquetado.
  //  • Enlaces EXTERNOS (otros dominios) → navegador del sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1280,
            height: 800,
            backgroundColor: '#1e1e1e',
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              preload: PRELOAD,
            },
          },
        }
      }
    } catch {
      /* url no parseable → tratar como externo */
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(loadTarget)

  if (IS_DEV) {
    mainWindow.webContents.openDevTools()
  }
}

// ─── Menú nativo ──────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const loginEnabled = (() => {
    try {
      return app.getLoginItemSettings().openAtLogin
    } catch {
      return false
    }
  })()

  const appMenu = {
    label: app.name,
    submenu: [
      { role: 'about', label: 'Acerca de Parallax Editor' },
      { type: 'separator' },
      {
        label: 'Iniciar al encender la Mac',
        type: 'checkbox',
        checked: loginEnabled,
        // Solo tiene sentido en macOS/Windows; en Linux es no-op.
        click: (item) => {
          try {
            app.setLoginItemSettings({ openAtLogin: item.checked })
            // Reflejar el estado real (por si el SO lo rechaza).
            item.checked = app.getLoginItemSettings().openAtLogin
          } catch (err) {
            console.error('[electron] No se pudo cambiar el inicio automático:', err)
          }
        },
      },
      { type: 'separator' },
      { role: 'quit', label: 'Salir' },
    ],
  }

  const editMenu = {
    label: 'Editar',
    submenu: [
      { role: 'undo', label: 'Deshacer' },
      { role: 'redo', label: 'Rehacer' },
      { type: 'separator' },
      { role: 'cut', label: 'Cortar' },
      { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Pegar' },
      { role: 'selectAll', label: 'Seleccionar todo' },
    ],
  }

  const viewMenu = {
    label: 'Ver',
    submenu: [
      { role: 'reload', label: 'Recargar' },
      { role: 'forceReload', label: 'Forzar recarga' },
      { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Zoom real' },
      { role: 'zoomIn', label: 'Acercar' },
      { role: 'zoomOut', label: 'Alejar' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Pantalla completa' },
    ],
  }

  // "Ayuda → Diagnóstico" abre la pantalla doctor (Fase 4) en el renderer.
  const helpMenu = {
    label: 'Ayuda',
    role: 'help',
    submenu: [
      {
        label: 'Diagnóstico…',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('open-doctor')
          }
        },
      },
    ],
  }

  const template = []
  if (isMac) template.push(appMenu)
  template.push(editMenu, viewMenu, helpMenu)

  // En no-mac dejamos un menú mínimo igualmente (la app es macOS-first, pero
  // que no quede sin "Salir").
  if (!isMac) {
    template.unshift({
      label: 'Archivo',
      submenu: [
        {
          label: 'Iniciar al encender',
          type: 'checkbox',
          checked: loginEnabled,
          click: (item) => {
            try {
              app.setLoginItemSettings({ openAtLogin: item.checked })
              item.checked = app.getLoginItemSettings().openAtLogin
            } catch (err) {
              console.error('[electron] No se pudo cambiar el inicio automático:', err)
            }
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' },
      ],
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── IPC nativo (preload → main) ─────────────────────────────────────────────
function registerIpc() {
  // Diálogo NATIVO de carpeta. Concede permiso TCC sobre la carpeta elegida
  // (clave para clonar/abrir workspaces en ~/Documents sin error de permisos).
  ipcMain.handle('dialog:pick-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: 'Elegir carpeta',
      buttonLabel: 'Elegir',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    return { ok: true, path: res.filePaths[0] }
  })

  // Auto-inicio al encender la Mac (mismo setting que el checkbox del menú).
  ipcMain.handle('login-item:get', () => {
    try {
      return { ok: true, enabled: app.getLoginItemSettings().openAtLogin }
    } catch {
      return { ok: false, enabled: false }
    }
  })
  ipcMain.handle('login-item:set', (_e, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled })
      return { ok: true, enabled: app.getLoginItemSettings().openAtLogin }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })
}

// ─── Ciclo de vida ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  registerIpc()
  buildMenu()

  try {
    if (IS_DEV) {
      // El usuario corre `yarn editor` aparte; aquí solo apuntamos a Vite.
      createWindow(DEV_URL)
    } else {
      const port = await startStandaloneServer()
      createWindow(`http://localhost:${port}`)
    }
  } catch (err) {
    dialog.showErrorBox(
      'No se pudo iniciar Parallax Editor',
      String((err && err.message) || err),
    )
    app.quit()
    return
  }

  app.on('activate', () => {
    // macOS: clic en el dock sin ventanas → recrear.
    if (BrowserWindow.getAllWindows().length === 0) {
      if (IS_DEV) {
        createWindow(DEV_URL)
      } else if (standaloneServer) {
        createWindow(`http://localhost:${standaloneServer.port}`)
      }
    }
  })
})

// macOS: cerrar todas las ventanas NO mata la app (queda en el dock). En el
// resto de plataformas sí salimos.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Cierre limpio del server standalone antes de salir de verdad.
app.on('before-quit', async (event) => {
  if (standaloneServer) {
    event.preventDefault()
    await closeStandaloneServer()
    app.quit()
  }
})

// Señales (p. ej. Ctrl+C en `yarn electron:dev`/`electron:start`).
process.on('SIGINT', () => {
  closeStandaloneServer().finally(() => app.quit())
})
process.on('SIGTERM', () => {
  closeStandaloneServer().finally(() => app.quit())
})
