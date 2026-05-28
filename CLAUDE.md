# parallax-editor

Local Illustrator-style editor for parallax sites. Designed to run ONLY on the user's machine, never exposed to the internet.

## Commands

```bash
yarn editor          # web: starts at http://localhost:3000 (opens browser)
yarn dev             # web: same, without opening the browser
yarn test            # smoke test (offline)
yarn test:e2e:matrix # engine render matrix E2E (OFFLINE, self-contained) — see "## E2E"
yarn test:e2e        # editor E2E (requires `yarn dev` running on :3000)
yarn electron:dev    # desktop app pointing at the :3000 dev server (needs `yarn editor` running separately)
yarn dist:dir        # packages the app WITHOUT dmg (fast, for validation) → dist-electron/mac-arm64/
yarn dist:mac        # builds the ad-hoc .dmg → dist-electron/Parallax Editor-<v>-arm64.dmg
```

## E2E (`e2e/`, self-contained)

The E2E harness lives INSIDE this repo (`e2e/`) so the editor is
**self-contained** and does NOT depend on any external workspace content. It
uses `playwright-core` (devDependency → never packaged in the `.dmg`) driving
the system's Chrome; it does not download browsers.

- **`yarn test:e2e:matrix`** (`e2e/suites/engine-matrix.cjs` + `e2e/enginematrix/`)
  — engine render matrix, **OFFLINE and self-contained**: spins up its own
  ephemeral static server and mounts the BUILT `<ParallaxSite>` against its own
  fixtures (`e2e/enginematrix/fixtures/*.json`). Only needs a fresh `dist/`
  from the engine. When developing alongside a sibling checkout of
  `parallax-engine`, `yarn dev` over there keeps the dist fresh; otherwise the
  npm-installed version is used. No dev server required. ~219 checks (anchors,
  positions, animations, transitions, v1.1 views, no-bleed, etc.).
- **`yarn test:e2e`** (`e2e/harness.cjs --suite=editor`) — drives the editor on
  :3000 **as a real user would**, but against an ephemeral **"sandbox"**
  workspace: it copies the versioned fixtures
  (`e2e/fixtures/content/{demo-mundo,demo-evento}/`) into a `mkdtemp` temp dir,
  injects that workspace into the editor's `localStorage` (`useGit:false` →
  writes to disk but NEVER does a git commit), activates it on the host, runs
  the checks, and deletes the temp dir. **The repo tree is never touched** and
  no "sandbox" project ever shows up in the real user's UI.
- **`yarn test:e2e:save`** (`e2e/suites/save-reflect.cjs`) — Save → persists to
  disk → reflects in the real engine preview, also against the sandbox.
- Fixtures (`e2e/fixtures/content/`) ARE versioned; per-run screenshots
  (`e2e/shots/`) are in `.gitignore`. The engine render is no longer tested
  against live sites: `test:e2e:matrix` covers that.

## Desktop packaging (Electron)

The app wraps the editor in a native window. Three modes: **web** (`yarn editor`),
**dev-as-app** (`yarn electron:dev` → loads :3000), and **packaged** (`.dmg`). In
packaged mode, `electron/main.cjs` starts the standalone server IN-PROCESS
(`server/standalone.ts` → `start()`), which serves the SPA from `dist/` + the API + WS without Vite.

- **`electron/path-fix.cjs`** — fixes `process.env.PATH` at startup (apps launched
  from Finder do NOT see `/opt/homebrew/bin` etc.); otherwise `claude`/`git` "are not found".
- **`electron/preload.cjs`** — sole IPC bridge (contextIsolation ON): native folder
  dialog, login-item auto-start, and open-doctor from the menu. The client consumes
  it via `src/composables/useElectron.ts`; on the web it degrades gracefully (osascript / no-op).
- **Doctor screen** (`src/components/doctor/DoctorHost.vue` + `GET /api/diagnostics`,
  `server/diagnostics.ts`) — first launch / "Help → Diagnostics" menu: validates
  git/claude/aws + auto-start toggle.
- **`electron-builder.yml`** — ad-hoc `.dmg` (unsigned; open with right-click → Open).
  `asar:false` (loose native binaries = more robust). Only copies production
  `dependencies` → `esbuild`/`chokidar`/`ws` live in dependencies (the bundled server
  requires them at runtime); `parallax-engine` lives in devDependencies (embedded in the bundles).
- **Packaged Claude context**: the engine's contract is baked into
  `server/contract.generated.ts` (`scripts/embed-contract.mjs`, build/dev pre-hooks) and
  ships inside the `.dmg` — the machine does NOT need the engine repo. See root CLAUDE.md.

## Architecture

A single Vite server with API middleware (no separate Express):
- Frontend: Vue 3 + Vite + vue-router (SPA)
- API: `/api/*` routes served by Vite middleware (`server/api.ts`)
- WebSocket: `/__ws` for file-change notifications (chokidar)
- Assets: `/content/<workspace>/<slug>/*` serves images/audio/video from the active workspace

## Structure

```
server/
  api.ts          — main middleware, REST routing
  projects.ts     — CRUD on site.json in workspace folders
  git.ts          — commit, push, log, revert via child_process
  claude.ts       — runs claude -p via shell
  watcher.ts      — chokidar + WebSocket broadcast

src/
  stores/editor.ts          — central state (site, selection, undo stack, zoom, tool)
  views/ProjectSelector.vue — initial screen: pick a project
  views/EditorView.vue      — 3-pane layout
  components/canvas/        — canvas with real engine preview + selection overlay + smart guides
  components/layers/        — left panel: layer tree with drag-reorder
  components/properties/    — right panel: dynamic props + animations
  components/toolbar/       — top bar: tools, device toggle, zoom, save, publish
  components/claude/        — input for Claude + PNG importer
  components/git/           — history + publish button
  composables/              — useApi, useCanvas, useSelection, useShortcuts, useWebSocket
```

## API Routes

```
GET  /api/projects                        — list projects
GET  /api/projects/:type/:slug            — read site.json
PUT  /api/projects/:type/:slug            — write site.json
POST /api/projects/:type                  — create new
POST /api/projects/:type/:slug/duplicate  — duplicate
DEL  /api/projects/:type/:slug            — delete
GET  /api/git/:type/log                   — history
POST /api/git/:type/commit                — auto-commit
POST /api/git/:type/push                  — publish
POST /api/claude                          — run claude -p
```

`:type` = id of a configured workspace (resolves to the workspace's repo + content root on the host).

## Features

- Canvas with real engine preview (ParallaxSite)
- Selection overlay: bounding box + 8 resize handles + rotation handle
- Drag to move, drag handles to resize, shift to keep aspect ratio
- Smart guides (alignment with other elements)
- Snap-to-grid toggle
- Layers panel: sections > layers > elements tree, drag-reorder
- Properties panel: dynamic based on selection (section/layer/element)
- Device toggle: desktop (1440x900) / mobile (390x844)
- Zoom: cmd+scroll, cmd+/-  Pan: space+drag
- Keyboard shortcuts: V/H (tools), cmd+Z/shift+cmd+Z (undo/redo), cmd+S (save), cmd+D (duplicate), delete
- Claude: free-form input → shell exec → file watcher refreshes
- Git: auto-commit on save, Publish button with confirmation, history
- WebSocket: detects external changes to site.json and reloads

## Workspaces

The editor ships with no default workspaces; the user adds them from the UI via
the native folder picker (`server/fs.ts`). A workspace can be ANY folder on
disk — it does NOT need to sit next to this repo. The folder must follow the
flat `<workspace>/content/<slug>/site.json` layout. The editor reads/writes
those `site.json` files, runs git in the folder (if `useGit:true`), and
launches `claude -p` with the workspace folder as cwd.

## Out of scope

- Auth, multi-user, deploying from the editor
- Multiple tabs (one file at a time)
- Exposing the editor to the internet

## Git hooks

Pre-commit hook versioned in `hooks/pre-commit`, activated with `git config --local core.hooksPath hooks` (local repo config; the hook lives in the tree). On a human `git commit` it runs `yarn lint` **if** the `lint` script exists in `package.json` (today it does not → skipped with a note) and `yarn test` (smoke, offline). Any failure → commit blocked with a clear message. Emergency: `git commit --no-verify`.

**The auto-commit-on-save bypasses this hook by design.** `server/git.ts` → `gitCommit()` (the path Cmd+S, the Save button, and the autosave timer take from `EditorView.save()`) emits `git commit --no-verify` **in the active workspace's repo**. Without that, every autosave (~every 1.5s while editing) would run the full offline test suite of that repo = unusable, and was polluting content repos with heavy test runs throughout the session. Content correctness is already covered: the engine's `validateSite` runs at load time and the **Publish** flow (`GitPanel.vue`) re-validates the schema before the push (task #44); push (`gitPush`) does not go through pre-commit. If you touch `gitCommit`/`gitPush`, keep `--no-verify`.

## Push discipline (MANDATORY)

Before `git push` of anything that touches the CI surface — workflows
(`.github/workflows/*`), `package.json`, the landing's `<link
rel="stylesheet">` engine version, or the matrix's path resolution —
**reproduce the CI shape locally and confirm it passes**. The user has
been blocked by GitHub abuse detection from push-fail-push loops; one
green run on `main` beats five red ones.

Concretely:

- `yarn test`, `yarn test:e2e:matrix`, and `yarn test:e2e` (with `yarn
  dev` running) all green locally. For matrix changes that affect path
  resolution, simulate CI by hiding the sibling `parallax-engine/`
  checkout (rename its `node_modules` + `dist`) and re-running — the
  suite must still pass against the npm-installed engine.
- For Dependabot major bumps, `yarn install` + the full suite locally
  BEFORE merging. Don't trust "CI ✅ on the PR" alone for majors that
  could affect bundling or Node engine compat (vue-i18n@11 needs Node
  22; the workflow's `node-version` has to match).
- For workflow `.yml` edits, read each `steps.<id>.outputs.*` reference
  and make sure the upstream step has the matching `id:`. The
  `setup-chrome` step needs `id: setup-chrome` for its `chrome-path`
  output to be readable downstream.
- After bumping the engine version in `package.json`, also update the
  `<link rel="stylesheet" href="https://esm.sh/...engine@X.Y.Z/style.css">`
  in `landing/*.html` AND the `ENGINE_VERSION` constant in the inline
  module script. Mismatched versions cause silent style failures (the
  scoped CSS hash from one version doesn't match the runtime from
  another → `parallax-site--fit-container` is unstyled → hero collapses
  to 0px).

Batch related changes into one commit + one push. If you need a quick
iteration loop, push to a feature branch first.
