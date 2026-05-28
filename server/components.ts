import { existsSync } from 'fs'
import { resolve } from 'path'
import { getRepoPath } from './projects'
import { loadParallaxConfigDefault } from './configLoader'

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
// Workspaces without a `parallax.config.ts` resolve to {} → only the engine's
// built-in components (e.g. FormBlock) are available in that workspace.
//
// The editor only needs the JSON-serializable shape (names + labels +
// editableProps). The actual `component` refs are Vue objects (functions /
// render code) — never sent to the client; the canvas dynamically imports the
// real SFCs separately (best-effort, with a red placeholder fallback per §16).
//
// Loading strategy (FASE 1 — Vite-free): the config is transpiled + bundled
// with esbuild (`server/configLoader.ts`), which STUBS its `.vue` imports to an
// empty default and its `parallax-engine` import to an identity
// `defineParallaxConfig`. We then read the resulting plain config object. This
// removes the previous dependency on `server.ssrLoadModule` / ViteDevServer so
// the same code runs in the standalone Node server (server/standalone.ts).
// Everything is wrapped so a broken/absent config returns a structured payload
// instead of crashing the API (the editor degrades to built-ins only).

export interface SerializableEditableProp {
  // Mirrors the engine's EditableProp (src/config.ts). The new types
  // (textarea/url/range/date) are ADDITIVE — an older editor degrades them to
  // text. An unknown type still falls back to 'string' in sanitizeProp.
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'select'
    | 'array'
    | 'color'
    | 'image'
    | 'textarea'
    | 'url'
    | 'range'
    | 'date'
  label: string
  // ── Fase 0 metadata (all OPTIONAL / additive) ──────────────────────────────
  /** Help copy → "?" hint icon next to the field in the editor. */
  help?: string
  /** Marks the field as required → visual indicator + empty-validation. */
  required?: boolean
  /** Groups fields under a small section header in PROPIEDADES. */
  group?: string
  /** Show the field only when a sibling prop `field` equals `equals`. */
  showIf?: { field: string; equals: unknown }
  options?: string[]
  default?: unknown
  /** type:'range' (and optional on 'number'): bounds + step. */
  min?: number
  max?: number
  step?: number
  /** type:'textarea': visible rows. */
  rows?: number
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

// Full additive type set (engine src/config.ts). NOT a content whitelist — it
// only decides whether to PASS THROUGH the declared `type` verbatim or degrade
// an unknown one to 'string' (so the editor always has a control to render).
const VALID_PROP_TYPES = new Set([
  'string', 'number', 'boolean', 'select', 'array', 'color', 'image',
  'textarea', 'url', 'range', 'date',
])

// Defensively project ONE EditableProp into its JSON-safe shape. Unknown
// `type` falls back to 'string' (the safest editor control); recurses into
// `itemSchema` for arrays. Anything non-serializable is dropped. The Fase 0
// metadata keys (help/required/group/showIf/min/max/step/rows) are passed
// through unchanged — there is NO whitelist that would strip them.
function sanitizeProp(raw: any): SerializableEditableProp | null {
  if (!raw || typeof raw !== 'object') return null
  const type = VALID_PROP_TYPES.has(raw.type) ? raw.type : 'string'
  const out: SerializableEditableProp = {
    type,
    label: typeof raw.label === 'string' ? raw.label : '',
  }
  // ── Fase 0 metadata: pass through verbatim (additive, all optional) ────────
  if (typeof raw.help === 'string') out.help = raw.help
  if (typeof raw.required === 'boolean') out.required = raw.required
  if (typeof raw.group === 'string') out.group = raw.group
  if (
    raw.showIf &&
    typeof raw.showIf === 'object' &&
    typeof raw.showIf.field === 'string'
  ) {
    // `equals` may be any JSON-serializable primitive; round-trip to drop
    // anything non-serializable (a function/Symbol → omit the whole showIf).
    try {
      out.showIf = { field: raw.showIf.field, equals: JSON.parse(JSON.stringify(raw.showIf.equals)) }
    } catch {
      /* non-serializable equals — omit showIf */
    }
  }
  if (typeof raw.min === 'number') out.min = raw.min
  if (typeof raw.max === 'number') out.max = raw.max
  if (typeof raw.step === 'number') out.step = raw.step
  if (typeof raw.rows === 'number') out.rows = raw.rows
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
 * Load + serialize the custom-component registry for a workspace `type`
 * (workspace id, e.g. `eventos` | `site`). Never throws: a missing config →
 * empty registry; a broken config → empty registry + `error` describing the
 * failure.
 *
 * Vite-free (FASE 1): the config is bundled with esbuild via
 * `loadParallaxConfigDefault` (its `.vue` and `parallax-engine` imports are
 * stubbed). We only read the resulting plain config object and strip the live
 * Vue `component` refs — only the JSON registry is returned. Takes the
 * workspace id directly (resolves the repo internally); no ViteDevServer.
 */
export async function loadComponentRegistry(
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
    // esbuild bundles the config (stubbing `.vue` + `parallax-engine`); we read
    // the resulting plain config object's `default` export.
    const config = (await loadParallaxConfigDefault(configPath)) as any
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

// ─── Catálogo de componentes → bloque de prompt para `claude -p` ───────────────
//
// El contrato del engine (ai/contract.md, §7) le dice a Claude que NO invente
// componentes: que use solo los del catálogo del SITIO ACTUAL. Ese catálogo es
// específico del workspace (vive en su parallax.config.ts), así que el editor lo
// inyecta dinámicamente por-llamada — nada hardcodeado. Devuelve '' cuando el
// workspace no tiene componentes custom (p.ej. eventos: solo FormBlock).
function describeProp(name: string, p: SerializableEditableProp): string {
  const bits: string[] = [`${name} (${p.type})`]
  if (p.required) bits.push('obligatorio')
  if (p.options?.length) bits.push(`opciones: ${p.options.join('|')}`)
  if (p.label) bits.push(`«${p.label}»`)
  if (p.help) bits.push(p.help)
  return `    - ${bits.join(' — ')}`
}

export async function formatComponentCatalogForPrompt(type: string): Promise<string> {
  let registry: ComponentRegistryResponse
  try {
    registry = await loadComponentRegistry(type)
  } catch {
    return '' // nunca tumbar la corrida de Claude por esto
  }
  const comps = Object.values(registry.components || {})
  if (comps.length === 0) return ''

  const lines: string[] = [
    '## Componentes custom disponibles en ESTE sitio',
    '',
    'Usa `type: "component"` con uno de estos `name` y solo estas props. No inventes otros.',
    '',
  ]
  for (const c of comps) {
    const desc = c.description ? ` — ${c.description}` : ''
    lines.push(`- **${c.name}** (${c.label})${desc}`)
    const props = Object.entries(c.editableProps || {})
    if (props.length === 0) {
      lines.push('    - (sin props configurables)')
    } else {
      for (const [k, p] of props) lines.push(describeProp(k, p))
    }
  }
  return lines.join('\n')
}
