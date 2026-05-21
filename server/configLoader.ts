// ─── Vite-free loader for a repo's parallax.config.ts ──────────────────────────
//
// FASE 1 (empaquetado / Electron): the component registry used to be read via
// Vite's `server.ssrLoadModule`. That tied `loadComponentRegistry` to a live
// ViteDevServer. To run the API in a standalone Node server (no Vite), we
// transpile + bundle the neighbor repo's `parallax.config.ts` with esbuild and
// extract its `default` export object.
//
// The config imports two things the editor does NOT need at runtime to read the
// registry, so we STUB them via an esbuild resolve/load plugin:
//
//   • `*.vue` SFCs        → `{ default: {} }`   (we only want `editableProps`,
//                                                which are plain objects; the
//                                                live Vue component refs are
//                                                stripped during serialization
//                                                anyway — see components.ts).
//   • `parallax-engine`   → `{ defineParallaxConfig: (c) => c }`  (identity —
//                            the real export is exactly this; bundling the built
//                            engine dist would pull in Vue unnecessarily).
//
// We bundle in-memory (`write: false`) to CJS and evaluate the output in a fresh
// module sandbox to obtain the config object. esbuild is already a transitive
// dep of Vite; it is also declared explicitly in package.json devDependencies.

import { build } from 'esbuild'
import { Module } from 'module'
import { dirname } from 'path'

/** A Vue SFC import → empty default; `parallax-engine` → identity helper. */
const stubPlugin = {
  name: 'parallax-config-stubs',
  setup(b: any) {
    // Any *.vue import resolves to a virtual empty module. The editor only reads
    // `editableProps` (plain objects); the live component ref is never needed.
    b.onResolve({ filter: /\.vue($|\?)/ }, (args: any) => ({
      path: args.path,
      namespace: 'vue-stub',
    }))
    b.onLoad({ filter: /.*/, namespace: 'vue-stub' }, () => ({
      contents: 'export default {}',
      loader: 'js',
    }))

    // `parallax-engine` (and any subpath like `parallax-engine/schema`) →
    // identity `defineParallaxConfig`. defineParallaxConfig(c) === c by design,
    // so the config object is returned verbatim.
    b.onResolve({ filter: /^parallax-engine(\/.*)?$/ }, (args: any) => ({
      path: args.path,
      namespace: 'engine-stub',
    }))
    b.onLoad({ filter: /.*/, namespace: 'engine-stub' }, () => ({
      contents: 'export const defineParallaxConfig = (c) => c; export default { defineParallaxConfig };',
      loader: 'js',
    }))
  },
}

/**
 * Transpile + bundle `configPath` (an absolute parallax.config.ts) with esbuild
 * and return its evaluated `default` export (the parallax config object) — with
 * NO dependency on Vite. Throws on a real bundling/eval error (the caller wraps
 * it into a structured registry error).
 */
export async function loadParallaxConfigDefault(configPath: string): Promise<any> {
  const result = await build({
    entryPoints: [configPath],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    // Keep it permissive: the config is plain TS/JS once imports are stubbed.
    target: 'node18',
    logLevel: 'silent',
    plugins: [stubPlugin],
  })

  const out = result.outputFiles?.[0]?.text
  if (!out) throw new Error('esbuild produjo un bundle vacío')

  // Evaluate the CJS bundle in a fresh Module sandbox. `require` is wired to the
  // standard resolver rooted at the config's directory (only needed if some
  // dependency slipped through un-stubbed — normally nothing does).
  const sandbox = new Module(configPath, undefined)
  sandbox.filename = configPath
  sandbox.paths = (Module as any)._nodeModulePaths(dirname(configPath))
  const compiler = (sandbox as any)._compile.bind(sandbox)
  compiler(out, configPath)

  const mod = sandbox.exports as any
  return mod?.default ?? mod
}
