# parallax-editor

Editor local tipo Illustrator para crear y editar sitios parallax. Solo corre en la maquina de Daniela, nunca se expone a internet.

## Comandos

```bash
yarn editor       # Web: arranca en http://localhost:3000 (abre browser)
yarn dev          # Web: lo mismo sin abrir browser
yarn test         # Smoke test
yarn electron:dev # App de escritorio apuntando al dev server :3000 (necesita `yarn editor` aparte)
yarn dist:dir     # Empaqueta la app SIN dmg (rápido, para validar) → dist-electron/mac-arm64/
yarn dist:mac     # Genera el .dmg ad-hoc → dist-electron/Parallax Editor-<v>-arm64.dmg
```

## Empaquetado de escritorio (Electron, Fase 3/4)

La app envuelve el editor en una ventana nativa. Tres modos: **web** (`yarn editor`),
**dev-as-app** (`yarn electron:dev` → carga :3000) y **empaquetada** (`.dmg`). En
modo empaquetado, `electron/main.cjs` arranca el server standalone IN-PROCESS
(`server/standalone.ts` → `start()`), que sirve el SPA de `dist/` + la API + WS sin Vite.

- **`electron/path-fix.cjs`** — corrige `process.env.PATH` al arrancar (apps abiertas
  desde Finder NO ven `/opt/homebrew/bin` etc.), si no `claude`/`git` "no se encuentran".
- **`electron/preload.cjs`** — único puente IPC (contextIsolation ON): diálogo nativo de
  carpeta, auto-inicio al encender, y abrir-doctor desde el menú. El cliente lo consume
  vía `src/composables/useElectron.ts`; en web degrada solo (osascript / no-op).
- **Pantalla doctor** (`src/components/doctor/DoctorHost.vue` + `GET /api/diagnostics`,
  `server/diagnostics.ts`) — primer arranque / menú "Ayuda → Diagnóstico": valida
  git/claude/aws + toggle de auto-inicio.
- **`electron-builder.yml`** — `.dmg` ad-hoc (sin firma; abrir con clic derecho → Abrir).
  `asar:false` (binarios nativos sueltos = más robusto). Solo copia `dependencies` de
  producción → `esbuild`/`chokidar`/`ws` viven en dependencies (el server bundleado los
  requiere en runtime); `parallax-engine` va en devDependencies (se empotra en los bundles).
- **Contexto de Claude empaquetado**: el contrato del engine se hornea en
  `server/contract.generated.ts` (`scripts/embed-contract.mjs`, pre-hooks de build/dev) y
  viaja dentro del `.dmg` — la máquina NO necesita el repo del engine. Ver CLAUDE.md raíz.

## Arquitectura

Un solo servidor Vite con API middleware (no Express separado):
- Frontend: Vue 3 + Vite + vue-router (SPA)
- API: `/api/*` rutas servidas por middleware de Vite (`server/api.ts`)
- WebSocket: `/__ws` para notificaciones de cambio de archivos (chokidar)
- Assets: `/content/(eventos|site)/<slug>/*` sirve imagenes/audio/video de repos vecinos

## Estructura

```
server/
  api.ts          — middleware principal, ruteo REST
  projects.ts     — CRUD de site.json en repos vecinos
  git.ts          — commit, push, log, revert via child_process
  claude.ts       — ejecuta claude -p via shell
  watcher.ts      — chokidar + WebSocket broadcast

src/
  stores/editor.ts          — estado central (site, seleccion, undo stack, zoom, tool)
  views/ProjectSelector.vue — pantalla inicial: elegir proyecto
  views/EditorView.vue      — layout 3 paneles
  components/canvas/        — canvas con preview real del engine + selection overlay + smart guides
  components/layers/        — panel izquierdo: arbol de capas con drag reorder
  components/properties/    — panel derecho: props dinamicas + animaciones
  components/toolbar/       — barra superior: tools, device toggle, zoom, save, publish
  components/claude/        — input para Claude + importador PNGs
  components/git/           — historial + boton publicar
  composables/              — useApi, useCanvas, useSelection, useShortcuts, useWebSocket
```

## API Routes

```
GET  /api/projects                        — lista proyectos
GET  /api/projects/:type/:slug            — lee site.json
PUT  /api/projects/:type/:slug            — escribe site.json
POST /api/projects/:type                  — crear nuevo
POST /api/projects/:type/:slug/duplicate  — duplicar
DEL  /api/projects/:type/:slug            — eliminar
GET  /api/git/:type/log                   — historial
POST /api/git/:type/commit                — auto-commit
POST /api/git/:type/push                  — publicar
POST /api/claude                          — ejecutar claude -p
```

`:type` = `eventos` | `site` (mapea a repo vecino).

## Features

- Canvas con preview real del engine (ParallaxSite)
- Selection overlay: bounding box + 8 handles resize + handle rotacion
- Drag to move, drag handles to resize, shift para proporciones
- Smart guides (alineacion con otros elementos)
- Snap-to-grid toggle
- Layers panel: arbol sections > layers > elements, drag reorder
- Properties panel: dinamico segun seleccion (section/layer/element)
- Device toggle: desktop (1440x900) / mobile (390x844)
- Zoom: cmd+scroll, cmd+/-  Pan: space+drag
- Keyboard shortcuts: V/H (tools), cmd+Z/shift+cmd+Z (undo/redo), cmd+S (save), cmd+D (duplicate), delete
- Claude: input libre → shell exec → file watcher refresca
- Git: auto-commit en save, boton Publicar con confirmacion, historial
- WebSocket: detecta cambios externos en site.json y recarga

## Relacion con repos vecinos

Lee/escribe en:
- `../daniela-reyes-eventos/content/*/site.json`
- `../daniela-reyes-site/content/portafolio/*/site.json`

Ejecuta git en esos repos. Ejecuta claude -p con el cwd del repo correspondiente.

## No incluir

- Auth, multiusuario, deploy desde editor
- Tabs multiples (un archivo a la vez)
- No exponer a internet

## Git hooks

Hook `pre-commit` versionado en `hooks/pre-commit`, activado con `git config --local core.hooksPath hooks` (config local del repo; el hook vive en el árbol). En un `git commit` humano corre `yarn lint` **si** existe el script `lint` en `package.json` (hoy no existe → se omite con nota) y `yarn test` (smoke, offline). Cualquier fallo → commit bloqueado con mensaje claro en español. Emergencia: `git commit --no-verify`.

**El auto-commit-on-save bypasea este hook por diseño.** `server/git.ts` → `gitCommit()` (la ruta por la que pasan Cmd+S, el botón Guardar y el timer de autosave, desde `EditorView.save()`) emite `git commit --no-verify` **en los repos de contenido vecinos** (`daniela-reyes-eventos` / `daniela-reyes-site`). Sin eso, cada autosave (~cada 1.5s mientras se edita) correría toda la suite offline de ese repo = inusable, y venía contaminando los repos de contenido con corridas de test pesadas toda la sesión. La correctitud del contenido ya está cubierta: `validateSite` del engine corre al cargar y el flujo **Publicar** (`GitPanel.vue`) revalida el schema antes del push (task #44); el push (`gitPush`) no pasa por pre-commit. Si tocas `gitCommit`/`gitPush`, conserva `--no-verify`.
