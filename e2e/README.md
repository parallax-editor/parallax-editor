# e2e — editor test harness (self-contained)

Lives INSIDE `parallax-editor`. Drives the system's Chrome with
`playwright-core` and **does not depend on any external user content**: it uses
its own fixtures in `fixtures/` and `enginematrix/fixtures/`.

## Requirements

- System Chrome/Chromium (auto-detected; override with `CHROME_BIN`).
  `playwright-core` deliberately does NOT download browsers.
- For `test:e2e:matrix`: a fresh `dist/` of the engine. When developing
  alongside a sibling checkout of `parallax-engine`, keep `yarn dev` running
  there; otherwise the npm-installed engine's bundled `dist/` is used.
- For `test:e2e` / `test:e2e:save`: the editor running on :3000 (`yarn dev`).

## Commands (from `parallax-editor/`)

```bash
yarn test:e2e:matrix   # OFFLINE: engine render matrix (own ephemeral static server)
yarn test:e2e          # editor on :3000 driven by the suite, against an ephemeral sandbox workspace
yarn test:e2e:save     # Save → persists to disk → reflects in the engine preview
yarn test:e2e:headed   # same as test:e2e with a visible window (HEADLESS=0)
```

## How it avoids touching real content

`harness.cjs` and `suites/save-reflect.cjs` copy the versioned fixtures into a
temp directory (`mkdtemp`), inject that workspace as a **"sandbox"** into the
editor's `localStorage` with `useGit:false` (writes to disk but never does a
git commit) and activate it on the host. When done they delete the temp dir.
The repo tree is never modified and no "sandbox" project ever appears in the
real user's UI.

Output: `shots/<timestamp>/{*.png,report.txt}` (gitignored). Exit 0 = all PASS.

## Structure

```
harness.cjs               editor suite (--suite=editor)
suites/engine-matrix.cjs  OFFLINE engine matrix
suites/save-reflect.cjs   Save → persist → reflect
enginematrix/             static server + mount + engine fixtures
fixtures/content/         demo-mundo / demo-evento (own test content)
```
