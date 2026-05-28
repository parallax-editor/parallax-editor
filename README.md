# parallax-editor

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

Open-source local Illustrator-style editor for parallax sites built on top of [`parallax-engine`](https://github.com/parallax-editor/parallax-engine). Designed to run **only on the user's machine** (never deployed) — it ships an HTTP API that reads/writes content directly on disk, runs `git`, and shells out to `claude -p` for AI-assisted authoring.

> Built end-to-end with [Claude Code](https://claude.com/claude-code).

## Requirements

- Node ≥ 20
- Yarn 1.x
- Optional: `git`, `gh`, the [`claude`](https://github.com/anthropics/claude-code) CLI (only required for the AI chat panel)

`parallax-engine` is installed from npm automatically by `yarn install`; you do
**not** need to clone it.

## Setup

```bash
./bootstrap.sh          # checks prerequisites, clones + installs
# or, in an existing checkout:
yarn install
```

## Run

```bash
yarn editor             # starts the editor at http://localhost:3000
```

When the editor first opens it has **no workspaces configured**. Add yours from
the UI — each workspace points at any folder on disk that holds
`content/<slug>/site.json` files matching the `parallax-engine` schema. The
folder you pick can live anywhere; it doesn't need to sit next to this repo.

## Commands

```bash
yarn editor             # dev server + opens browser (localhost:3000)
yarn dev                # same, without opening the browser
yarn test               # offline smoke test
yarn test:e2e:matrix    # offline engine-render matrix
yarn test:e2e           # editor E2E against a sandbox workspace (needs editor on :3000)

# Local packaging (any branch, no git/GitHub operations)
yarn dist:dir           # quick validation build (no .dmg, ~30s) → dist-electron/mac-*/
yarn dist:mac           # full build: Parallax-Editor-{x64,arm64}.dmg → dist-electron/

# Releasing (only when local build is verified)
yarn release            # bump version + build + create GitHub Release (patch)
yarn release minor      # same, minor bump
yarn release major      # same, major bump
```

**Local packaging vs release:** `yarn dist:dir` / `yarn dist:mac` build the
editor on your machine from **any branch** and never touch git or GitHub —
use them to verify the packaged app works before publishing. Only run
`yarn release` from a clean `main` once you're satisfied; it bumps the
version, tags, pushes, and creates a GitHub Release with both `.dmg`s
attached.

## How it works

`parallax-editor` is a single Vite server. Its middleware (`server/api.ts`) exposes
a REST API that:
- reads/writes `site.json` files in the configured workspace folders
- runs `git` in those folders (`server/git.ts`)
- shells out to `claude -p` with the workspace as cwd (`server/claude.ts`)
- watches files via chokidar and broadcasts changes over WebSocket

The AI chat reuses the engine's authoring contract (`parallax-engine/ai/contract.md`):
the editor bundles it (`scripts/embed-contract.mjs`) and injects it into every
`claude -p` via `--append-system-prompt`, alongside the workspace's component catalog.

## Local development of engine + editor together

The editor depends on `parallax-engine` from npm. To work on both
simultaneously without publishing, use `yarn link` or
[`yalc`](https://github.com/wclr/yalc):

```bash
# in parallax-engine (sibling checkout)
yarn link
yarn dev          # keep the watch build running

# in parallax-editor
yarn link parallax-engine
```

## License

[AGPL-3.0-or-later](./LICENSE). The editor is a network-capable application,
so AGPL applies: anyone who runs a modified version as a network service must
publish their changes under a compatible license. The underlying
[`parallax-engine`](https://github.com/parallax-editor/parallax-engine) library
is GPL-3.0-or-later.
