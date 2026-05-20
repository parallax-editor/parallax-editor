<script setup lang="ts">
// ── "Vista en vivo" — full-viewport live demo of the CURRENT (possibly
//    unsaved) document, rendered by the EDITOR ITSELF ────────────────────────
//
// Opened by the toolbar button in a NEW SAME-ORIGIN tab (http://localhost:3000
// /live?type=…&slug=…). It mounts the REAL parallax-engine <ParallaxSite> at
// FULL browser viewport with NO editor chrome (no toolbar/panels/canvas), in
// `mode="prod"` so animations / parallax / world transitions actually run —
// exactly like the deployed eventos/site, but:
//
//   • ZERO dependency on the eventos/site dev servers (:3001/:3002). Assets are
//     fetched from the editor's OWN /content/(eventos|site)/<slug>/* route
//     (same origin), via the shared buildPreviewSite() asset prefixing.
//   • NO save / commit. The document is handed over tab→tab IN MEMORY:
//       – FIRST paint: a localStorage snapshot the editor tab wrote right
//         before window.open (so a fresh tab has data immediately, even before
//         any channel message arrives, and a manual reload still works).
//       – LIVE updates: a per-project BroadcastChannel the editor tab posts to
//         on every (still-unsaved) edit → this tab re-renders within ~1 frame.
//         Fallback to the `storage` event when BroadcastChannel is unavailable.
//
// IMPORTANT difference vs the in-canvas preview: NO device-artboard `vh→px`
// remap here. This is a real full browser window, so `vh`/`vw` must resolve
// naturally like production at full screen. Only the asset-prefixing +
// active-view resolution from the shared core are applied.

import { ref, shallowRef, computed, onMounted, onBeforeUnmount, h, type Component } from 'vue'
import { ParallaxSite, FormBlock } from 'parallax-engine'
import type { Site } from 'parallax-engine/schema'
// Reuse the SAME custom-component host the editor canvas uses, so the registry
// is identical (FormBlock + every parallax.config custom component, e.g.
// SocialLinks, resolved via its statically-globbed sibling SFC map). Importing
// it from its real location keeps that glob's relative path correct.
import CustomComponentHost from '../components/canvas/CustomComponentHost.vue'
import {
  buildPreviewSite,
  liveChannelName,
  liveStorageKey,
  type DeviceMode,
} from '../composables/usePreviewSite'

// ── Project identity from the query string ────────────────────────────────
const params = new URLSearchParams(window.location.search)
const projectType = (params.get('type') as 'eventos' | 'site' | null) || null
const slug = params.get('slug')
const validType = projectType === 'eventos' || projectType === 'site'

// The raw canonical doc + device handed over from the editor tab. Re-derived
// into the engine-ready render copy by buildPreviewSite (shared with canvas).
const rawSite = shallowRef<Site | null>(null)
const deviceMode = ref<DeviceMode>('desktop')
const errorMsg = ref<string | null>(null)
// Bumped on every incoming update so <ParallaxSite>'s :key changes and the
// engine fully re-mounts → animations/parallax replay from the new doc state
// (the engine wires its scroll/observers in onMounted; a key remount is the
// reliable way to reflect a live edit, same approach the canvas uses).
const nonce = ref(0)

interface LivePayload {
  site: Site
  deviceMode?: DeviceMode
  // Echoed back only for sanity; the URL is the source of truth.
  projectType?: string
  slug?: string
}

function applyPayload(p: unknown) {
  if (!p || typeof p !== 'object') return
  const payload = p as LivePayload
  if (!payload.site || typeof payload.site !== 'object') return
  rawSite.value = payload.site
  if (payload.deviceMode === 'desktop' || payload.deviceMode === 'mobile') {
    deviceMode.value = payload.deviceMode
  }
  errorMsg.value = null
  nonce.value++
}

// The engine-ready render copy: shared asset-prefix + active-view resolution,
// NO artboard vh-remap (full real viewport). state stays canonical in the
// editor tab — this tab only ever holds throwaway copies.
const previewSite = computed(() => {
  if (!rawSite.value) return null
  try {
    return buildPreviewSite(
      rawSite.value,
      validType ? projectType : null,
      slug,
      deviceMode.value,
    )
  } catch (e: any) {
    errorMsg.value = e?.message || String(e)
    return null
  }
})

// Same component map shape as EditorCanvas: built-in FormBlock + a thin
// wrapper per registered custom component that renders CustomComponentHost
// (best-effort dynamic import of the sibling SFC, red placeholder on failure
// so one broken component never blanks the whole live demo). We register
// EVERY globbed sibling component name so e.g. SocialLinks renders here too —
// no API round-trip needed (the host's import.meta.glob already knows them).
const components = computed<Record<string, Component>>(() => {
  const map: Record<string, Component> = { FormBlock }
  const names = new Set<string>()
  // Pull the component names actually referenced by the doc so we register
  // exactly what's needed (and nothing breaks if the sibling repo has none).
  const visit = (site: any) => {
    for (const sec of site?.sections || []) {
      for (const layer of sec?.layers || []) {
        for (const el of layer?.elements || []) {
          // ComponentElement schema key is `name` (not `component`).
          if (el?.type === 'component' && typeof el.name === 'string') {
            names.add(el.name)
          }
        }
      }
    }
  }
  if (previewSite.value) visit(previewSite.value)
  for (const name of names) {
    if (name === 'FormBlock') continue
    map[name] = {
      name: `CustomHost_${name}`,
      inheritAttrs: false,
      setup(_props: unknown, { attrs }: { attrs: Record<string, unknown> }) {
        return () => h(CustomComponentHost, { name, componentProps: attrs })
      },
    }
  }
  return map
})

// ── Tab→tab handoff wiring ────────────────────────────────────────────────
let channel: BroadcastChannel | null = null
function onStorage(e: StorageEvent) {
  if (!validType || !slug) return
  if (e.key !== liveStorageKey(projectType as string, slug)) return
  if (!e.newValue) return
  try {
    applyPayload(JSON.parse(e.newValue))
  } catch {
    /* ignore malformed snapshot */
  }
}

onMounted(() => {
  document.title = slug ? `Vista en vivo · ${slug}` : 'Vista en vivo'
  if (!validType || !slug) {
    errorMsg.value =
      'Falta el proyecto. Abre "Vista en vivo" desde el editor con un proyecto abierto.'
    return
  }
  const sKey = liveStorageKey(projectType as string, slug)
  // 1. First paint from the snapshot the editor tab stashed pre-open.
  try {
    const raw = localStorage.getItem(sKey)
    if (raw) applyPayload(JSON.parse(raw))
  } catch {
    /* ignore */
  }
  // 2. Live updates: BroadcastChannel (preferred) + storage-event fallback.
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(
        liveChannelName(projectType as string, slug),
      )
      channel.onmessage = (ev) => applyPayload(ev.data)
    } catch {
      channel = null
    }
  }
  // Always also listen to `storage` — harmless with BroadcastChannel present
  // (the editor only writes localStorage on open, not per-edit) and the sole
  // live path when BroadcastChannel is unavailable.
  window.addEventListener('storage', onStorage)
  if (rawSite.value === null) {
    errorMsg.value =
      'Esperando datos del editor… (vuelve a pulsar "Vista en vivo")'
  }
})

onBeforeUnmount(() => {
  if (channel) {
    channel.onmessage = null
    channel.close()
    channel = null
  }
  window.removeEventListener('storage', onStorage)
})
</script>

<template>
  <!-- Full real viewport, NO editor chrome. -->
  <div class="live-root" data-test="live-root">
    <ParallaxSite
      v-if="previewSite"
      :key="nonce"
      :site="previewSite"
      :components="components"
      mode="prod"
    />
    <div v-else class="live-waiting" data-test="live-waiting">
      {{ errorMsg || 'Cargando…' }}
    </div>
  </div>
</template>

<style>
/* Global (not scoped): the live tab is a standalone full-screen surface, so
   strip the editor body's overflow:hidden / dark canvas chrome and let the
   engine own the whole viewport exactly like the deployed site. */
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background: #fff;
  overflow: visible;
}
.live-root {
  width: 100%;
  min-height: 100vh;
}
.live-waiting {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #666;
  font-size: 15px;
  background: #fafafa;
  text-align: center;
  padding: 24px;
}
</style>
