<div align="center">

<img src="landing/icon.png" width="120" height="120" alt="Parallax Editor logo" />

# parallax-editor

**Local Illustrator-style desktop editor for parallax websites.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-d6c7a6.svg)](./LICENSE)
[![CI](https://github.com/parallax-editor/parallax-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/parallax-editor/parallax-editor/actions/workflows/ci.yml)
[![Pages](https://github.com/parallax-editor/parallax-editor/actions/workflows/pages.yml/badge.svg)](https://parallax-editor.github.io/parallax-editor/editor.html)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-d6c7a6)](https://claude.com/claude-code)

[**Download**](https://github.com/parallax-editor/parallax-editor/releases/latest) · [**Landing**](https://parallax-editor.github.io/parallax-editor/editor.html) · [**Engine**](https://github.com/parallax-editor/parallax-editor)

</div>

---

> **The editor runs only on your machine.** It's a single Vite server (also
> packaged as an Electron app) that reads/writes content directly on disk,
> runs `git` for you, and shells out to `claude -p` for AI-assisted authoring.
> Nothing is uploaded anywhere unless you press **Publish**.

Parallax Editor is the authoring companion for the
[Parallax Engine](https://github.com/parallax-editor/parallax-engine).
Compose immersive scenes by dragging layers on a real-engine preview, edit
content in dynamic property panels, ask Claude to "make the background
darker and add an RSVP form at the end", commit with one keystroke, publish
to S3 / Netlify / any static host.

> _Screencast placeholder — record `docs/editor-demo.gif` (≤ 5 MB) and link
> it here so the editor sells itself above the fold._

## Features

- 🎨 **Real-engine canvas preview** — what you see is the actual rendered
  scene, not a mock.
- 🖱️ **Selection overlay** — bounding box, 8 resize handles, rotation handle.
  Drag to move; shift to keep aspect; smart guides snap to other elements.
- 🌳 **Layer tree** — sections → layers → elements, drag-reorder, clipboard
  paste, group/ungroup.
- ⚙️ **Dynamic property panel** — fields adapt to the selection
  (section / layer / element / animation), with helpful inputs (color
  swatches, gradient builder, size modes, ease pickers).
- 📱 **Device toggle** — desktop (1440×900) / mobile (390×844), or fully
  independent `views` (v1.1 schema).
- 🤖 **Claude built in** — natural-language edits in any language. The
  editor injects the engine's authoring contract + the workspace's
  component catalog so the AI never invents schema.
- 🕓 **Git native** — auto-commit on save (with `--no-verify`), Publish
  button reviews schema, pushes, syncs S3 in one step.
- 📡 **WebSocket file watcher** — external edits (manual or Claude) hot-reload
  the canvas without losing selection.
- 🎯 **No internet exposure** — designed to run only on the user's machine.
  AGPL-3.0 enforces source disclosure if anyone tries to ship it as a SaaS.

## Quick start

### Requirements

- Node ≥ 20
- Yarn 1.x
- Optional: `git`, `gh`, and the
  [`claude`](https://github.com/anthropics/claude-code) CLI (only required
  for the AI chat panel)

The editor depends on
[`@parallax-editor/parallax-engine`](https://www.npmjs.com/package/@parallax-editor/parallax-engine)
from npm; `yarn install` pulls it automatically. You do **not** need to
clone the engine.

### Install + run

```bash
git clone https://github.com/parallax-editor/parallax-editor.git
cd parallax-editor
yarn install
yarn editor
```

The editor opens at <http://localhost:3000>. On first run it has **no
workspaces configured** — add one from the UI by clicking **➕ Workspace**
and selecting any folder on disk that follows the flat layout:

```
<your-workspace>/
  content/
    <slug>/
      site.json          # site config (validated against the engine schema)
      images/            # assets
      audio/             # ...
      video/
      fonts/
```

A workspace can live anywhere on your machine — it does not need to sit
next to the editor.

### Build the desktop app

```bash
yarn dist:dir           # quick validation (no .dmg, ~30s) → dist-electron/mac-*/
yarn dist:mac           # full build → dist-electron/Parallax-Editor-{x64,arm64}.dmg
```

Both `.dmg` files are **ad-hoc unsigned** today. Notarized signing
(Apple Developer ID + `notarytool`) is on the roadmap — at that point
the first-open dance below goes away. Until then:

When you open the installed `.app` for the first time, macOS may show:

> **"Parallax Editor" is damaged and can't be opened. You should move it to the Trash.**

That message is misleading — the app isn't damaged. It's Gatekeeper
refusing an ad-hoc-signed app that the browser tagged with
`com.apple.quarantine` on download. Clear the flag once and the app
opens normally afterwards:

```bash
xattr -dr com.apple.quarantine "/Applications/Parallax Editor.app"
```

(adjust the path if you moved the `.app` elsewhere). After clearing
quarantine, double-click as normal. macOS may still show a less
alarming "downloaded from Internet — are you sure?" prompt the first
time — that one is harmless: right-click the `.app` → **Open** once
to confirm and it won't ask again.

## Commands

```bash
yarn editor             # dev server + opens browser (localhost:3000)
yarn dev                # same, without opening the browser
yarn test               # offline smoke test
yarn test:e2e:matrix    # offline engine render matrix (no editor required)
yarn test:e2e           # editor E2E against an ephemeral sandbox workspace
yarn dist:mac           # build macOS .dmg via electron-builder
yarn release            # bump + build + GitHub Release (maintainer only)
```

`yarn dist:dir` and `yarn dist:mac` work from **any branch** and never
touch git or GitHub — use them to verify a packaged build before
releasing. `yarn release` is the only command that mutates GitHub state.

## How it works

A single Vite server with API middleware (no separate Express):

- **Frontend** — Vue 3 + Vite + vue-router (SPA, `src/`)
- **API** — `/api/*` routes served by Vite middleware (`server/api.ts`)
- **WebSocket** — `/__ws` for file-change broadcasts (chokidar)
- **AI chat** — `claude -p` runs with `--append-system-prompt`:
  - the engine's [`ai/contract.md`](https://github.com/parallax-editor/parallax-engine/blob/main/ai/contract.md)
    is baked into the editor's bundle by `scripts/embed-contract.mjs`,
  - the workspace's component catalog (loaded from `parallax.config.ts`)
    is appended at runtime.

When packaged as a desktop app, the same server boots in-process and
serves the SPA from `dist/` — no Vite, no external dependencies.

## Workspaces are arbitrary folders

The editor doesn't ship default workspaces. Pick **any** folder from the
native folder dialog (`server/fs.ts`). The folder doesn't need to be a
git repo — uncheck "Use version control" when creating the workspace to
get plain disk writes + S3 publish only.

## Development & contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). To iterate on the editor and
engine simultaneously, link the engine locally:

```bash
# in parallax-engine (sibling checkout)
yarn link
yarn dev

# in parallax-editor
yarn link @parallax-editor/parallax-engine
```

## License

[AGPL-3.0-or-later](./LICENSE). The editor is a network-capable
application, so AGPL applies: anyone who runs a modified version as a
network service must publish their changes under a compatible license.
The underlying
[`@parallax-editor/parallax-engine`](https://github.com/parallax-editor/parallax-engine)
library is GPL-3.0-or-later.

## Acknowledgments

- Built end-to-end with [Claude Code](https://claude.com/claude-code).
- Renders via [`@parallax-editor/parallax-engine`](https://github.com/parallax-editor/parallax-engine).
- Packaged with [electron-builder](https://www.electron.build/).
- Driven by [Vite](https://vitejs.dev), [Vue 3](https://vuejs.org),
  [Pinia](https://pinia.vuejs.org), and [Playwright](https://playwright.dev)
  (E2E).
