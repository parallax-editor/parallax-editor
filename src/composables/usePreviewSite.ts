// Shared "throwaway preview copy" builder.
//
// Two consumers, ONE asset-prefix + active-view resolution rule:
//   1. The in-canvas preview (EditorCanvas.vue) — keeps its OWN extra editor
//      transforms layered on top (device-artboard `vh→px` remap, hidden
//      layer/section pruning, cursor strip, etc.). Those are editor-canvas
//      concerns and stay in that component.
//   2. The full-viewport "Vista en vivo" tab (views/LivePreview.vue) — a REAL
//      browser window, so it must NOT get the artboard `vh→px` hack: `vh`/`vw`
//      have to resolve naturally like the deployed site at full screen. It
//      only needs the asset-path prefixing + active-view resolution.
//
// This module factors out exactly that common core (asset prefixing + v1.1
// `views` → active `sections` resolution) so both paths share one implementation
// and `state.site` stays canonical (only the deep-cloned copy is rewritten).

import { resolveSections } from '@parallax-editor/parallax-engine'
import type { Site } from '@parallax-editor/parallax-engine/schema'

export type DeviceMode = 'desktop' | 'mobile'

// The engine renders el.src verbatim. Real consumers prefix relative asset
// paths ("images/foo.png" → "/content/<type>/<slug>/images/foo.png"); the
// editor (and the live tab) must do the equivalent so the asset can be fetched
// from the editor's own /content/(eventos|site)/<slug>/* route. state.site
// stays CANONICAL ("images/foo.png"). Mirrors useEventData/useWorldData.
export function isRelativeAsset(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    !s.startsWith('http') &&
    !s.startsWith('/')
  )
}

/**
 * Build the throwaway render copy shared by both previews:
 *   • Pre-resolve the active view (v1.1 `views`) for the given device so the
 *     engine renders exactly the tree being edited, then DROP `copy.views` so
 *     the engine takes the legacy path (legacy/compartido sites unaffected:
 *     resolveSections → site.sections).
 *   • Drop editor-only additive keys (editorLocks).
 *   • Prefix every relative asset path (png/audio/video src+poster, og image,
 *     favicon, custom @font-face url) with `/content/<type>/<slug>/`.
 *
 * Deliberately does NOT touch section heights (no `vh`/`vw` → px remap) — that
 * is an editor-canvas-only artboard hack. The live tab must keep raw `vh`/`vw`
 * so it resolves against the real full browser viewport like production.
 */
export function buildPreviewSite(
  site: Site | null,
  projectType: string | null,
  slug: string | null,
  deviceMode: DeviceMode,
  // Cache-bust opcional (p.ej. state.assetsNonce): se añade como `?v=<token>` a
  // las URLs locales prefijadas. Al borrar/reemplazar un asset el token cambia →
  // el navegador NO sirve la copia en caché → una imagen borrada deja de
  // aparecer (antes seguía pintándose el bitmap cacheado) y una reemplazada se
  // actualiza al instante. No aplica a URLs http(s) absolutas.
  cacheBust?: string | number,
): any {
  if (!site) return null
  const base =
    projectType && slug ? `/content/${projectType}/${slug}/` : null
  const q =
    cacheBust != null && String(cacheBust) !== '' ? `?v=${cacheBust}` : ''
  const copy: any = JSON.parse(JSON.stringify(site))
  copy.sections = JSON.parse(
    JSON.stringify(resolveSections(site as any, deviceMode)),
  )
  delete copy.views
  delete copy.editorLocks
  if (!base) return copy
  if (copy.meta && isRelativeAsset(copy.meta.ogImage))
    copy.meta.ogImage = base + copy.meta.ogImage + q
  if (copy.meta && isRelativeAsset(copy.meta.favicon))
    copy.meta.favicon = base + copy.meta.favicon + q
  if (copy.meta && Array.isArray(copy.meta.fonts)) {
    for (const f of copy.meta.fonts) {
      if (f && f.source === 'custom' && isRelativeAsset(f.url))
        f.url = base + f.url + q
    }
  }
  for (const section of copy.sections || []) {
    for (const layer of section.layers || []) {
      for (const el of layer.elements || []) {
        if (
          (el.type === 'png' || el.type === 'gif' || el.type === 'audio') &&
          isRelativeAsset(el.src)
        )
          el.src = base + el.src + q
        if (el.type === 'video') {
          if (isRelativeAsset(el.src)) el.src = base + el.src + q
          if (isRelativeAsset(el.poster)) el.poster = base + el.poster + q
        }
      }
    }
  }
  return copy
}

// localStorage / BroadcastChannel channel + key are per project so two
// projects open in two windows never cross-feed. The live tab reads the
// localStorage snapshot for its FIRST paint, then listens on the channel for
// subsequent (still-unsaved) edits pushed by the editor tab.
export function liveChannelName(
  projectType: string,
  slug: string,
): string {
  return `parallax-live:${projectType}:${slug}`
}
export function liveStorageKey(
  projectType: string,
  slug: string,
): string {
  return `parallax-live-snapshot:${projectType}:${slug}`
}
