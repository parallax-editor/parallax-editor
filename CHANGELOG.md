# Changelog

All notable changes to `parallax-editor` are documented here. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Server-side workspace SFC bundler** (`server/sfcBundler.ts` + the new
  `GET /api/workspaces/:id/components/:name.js` route). `CustomComponentHost`
  now imports workspace custom components dynamically over HTTP instead of
  through Vite's build-time `import.meta.glob` — so workspaces hosted in
  ANY folder on disk render their components in the canvas preview, not
  just sibling-cloned ones. Per-file mtime cache + file watcher
  invalidation + `component-changed` WebSocket broadcast trigger a hot
  re-import without a full editor reload.
- `@vue/compiler-sfc` added as a direct dep (was transitive).
- **i18n infrastructure** with vue-i18n (`src/i18n/`, `src/locales/{es,en}.ts`,
  `LanguageSwitcher.vue`). Default locale `es` (preserves the current UX);
  `LanguageSwitcher` mounted in the workspace selector header. String
  migration is intentionally staged for follow-up PRs to land in
  coordinated chunks — see `.github/PLANNED_FOLLOWUPS/i18n.md`.

### Changed
- Engine dep bumped to `@parallax-editor/parallax-engine ^0.1.1`
  (auto-normalize, `fit` prop, defensive iteration).
- Landing hero now uses the engine's `fit="container"` prop directly — no
  more CSS overrides + no `validateSite` wrapper needed.

## [0.1.8] — 2026-05-27

First public open-source release on GitHub under the `parallax-editor` org.

### Added
- In-repo E2E harness (`e2e/`) — Playwright-driven, self-contained sandbox
  workspace. Tests no longer depend on any external content.
- Open Graph meta tags + favicons + manifest for both landing pages.
- GitHub Pages deployment via Actions for `landing/`.
- GitHub Actions CI on push/PR + offline E2E matrix job.
- CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, issue/PR templates,
  Dependabot config, CHANGELOG.md.
- Stable artifact names (`Parallax-Editor-{x64,arm64}.dmg`) so
  `/releases/latest/download/` URLs work without per-release edits.
- `yarn release` rewritten to publish via `gh release create` instead of S3.
- Live parallax-engine hero on the landing page (the engine renders its
  own landing instead of a CSS mock).

### Changed
- License: **AGPL-3.0-or-later** (was UNLICENSED).
- Engine dependency moved from `link:../parallax-engine` to the published
  npm package `@parallax-editor/parallax-engine`.
- Documentation translated to English.
- Workspaces no longer ship with hardcoded defaults — the user picks any
  folder from the native folder dialog.
- README rewritten with badges, install/usage walkthrough, and the
  command matrix (local packaging vs release).

### Removed
- S3-based landing deploy (`scripts/deploy-landing.mjs`).
- All references to the original private contributor and sibling consumer
  repos (the editor is now agnostic about workspace location).

[Unreleased]: https://github.com/parallax-editor/parallax-editor/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/parallax-editor/parallax-editor/releases/tag/v0.1.8
