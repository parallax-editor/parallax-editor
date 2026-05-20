import type { ViteDevServer } from 'vite'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { getRepoPath } from './projects'

// ─── Custom component discovery (parallax.config.ts → serializable registry) ───
//
// PLAN §13. Each consumer repo MAY ship a root `parallax.config.ts` that
// registers custom Vue components for the engine via `defineParallaxConfig`:
//
//   defineParallaxConfig({ components: { Name: {
//     component,            // a Vue SFC  ← NOT serializable, STRIPPED here
//     label, description,
//     editableProps         // schema the editor renders → kept
//   } } })
//
// `daniela-reyes-eventos` has NO config (built-in FormBlock only) → {}.
// `daniela-reyes-site` registers NavButtons / HeroCTA / PortfolioCard /
// WorldNav / SocialLinks.
//
// The editor only needs the JSON-serializable shape (names + labels +
// editableProps). The actual `component` refs are Vue objects (functions /
// render code) — never sent to the client; the canvas dynamically imports the
// real SFCs separately (best-effort, with a red placeholder fallback per §16).
//
// Loading strategy: Vite's own SSR module graph (`server.ssrLoadModule`). The
// config imports `.vue` SFCs (handled by @vitejs/plugin-vue) and
// `defineParallaxConfig` from `parallax-engine` (resolved by the editor's
// vite alias to the built dist). We import it OUT of the editor root via its
// absolute path; ssrLoadModule supports absolute fs paths. Everything is
// wrapped so a broken/absent config returns a structured payload instead of
// crashing the API (the editor degrades to built-ins only).

export interface SerializableEditableProp {
  type: 'string' | 'number' | 'boolean' | 'select' | 'array' | 'color' | 'image'
  label: string
  options?: string[]
  default?: unknown
  itemSchema?: Record<string, SerializableEditableProp>
}

export interface SerializableComponentRegistration {
  name: string
  label: string
  description?: string
  editableProps: Record<string, SerializableEditableProp>
}

export interface ComponentRegistryResponse {
  // Map keyed by component name → serializable registration (no Vue refs).
  components: Record<string, SerializableComponentRegistration>
  // Present only when the config exists but failed to load/parse. The editor
  // shows built-ins only and (optionally) surfaces this; it must NOT crash.
  error?: string
}

const VALID_PROP_TYPES = new Set([
  'string', 'number', 'boolean', 'select', 'array', 'color', 'image',
])

// Defensively project ONE EditableProp into its JSON-safe shape. Unknown
// `type` falls back to 'string' (the safest editor control); recurses into
// `itemSchema` for arrays. Anything non-serializable is dropped.
function sanitizeProp(raw: any): SerializableEditableProp | null {
  if (!raw || typeof raw !== 'object') return null
  const type = VALID_PROP_TYPES.has(raw.type) ? raw.type : 'string'
  const out: SerializableEditableProp = {
    type,
    label: typeof raw.label === 'string' ? raw.label : '',
  }
  if (Array.isArray(raw.options)) {
    out.options = raw.options.map((o: any) => String(o))
  }
  if (raw.default !== undefined) {
    // Round-trip through JSON so only serializable defaults survive (a
    // function/Symbol/etc. would throw → caught by the caller).
    try {
      out.default = JSON.parse(JSON.stringify(raw.default))
    } catch {
      /* non-serializable default — omit it */
    }
  }
  if (raw.itemSchema && typeof raw.itemSchema === 'object') {
    const items: Record<string, SerializableEditableProp> = {}
    for (const [k, v] of Object.entries(raw.itemSchema)) {
      const p = sanitizeProp(v)
      if (p) items[k] = p
    }
    out.itemSchema = items
  }
  return out
}

function sanitizeRegistration(
  name: string,
  raw: any,
): SerializableComponentRegistration {
  const editableProps: Record<string, SerializableEditableProp> = {}
  if (raw?.editableProps && typeof raw.editableProps === 'object') {
    for (const [k, v] of Object.entries(raw.editableProps)) {
      const p = sanitizeProp(v)
      if (p) editableProps[k] = p
    }
  }
  return {
    name,
    label: typeof raw?.label === 'string' && raw.label ? raw.label : name,
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    editableProps,
  }
}

/**
 * Load + serialize the custom-component registry for a project `type`
 * (`eventos` | `site`). Never throws: a missing config → empty registry;
 * a broken config → empty registry + `error` describing the failure.
 *
 * Uses Vite's SSR module loader so the config's `.vue` imports and its
 * `parallax-engine` import resolve through the same machinery the editor
 * already uses (the Vue plugin + the engine alias). Strips the live Vue
 * `component` refs — only the JSON registry is returned.
 */
export async function loadComponentRegistry(
  server: ViteDevServer,
  type: string,
): Promise<ComponentRegistryResponse> {
  const repo = getRepoPath(type)
  if (!repo) {
    return { components: {}, error: `Tipo de proyecto desconocido: ${type}` }
  }
  const configPath = resolve(repo, 'parallax.config.ts')
  if (!existsSync(configPath)) {
    // No config at all (e.g. eventos). Not an error — built-ins only.
    return { components: {} }
  }
  try {
    // ssrLoadModule accepts an absolute fs path; the leading "/" form keeps it
    // out of the editor's import-analysis (it's a sibling repo file). The Vue
    // plugin compiles the imported SFCs; the engine alias resolves
    // `defineParallaxConfig`. We only read the resulting plain config object.
    const mod = await server.ssrLoadModule(configPath)
    const config = (mod?.default ?? mod) as any
    const comps = config?.components
    if (!comps || typeof comps !== 'object') {
      return { components: {} }
    }
    const components: Record<string, SerializableComponentRegistration> = {}
    for (const [name, reg] of Object.entries(comps)) {
      components[name] = sanitizeRegistration(name, reg)
    }
    return { components }
  } catch (err: any) {
    // A broken/incompatible config must NOT take down the API. Report it so
    // the editor can (optionally) surface it; editing still works on built-ins.
    return {
      components: {},
      error:
        `No se pudo cargar parallax.config.ts de "${type}": ` +
        (err?.message || String(err)),
    }
  }
}
