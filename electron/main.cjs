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

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeImage, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')
const { fixPath } = require('./path-fix.cjs')

// CRÍTICO: corregir el PATH ANTES de cualquier spawn (el server in-process
// lanza `claude`/`git`). Idempotente; no-op nocivo en dev.
fixPath()

const IS_DEV = process.env.ELECTRON_DEV === '1'
const DEV_URL = 'http://localhost:3000'
const PRELOAD = path.join(__dirname, 'preload.cjs')

// Un solo proceso a la vez: dos copias chocarían por el puerto fijo 4317 (y se
// pisarían el localStorage). Si ya hay una corriendo, esta se cierra y enfoca la
// existente (manejado en whenReady para no re-indentar todo el módulo).
const hasSingleInstanceLock = app.requestSingleInstanceLock()

// Blindaje del proceso principal: un error async NO manejado (de claude/git/
// watcher/etc.) NO debe tumbar el proceso — porque el server standalone corre
// IN-PROCESS y se caería con él, dejando al renderer con ERR_CONNECTION_REFUSED
// ("Failed to fetch", deja de guardar). Los registramos y seguimos vivos.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (ignorado para no caer):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (ignorado para no caer):', reason)
})

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
  // PUERTO FIJO (4317): el renderer carga http://localhost:4317, y `localStorage`
  // está atado al ORIGEN (esquema://host:PUERTO). Con un puerto fijo el origen es
  // ESTABLE entre arranques → los workspaces y prefs PERSISTEN. (Antes era
  // `start(0)` = puerto ALEATORIO cada vez → el origen cambiaba → al cerrar y
  // reabrir se "perdía" todo el localStorage.) El single-instance lock evita que
  // dos copias choquen por el puerto; los reintentos cubren el caso de una
  // instancia previa que aún libera el puerto al cerrar.
  const FIXED_PORT = Number(process.env.EDITOR_PORT) || 4317
  for (let attempt = 0; ; attempt++) {
    try {
      standaloneServer = await start(FIXED_PORT)
      return standaloneServer.port
    } catch (err) {
      const inUse = err && err.code === 'EADDRINUSE'
      if (inUse && attempt < 6) {
        await new Promise((r) => setTimeout(r, 400))
        continue
      }
      if (inUse) {
        // Último recurso (raro): algo retiene 4317. Abrimos en un puerto efímero
        // para no dejar al usuario sin la app (esa sesión no comparte el localStorage
        // del puerto fijo, pero al menos arranca.
        standaloneServer = await start(0)
        return standaloneServer.port
      }
      throw err
    }
  }
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
// Menú nativo bilingüe. El renderer reporta su locale activo por IPC
// ('app:set-locale') y el menú se reconstruye con `mt(key)` que lee de este
// dict.
//
// Default temprano: derivamos del idioma del SO (`app.getLocale()`, p. ej.
// 'en-US' / 'es-CO') para que el menú salga acorde durante el medio segundo
// antes de que el renderer cargue y reporte. El renderer SIEMPRE manda
// `app:set-locale` al boot (ver src/i18n/index.ts), así que esta heurística
// solo se ve en el primer arranque y nunca contradice la preferencia guardada
// del usuario — pero evita que la app salga en español cuando el sistema y
// el editor están en inglés (o viceversa).
function osDefaultLocale() {
  try {
    const lang = (app.getLocale() || '').toLowerCase()
    return lang.startsWith('en') ? 'en' : 'es'
  } catch { return 'es' }
}
let currentLocale = osDefaultLocale()
const MENU_STRINGS = {
  es: {
    about: 'Acerca de Parallax Editor', checkUpdates: 'Buscar actualizaciones…',
    loginAtStart: 'Iniciar al encender la Mac', quit: 'Salir',
    file: 'Archivo', fileNew: 'Nuevo proyecto…', fileOpen: 'Abrir / Cambiar de proyecto',
    fileSave: 'Guardar', fileImport: 'Importar imágenes…', fileClose: 'Cerrar proyecto',
    edit: 'Edición', undo: 'Deshacer', redo: 'Rehacer', cut: 'Cortar', copy: 'Copiar',
    paste: 'Pegar', duplicate: 'Duplicar', deleteLbl: 'Eliminar', selectAll: 'Seleccionar todo',
    element: 'Elemento', addElement: 'Agregar elemento', addSection: 'Agregar sección',
    toggleLock: 'Bloquear / Desbloquear', toggleVisible: 'Mostrar / Ocultar',
    git: 'Git', gitPull: 'Traer cambios (pull)', gitHistory: 'Ver historial / commits',
    gitStatus: 'Estado del repositorio',
    publish: 'Publicar', publishS3: 'Publicar a S3', livePreview: 'Vista en vivo',
    openPublished: 'Abrir sitio publicado',
    view: 'Ver', togglePreview: 'Edición / Vista previa', toggleGrid: 'Cuadrícula y guías',
    zoomReset: 'Zoom real', zoomIn: 'Acercar', zoomOut: 'Alejar',
    reload: 'Recargar', forceReload: 'Forzar recarga', devtools: 'Herramientas de desarrollo',
    fullscreen: 'Pantalla completa',
    window: 'Ventana', winClaude: 'Asistente Claude', winResources: 'Recursos',
    winSite: 'Sitio', winTheme: 'Tema',
    language: 'Idioma', langSpanish: 'Español', langEnglish: 'Inglés',
    help: 'Ayuda', helpDiag: 'Diagnóstico…', helpGuide: 'Guía de uso',
    helpDownloads: 'Versión / Descargas',
    pickFolder: 'Elegir carpeta', pickFolderBtn: 'Elegir',
  },
  en: {
    about: 'About Parallax Editor', checkUpdates: 'Check for updates…',
    loginAtStart: 'Launch at login', quit: 'Quit',
    file: 'File', fileNew: 'New project…', fileOpen: 'Open / Switch project',
    fileSave: 'Save', fileImport: 'Import images…', fileClose: 'Close project',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy',
    paste: 'Paste', duplicate: 'Duplicate', deleteLbl: 'Delete', selectAll: 'Select all',
    element: 'Element', addElement: 'Add element', addSection: 'Add section',
    toggleLock: 'Lock / Unlock', toggleVisible: 'Show / Hide',
    git: 'Git', gitPull: 'Pull changes', gitHistory: 'History / commits',
    gitStatus: 'Repository status',
    publish: 'Publish', publishS3: 'Publish to S3', livePreview: 'Live preview',
    openPublished: 'Open published site',
    view: 'View', togglePreview: 'Edit / Preview', toggleGrid: 'Grid and guides',
    zoomReset: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
    reload: 'Reload', forceReload: 'Force reload', devtools: 'Developer tools',
    fullscreen: 'Full screen',
    window: 'Window', winClaude: 'Claude assistant', winResources: 'Resources',
    winSite: 'Site', winTheme: 'Theme',
    language: 'Language', langSpanish: 'Spanish', langEnglish: 'English',
    help: 'Help', helpDiag: 'Diagnostics…', helpGuide: 'User guide',
    helpDownloads: 'Version / Downloads',
    pickFolder: 'Pick a folder', pickFolderBtn: 'Pick',
  },
}
function mt(k) {
  const d = MENU_STRINGS[currentLocale] || MENU_STRINGS.es
  return d[k] || MENU_STRINGS.es[k] || k
}

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
    label: mt('loginAtStart'),
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
      { role: 'about', label: mt('about') },
      mi(mt('checkUpdates'), 'app.checkUpdates'),
      { type: 'separator' },
      makeLoginItem(),
      { type: 'separator' },
      { role: 'quit', label: mt('quit') },
    ],
  }

  const fileMenu = {
    label: mt('file'),
    submenu: [
      mi(mt('fileNew'), 'file.new', 'CmdOrCtrl+N'),
      mi(mt('fileOpen'), 'file.open', 'CmdOrCtrl+O'),
      { type: 'separator' },
      ed(mt('fileSave'), 'file.save', 'CmdOrCtrl+S'),
      ed(mt('fileImport'), 'file.import'),
      { type: 'separator' },
      ed(mt('fileClose'), 'file.close', 'CmdOrCtrl+W'),
    ],
  }

  // Edición: TODO (incluidos los roles nativos undo/cut/copy/paste/selectAll) se
  // deshabilita en el home — solo tiene sentido con un sitio abierto.
  const editMenu = {
    label: mt('edit'),
    submenu: [
      // Custom undo/redo so Cmd+Z routes through `emitMenu('edit.undo')` →
      // the Vue store. role:'undo' was firing the browser's native undo on
      // the focused input only — masking our store undo entirely when an
      // element was selected (the property panel inputs caught the keystroke).
      { ...mi(mt('undo'), 'edit.undo', 'CmdOrCtrl+Z'), enabled: wsCaps.inEditor },
      { ...mi(mt('redo'), 'edit.redo', 'Shift+CmdOrCtrl+Z'), enabled: wsCaps.inEditor },
      { type: 'separator' },
      { role: 'cut', label: mt('cut'), enabled: wsCaps.inEditor },
      { role: 'copy', label: mt('copy'), enabled: wsCaps.inEditor },
      { role: 'paste', label: mt('paste'), enabled: wsCaps.inEditor },
      ed(mt('duplicate'), 'edit.duplicate', 'CmdOrCtrl+D'),
      ed(mt('deleteLbl'), 'edit.delete'),
      { type: 'separator' },
      { role: 'selectAll', label: mt('selectAll'), enabled: wsCaps.inEditor },
    ],
  }

  const elementMenu = {
    label: mt('element'),
    submenu: [
      ed(mt('addElement'), 'element.add'),
      ed(mt('addSection'), 'element.addSection'),
      { type: 'separator' },
      ed(mt('toggleLock'), 'element.toggleLock'),
      ed(mt('toggleVisible'), 'element.toggleVisible'),
    ],
  }

  // Git: requiere estar en un sitio Y que el workspace use git.
  const gitMenu = {
    label: mt('git'),
    submenu: [
      { ...mi(mt('gitPull'), 'git.pull'), enabled: wsCaps.inEditor && wsCaps.useGit },
      { ...mi(mt('gitHistory'), 'git.history'), enabled: wsCaps.inEditor && wsCaps.useGit },
      { ...mi(mt('gitStatus'), 'git.status'), enabled: wsCaps.inEditor && wsCaps.useGit },
    ],
  }

  // Publicar: requiere estar en un sitio. "a S3"/"Abrir publicado" además
  // requieren S3 configurado; "Vista en vivo" solo requiere el sitio abierto.
  const deployMenu = {
    label: mt('publish'),
    submenu: [
      { ...mi(mt('publishS3'), 'deploy.publish'), enabled: wsCaps.inEditor && wsCaps.hasS3 },
      ed(mt('livePreview'), 'deploy.preview'),
      { ...mi(mt('openPublished'), 'deploy.openSite'), enabled: wsCaps.inEditor && wsCaps.hasS3 },
    ],
  }

  const viewMenu = {
    label: mt('view'),
    submenu: [
      ed(mt('togglePreview'), 'view.togglePreview'),
      ed(mt('toggleGrid'), 'view.toggleGrid'),
      { type: 'separator' },
      { role: 'resetZoom', label: mt('zoomReset') },
      { role: 'zoomIn', label: mt('zoomIn') },
      { role: 'zoomOut', label: mt('zoomOut') },
      { type: 'separator' },
      { role: 'reload', label: mt('reload') },
      { role: 'forceReload', label: mt('forceReload') },
      { role: 'toggleDevTools', label: mt('devtools') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: mt('fullscreen') },
    ],
  }

  // Language submenu — sets the renderer locale and reconstructs the menu in
  // place. The radio "checked" state reflects currentLocale.
  const langItem = (code, label) => ({
    label, type: 'radio', checked: currentLocale === code,
    click: () => {
      currentLocale = code
      buildMenu()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:locale-changed', code)
      }
    },
  })
  const windowMenu = {
    label: mt('window'),
    submenu: [
      ed(mt('winClaude'), 'window.claude'),
      ed(mt('winResources'), 'window.resources'),
      ed(mt('winSite'), 'window.site'),
      ed(mt('winTheme'), 'window.theme'),
      { type: 'separator' },
      { label: mt('language'), submenu: [
        langItem('es', mt('langSpanish')),
        langItem('en', mt('langEnglish')),
      ]},
    ],
  }

  // "Ayuda → Diagnóstico" abre la pantalla doctor (canal 'open-doctor' existente).
  const helpMenu = {
    label: mt('help'),
    role: 'help',
    submenu: [
      {
        label: mt('helpDiag'),
        click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('open-doctor') },
      },
      mi(mt('helpGuide'), 'help.guide'),
      mi(mt('helpDownloads'), 'help.downloads'),
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
      title: mt('pickFolder'),
      buttonLabel: mt('pickFolderBtn'),
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

  // Renderer → main locale sync. The Vue LanguageSwitcher posts the new
  // locale here; the menu re-renders with the new labels.
  ipcMain.on('app:set-locale', (_e, locale) => {
    if (locale === 'es' || locale === 'en') {
      currentLocale = locale
      buildMenu()
    }
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
  // Single-instance: si otra copia ya tiene el lock, salimos sin abrir ventana.
  if (!hasSingleInstanceLock) {
    app.quit()
    return
  }
  // Si se intenta abrir una segunda copia, enfocamos la ventana existente.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

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

  // Auto-recuperación tras suspensión (cerrar la laptop "un buen rato" puede
  // dejar el socket del server muerto → ERR_CONNECTION_REFUSED al volver). Al
  // despertar, si el server ya no escucha, lo reiniciamos en el MISMO puerto fijo
  // → la siguiente petición del renderer vuelve a funcionar (sin recargar, para
  // no perder lo que tenga en pantalla). Solo en modo empaquetado (hay server).
  if (!IS_DEV) {
    powerMonitor.on('resume', async () => {
      try {
        const dead = standaloneServer && standaloneServer.server && !standaloneServer.server.listening
        if (dead) {
          await closeStandaloneServer()
          await startStandaloneServer()
          console.log('[main] server reiniciado tras resume')
        }
      } catch (e) {
        console.error('[main] no se pudo reiniciar el server tras resume:', e)
      }
    })
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
