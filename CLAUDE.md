# parallax-editor

Editor local tipo Illustrator para crear y editar sitios parallax. Solo corre en la maquina de Daniela, nunca se expone a internet.

## Comandos

```bash
yarn editor     # Arranca en http://localhost:3000 (abre browser)
yarn dev        # Lo mismo sin abrir browser
yarn test       # Smoke test
```

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
- Device toggle: desktop (1440x900) / mobile (375x667)
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
