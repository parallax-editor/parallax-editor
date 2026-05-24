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

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeImage } = require('electron')
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
/** ¿El editor tiene cambios sin guardar? Lo reporta el renderer (IPC
 *  'editor:dirty'); el main avisa al cerrar la ventana para no perder trabajo. */
let editorDirty = false
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

  // Aviso al cerrar con cambios SIN GUARDAR (X de la ventana / Cmd+W). El
  // diálogo es SÍNCRONO porque el handler de 'close' debe decidir en el momento
  // si cancela el cierre; uno asíncrono dejaría cerrar igual. Si el usuario
  // confirma salir, destruimos la ventana (no re-pasa por 'close').
  mainWindow.on('close', (e) => {
    if (!editorDirty) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancelar', 'Salir sin guardar'],
      defaultId: 0,
      cancelId: 0,
      title: 'Cambios sin guardar',
      message: 'Tienes cambios sin guardar',
      detail: 'Si cierras ahora se perderá lo que no hayas guardado. ¿Salir de todas formas?',
    })
    if (choice === 1) {
      editorDirty = false
      mainWindow.destroy()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(loadTarget)

  if (IS_DEV) {
    mainWindow.webContents.openDevTools()
  }
}

// ─── Menú nativo (estilo Illustrator) ──────────────────────────────────────────
// Los ítems con `role` usan acciones nativas de Electron (deshacer/zoom/etc.).
// Los ítems de la app mandan un id por IPC (`menu:action`) que el renderer
// despacha (ver src/composables/useMenu.ts + App.vue/EditorView.vue).
function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:action', action)
}

// Capacidades reportadas por el renderer (IPC 'workspace:capabilities').
// Gobiernan qué ítems de menú van habilitados:
//   • inEditor → ¿estoy DENTRO de un sitio (ruta /edit)? Si no (home/selector de
//     workspaces), se deshabilitan Guardar/Importar, Edición, Elemento, Git,
//     Publicar, Ver y Ventana — no tienen sentido sin un sitio abierto.
//   • useGit   → menú Git (pull/historial/estado).
//   • hasS3    → Publicar a S3 / Abrir sitio publicado.
// inEditor arranca en false (la app abre en el selector); useGit/hasS3 en true
// hasta que el renderer reporte (evita parpadeo). El menú se reconstruye en cada
// reporte.
let wsCaps = { useGit: true, hasS3: true, inEditor: false }

function buildMenu() {
  const isMac = process.platform === 'darwin'
  // Ítem que dispara una acción de app por IPC.
  const mi = (label, action, accelerator) => ({ label, accelerator, click: () => sendMenu(action) })
  // Ítem que SOLO tiene sentido con un sitio abierto (ruta /edit): se deshabilita
  // en el home/selector de workspaces.
  const ed = (label, action, accelerator) => ({ ...mi(label, action, accelerator), enabled: wsCaps.inEditor })
  // Checkbox "Iniciar al encender" (fresco cada vez para no compartir objeto).
  const makeLoginItem = () => ({
    label: 'Iniciar al encender la Mac',
    type: 'checkbox',
    checked: (() => { try { return app.getLoginItemSettings().openAtLogin } catch { return false } })(),
    click: (item) => {
      try {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        item.checked = app.getLoginItemSettings().openAtLogin
      } catch (err) {
        console.error('[electron] No se pudo cambiar el inicio automático:', err)
      }
    },
  })

  const appMenu = {
    label: app.name,
    submenu: [
      { role: 'about', label: 'Acerca de Parallax Editor' },
      mi('Buscar actualizaciones…', 'app.checkUpdates'),
      { type: 'separator' },
      makeLoginItem(),
      { type: 'separator' },
      { role: 'quit', label: 'Salir' },
    ],
  }

  const fileMenu = {
    label: 'Archivo',
    submenu: [
      mi('Nuevo proyecto…', 'file.new', 'CmdOrCtrl+N'),
      mi('Abrir / Cambiar de proyecto', 'file.open', 'CmdOrCtrl+O'),
      { type: 'separator' },
      ed('Guardar', 'file.save', 'CmdOrCtrl+S'),
      ed('Importar imágenes…', 'file.import'),
      { type: 'separator' },
      ed('Cerrar proyecto', 'file.close', 'CmdOrCtrl+W'),
    ],
  }

  // Edición: TODO (incluidos los roles nativos undo/cut/copy/paste/selectAll) se
  // deshabilita en el home — solo tiene sentido con un sitio abierto.
  const editMenu = {
    label: 'Edición',
    submenu: [
      { role: 'undo', label: 'Deshacer', enabled: wsCaps.inEditor },
      { role: 'redo', label: 'Rehacer', enabled: wsCaps.inEditor },
      { type: 'separator' },
      { role: 'cut', label: 'Cortar', enabled: wsCaps.inEditor },
      { role: 'copy', label: 'Copiar', enabled: wsCaps.inEditor },
      { role: 'paste', label: 'Pegar', enabled: wsCaps.inEditor },
      ed('Duplicar', 'edit.duplicate', 'CmdOrCtrl+D'),
      ed('Eliminar', 'edit.delete'),
      { type: 'separator' },
      { role: 'selectAll', label: 'Seleccionar todo', enabled: wsCaps.inEditor },
    ],
  }

  const elementMenu = {
    label: 'Elemento',
    submenu: [
      ed('Agregar elemento', 'element.add'),
      ed('Agregar sección', 'element.addSection'),
      { type: 'separator' },
      ed('Bloquear / Desbloquear', 'element.toggleLock'),
      ed('Mostrar / Ocultar', 'element.toggleVisible'),
    ],
  }

  // Git: requiere estar en un sitio Y que el workspace use git.
  const gitMenu = {
    label: 'Git',
    submenu: [
      { ...mi('Traer cambios (pull)', 'git.pull'), enabled: wsCaps.inEditor && wsCaps.useGit },
      { ...mi('Ver historial / commits', 'git.history'), enabled: wsCaps.inEditor && wsCaps.useGit },
      { ...mi('Estado del repositorio', 'git.status'), enabled: wsCaps.inEditor && wsCaps.useGit },
    ],
  }

  // Publicar: requiere estar en un sitio. "a S3"/"Abrir publicado" además
  // requieren S3 configurado; "Vista en vivo" solo requiere el sitio abierto.
  const deployMenu = {
    label: 'Publicar',
    submenu: [
      { ...mi('Publicar a S3', 'deploy.publish'), enabled: wsCaps.inEditor && wsCaps.hasS3 },
      ed('Vista en vivo', 'deploy.preview'),
      { ...mi('Abrir sitio publicado', 'deploy.openSite'), enabled: wsCaps.inEditor && wsCaps.hasS3 },
    ],
  }

  const viewMenu = {
    label: 'Ver',
    submenu: [
      ed('Edición / Vista previa', 'view.togglePreview'),
      ed('Cuadrícula y guías', 'view.toggleGrid'),
      { type: 'separator' },
      { role: 'resetZoom', label: 'Zoom real' },
      { role: 'zoomIn', label: 'Acercar' },
      { role: 'zoomOut', label: 'Alejar' },
      { type: 'separator' },
      { role: 'reload', label: 'Recargar' },
      { role: 'forceReload', label: 'Forzar recarga' },
      { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Pantalla completa' },
    ],
  }

  const windowMenu = {
    label: 'Ventana',
    submenu: [
      ed('Asistente Claude', 'window.claude'),
      ed('Recursos', 'window.resources'),
      ed('Sitio', 'window.site'),
      ed('Tema', 'window.theme'),
    ],
  }

  // "Ayuda → Diagnóstico" abre la pantalla doctor (canal 'open-doctor' existente).
  const helpMenu = {
    label: 'Ayuda',
    role: 'help',
    submenu: [
      {
        label: 'Diagnóstico…',
        click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('open-doctor') },
      },
      mi('Guía de uso', 'help.guide'),
      mi('Versión / Descargas', 'help.downloads'),
    ],
  }

  const template = []
  if (isMac) template.push(appMenu)
  template.push(fileMenu, editMenu, elementMenu, gitMenu, deployMenu, viewMenu, windowMenu, helpMenu)

  // No-mac: sin appMenu → metemos "Iniciar al encender" + Salir al final de Archivo.
  if (!isMac) {
    fileMenu.submenu.push({ type: 'separator' }, makeLoginItem(), { role: 'quit', label: 'Salir' })
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

  // El renderer reporta las capacidades del workspace ACTIVO (useGit / hasS3) al
  // cargar y cada vez que cambia de workspace. Reconstruimos el menú para
  // habilitar/deshabilitar Git y Publicar según corresponda.
  ipcMain.on('workspace:capabilities', (_e, caps) => {
    wsCaps = {
      useGit: !caps || caps.useGit !== false,
      hasS3: !!(caps && caps.hasS3),
      inEditor: !!(caps && caps.inEditor),
    }
    buildMenu()
  })

  // El renderer reporta cambios sin guardar (para el aviso al cerrar la ventana).
  ipcMain.on('editor:dirty', (_e, dirty) => {
    editorDirty = !!dirty
  })
}

// Ícono del Dock en macOS. El ícono de electron-builder SOLO aplica a la app
// empaquetada; en `electron:dev` (binario crudo de Electron) el Dock muestra el
// átomo por defecto. Aquí lo seteamos en runtime con el PÆ. En la app empaquetada
// ../build no existe (es buildResource, no va dentro del .app) → se omite y manda
// el .icns empotrado.
function setDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    const iconPath = path.resolve(__dirname, '..', 'build', 'icon-1024.png')
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath)
      if (!img.isEmpty()) app.dock.setIcon(img)
    }
  } catch {
    /* no-op: el ícono es cosmético, no debe tumbar el arranque */
  }
}

// ─── Ciclo de vida ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setDockIcon()
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
