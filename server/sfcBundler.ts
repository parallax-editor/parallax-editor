// ─── Server-side workspace SFC bundler ─────────────────────────────────────
//
// The canvas preview (CustomComponentHost.vue) wants to render the custom
// Vue components that live in the active workspace's `components/` folder.
// Vite's `import.meta.glob` is build-time and can only see paths under the
// editor's own source tree — so workspaces hosted in arbitrary on-disk
// folders (the common case for the open-source flow) used to fall through
// to a placeholder.
//
// This module compiles a workspace SFC on demand:
//   1. `@vue/compiler-sfc` parses the .vue file and emits separate JS + CSS
//      (and a binding signature for template ↔ script type inference).
//   2. esbuild bundles the combined module, treating `vue` as external so
//      the runtime resolves it from the editor's already-loaded Vue
//      instance (avoids double Vue + reactivity desync).
//   3. The endpoint returns the bundled JS as a regular ESM module. The
//      client imports it via `defineAsyncComponent(() => import(url))`.
//
// A mtime-keyed in-memory cache prevents recompiling on every render. The
// file watcher (server/watcher.ts) clears the cache entry when the .vue
// file changes, so the next dynamic import gets the fresh build.

import { existsSync, statSync, readFileSync } from 'fs'
import { resolve, basename } from 'path'
import { parse, compileScript, compileTemplate, compileStyle, type SFCParseResult } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { resolveWorkspace } from './workspaces'

interface CacheEntry {
  mtimeMs: number
  body: string
}

const cache = new Map<string, CacheEntry>()

/**
 * Compile `<workspace>/components/<name>.vue` into an ESM module string.
 * Returns null when the workspace or file doesn't exist.
 *
 * Caches per (path, mtime). Subsequent calls for the same file mtime hit
 * the cache. `invalidate(path)` (used by the file watcher) drops the entry.
 */
export async function bundleWorkspaceComponent(
  workspaceId: string,
  name: string,
): Promise<{ ok: true; body: string; mtimeMs: number } | { ok: false; error: string; status?: number }> {
  if (!isSafeName(name)) {
    return { ok: false, error: 'invalid component name', status: 400 }
  }
  const ws = resolveWorkspace(workspaceId)
  if (!ws) return { ok: false, error: 'unknown workspace', status: 404 }
  const sfcPath = resolve(ws.repoPath, 'components', `${name}.vue`)
  if (!sfcPath.startsWith(resolve(ws.repoPath) + '/') && sfcPath !== resolve(ws.repoPath, 'components', `${name}.vue`)) {
    // Defensive containment check — the `isSafeName` filter already blocks
    // `..` and slashes, but belt + suspenders.
    return { ok: false, error: 'path traversal blocked', status: 400 }
  }
  if (!existsSync(sfcPath)) return { ok: false, error: 'component not found', status: 404 }

  const mtimeMs = statSync(sfcPath).mtimeMs
  const cacheKey = sfcPath
  const hit = cache.get(cacheKey)
  if (hit && hit.mtimeMs === mtimeMs) {
    return { ok: true, body: hit.body, mtimeMs }
  }

  try {
    const body = await compile(sfcPath, name)
    cache.set(cacheKey, { mtimeMs, body })
    return { ok: true, body, mtimeMs }
  } catch (e: any) {
    return { ok: false, error: `bundle failed: ${e?.message || e}`, status: 500 }
  }
}

/**
 * Invalidate the cached bundle for a workspace SFC. Called by the file
 * watcher when a .vue under any watched workspace changes.
 */
export function invalidateComponent(sfcPath: string): void {
  cache.delete(sfcPath)
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

function isSafeName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..') && !name.includes('/')
}

/**
 * SFC → standalone ESM. The output references `vue` as an external import
 * so the runtime reuses the editor's Vue instance.
 */
async function compile(sfcPath: string, name: string): Promise<string> {
  const source = readFileSync(sfcPath, 'utf-8')
  const id = `wcomp-${name}`
  const parsed: SFCParseResult = parse(source, { filename: sfcPath })
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((e: any) => e.message || String(e)).join('; '))
  }
  const { descriptor } = parsed

  // SCRIPT (handles <script setup> via compileScript)
  const scriptCompiled = descriptor.script || descriptor.scriptSetup
    ? compileScript(descriptor, { id })
    : { content: 'export default {}' }
  let scriptContent = scriptCompiled.content

  // TEMPLATE
  let templateRender = ''
  if (descriptor.template) {
    const templateCompiled = compileTemplate({
      source: descriptor.template.content,
      filename: sfcPath,
      id,
      compilerOptions: { bindingMetadata: (scriptCompiled as any).bindings },
    })
    if (templateCompiled.errors.length) {
      throw new Error(templateCompiled.errors.map(e => (typeof e === 'string' ? e : e.message)).join('; '))
    }
    templateRender = templateCompiled.code
  }

  // STYLES (scoped/plain) → inject as a <style> tag at runtime. Cheap and
  // avoids a separate /style request.
  const styles: string[] = []
  for (const styleBlock of descriptor.styles) {
    const styleCompiled = compileStyle({
      source: styleBlock.content,
      filename: sfcPath,
      id,
      scoped: !!styleBlock.scoped,
    })
    if (styleCompiled.errors.length) {
      throw new Error(styleCompiled.errors.map((e: any) => e.message || String(e)).join('; '))
    }
    styles.push(styleCompiled.code)
  }

  // Glue: combine script + template + styles into a single module.
  // - Rename `export default` in the script so we can attach `render` and
  //   the scopeId after.
  // - `defaultExport.__scopeId` matches the data-v-* attribute the compiled
  //   template + styles use, so scoped styles work in the consumer page.
  scriptContent = scriptContent.replace(/export default /g, 'const __defaultExport__ = ')

  const styleInjection = styles.length
    ? `;(function(){\n  if (typeof document === 'undefined') return;\n  const css = ${JSON.stringify(styles.join('\n'))};\n  const id = ${JSON.stringify('__sfc_css_' + id)};\n  if (document.getElementById(id)) return;\n  const el = document.createElement('style'); el.id = id; el.textContent = css; document.head.appendChild(el);\n})();\n`
    : ''

  const composed = [
    scriptContent || 'const __defaultExport__ = {};',
    templateRender || 'const render = () => null;',
    `__defaultExport__.render = render;`,
    `__defaultExport__.__scopeId = ${JSON.stringify('data-v-' + id)};`,
    `__defaultExport__.__file = ${JSON.stringify(basename(sfcPath))};`,
    styleInjection,
    `export default __defaultExport__;`,
  ].join('\n\n')

  // esbuild for last-mile transform (TS → JS, ESM out, vue external). We
  // hand it the source as `js` because compileScript already lowered TS
  // syntax inside <script lang="ts"> — but esbuild is tolerant of plain JS
  // input and gives us minification + downleveling for free.
  const result = await transform(composed, {
    loader: 'ts',
    format: 'esm',
    target: 'es2020',
    sourcemap: false,
  })
  return result.code
}
