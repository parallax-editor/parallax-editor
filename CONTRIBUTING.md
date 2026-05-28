# Contributing to parallax-editor

Thanks for your interest in improving the editor! It's an Illustrator-style
desktop app for composing parallax sites rendered by
[`parallax-engine`](https://github.com/parallax-editor/parallax-engine).

## Local setup

```bash
yarn install        # pulls parallax-engine from npm
yarn editor         # starts the editor on http://localhost:3000
```

Add at least one workspace from the UI (any folder on disk that follows the
`<workspace>/content/<slug>/site.json` layout). The repo also ships sample
fixtures in `e2e/fixtures/content/` you can copy to play with.

## Tests

```bash
yarn test               # offline smoke test
yarn test:e2e:matrix    # engine render matrix (OFFLINE, self-contained)
yarn test:e2e           # editor E2E against a sandbox workspace (needs `yarn dev`)
```

## Working on engine + editor together

The editor depends on `parallax-engine` from npm. To iterate on both at once
without publishing, use `yarn link` or [`yalc`](https://github.com/wclr/yalc):

```bash
# in parallax-engine
yarn link
yarn dev          # keep the watch build running

# in parallax-editor
yarn link parallax-engine
```

## Pull requests

- Keep PRs focused; one logical change per PR.
- Run `yarn test` before pushing — CI runs it again.
- UI strings live in Spanish today; an i18n pass is planned. Until then,
  follow the existing style and keep new copy in Spanish.

## License

By contributing you agree your contributions are licensed under
[AGPL-3.0-or-later](./LICENSE). The editor's AGPL scope means anyone running
a modified version as a network service must publish their source.
