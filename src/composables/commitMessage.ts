// ── Generated commit message (GAP7 / PLAN §9) ───────────────────────────────
//
// EditorView used to auto-commit every save with the static string
// `edit: <slug>`, so the git history was useless ("edit: edit: edit:"). This
// builds a short, descriptive Spanish message by DIFFING the previous saved
// JSON against the current site — counting sections/layers/elements added,
// removed, and changed, plus meta/theme touches. A concise heuristic only:
// NO `claude -p`, no network — just a structural walk of the two trees.
//
// Falls back to a stable generic string when nothing meaningful is detectable
// (still never the old static `edit: <slug>` form).

interface Counts {
  sections: { added: number; removed: number }
  layers: { added: number; removed: number }
  elements: { added: number; removed: number; changed: number }
  changedIds: string[]
}

type AnyObj = Record<string, any>

// Flatten the (legacy + v1.1 views) section trees into id-keyed maps so we can
// diff by stable id. Each node carries a content fingerprint (its own JSON
// minus children) so we can detect "changed" without recursing twice.
function indexTree(site: AnyObj | null) {
  const sections = new Map<string, string>()
  const layers = new Map<string, string>()
  const elements = new Map<string, string>()
  if (!site) return { sections, layers, elements }

  const roots: AnyObj[] = []
  if (Array.isArray(site.sections)) roots.push(...site.sections)
  if (site.views?.desktop?.sections) roots.push(...site.views.desktop.sections)
  if (site.views?.mobile?.sections) roots.push(...site.views.mobile.sections)

  for (const s of roots) {
    if (!s || typeof s !== 'object') continue
    const sid = String(s.id ?? `s?${sections.size}`)
    const { layers: sl, ...sRest } = s
    sections.set(sid, JSON.stringify(sRest))
    for (const l of (s.layers ?? [])) {
      if (!l || typeof l !== 'object') continue
      const lid = String(l.id ?? `l?${layers.size}`)
      const { elements: le, ...lRest } = l
      layers.set(lid, JSON.stringify(lRest))
      for (const e of (l.elements ?? [])) {
        if (!e || typeof e !== 'object') continue
        const eid = String(e.id ?? `e?${elements.size}`)
        elements.set(eid, JSON.stringify(e))
      }
    }
  }
  return { sections, layers, elements }
}

function diffMaps(
  prev: Map<string, string>,
  next: Map<string, string>,
): { added: number; removed: number; changed: number; changedIds: string[] } {
  let added = 0
  let removed = 0
  let changed = 0
  const changedIds: string[] = []
  for (const id of next.keys()) {
    if (!prev.has(id)) added++
    else if (prev.get(id) !== next.get(id)) {
      changed++
      changedIds.push(id)
    }
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) removed++
  }
  return { added, removed, changed, changedIds }
}

/**
 * Build a concise Spanish commit message describing what changed between the
 * previously-saved JSON string and the current site object.
 *
 * @param slug         project slug (suffix for context)
 * @param previousJson `state.originalSite` (JSON string of last saved site) or null
 * @param current      `state.site` (current object) or null
 */
export function buildCommitMessage(
  slug: string,
  previousJson: string | null,
  current: AnyObj | null,
): string {
  let prevSite: AnyObj | null = null
  try {
    prevSite = previousJson ? JSON.parse(previousJson) : null
  } catch {
    prevSite = null
  }

  // First save / no prior baseline → not an "edit", it's the initial content.
  if (!prevSite) {
    return `contenido inicial: ${slug}`
  }

  const a = indexTree(prevSite)
  const b = indexTree(current)
  const c: Counts = {
    sections: { added: 0, removed: 0 },
    layers: { added: 0, removed: 0 },
    elements: { added: 0, removed: 0, changed: 0 },
    changedIds: [],
  }
  const ds = diffMaps(a.sections, b.sections)
  const dl = diffMaps(a.layers, b.layers)
  const de = diffMaps(a.elements, b.elements)
  c.sections = { added: ds.added, removed: ds.removed }
  c.layers = { added: dl.added, removed: dl.removed }
  c.elements = { added: de.added, removed: de.removed, changed: de.changed }
  c.changedIds = de.changedIds.slice(0, 3)

  // meta / theme touched? (these aren't in the section trees)
  const metaChanged =
    JSON.stringify((prevSite as AnyObj).meta ?? null) !==
    JSON.stringify((current as AnyObj | null)?.meta ?? null)
  const themeChanged =
    JSON.stringify((prevSite as AnyObj).theme ?? null) !==
    JSON.stringify((current as AnyObj | null)?.theme ?? null)

  const parts: string[] = []
  if (c.sections.added) parts.push(`+${c.sections.added} sección(es)`)
  if (c.sections.removed) parts.push(`-${c.sections.removed} sección(es)`)
  if (c.layers.added) parts.push(`+${c.layers.added} capa(s)`)
  if (c.layers.removed) parts.push(`-${c.layers.removed} capa(s)`)
  if (c.elements.added) parts.push(`+${c.elements.added} elemento(s)`)
  if (c.elements.removed) parts.push(`-${c.elements.removed} elemento(s)`)
  if (c.elements.changed) {
    const ids = c.changedIds.length
      ? ` (${c.changedIds.join(', ')}${de.changed > c.changedIds.length ? '…' : ''})`
      : ''
    parts.push(`${c.elements.changed} elemento(s) modificado(s)${ids}`)
  }
  if (metaChanged) parts.push('ajustes del sitio')
  if (themeChanged) parts.push('tema')

  if (!parts.length) {
    // Something changed enough to be dirty but our structural diff saw nothing
    // notable (e.g. an editor-only key). Still avoid the old static string.
    return `ajustes menores: ${slug}`
  }

  return `${parts.join(', ')} — ${slug}`
}
