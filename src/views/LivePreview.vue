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

import { ref, shallowRef, computed, nextTick, onMounted, onBeforeUnmount, h, type Component } from 'vue'
import { ParallaxSite, FormBlock } from 'parallax-engine'
import { validateSite, type Site } from 'parallax-engine/schema'
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
// `type` es el id del workspace — CUALQUIERA, no solo eventos/site (antes esto
// estaba hardcodeado y un workspace nuevo mostraba "Falta el proyecto"). Se usa
// como prefijo de assets (/content/<id>/…) y para la key del snapshot/canal.
const params = new URLSearchParams(window.location.search)
const projectType = params.get('type') || null
// originalSlug = el sitio que se edita (recibe snapshot/canal del editor).
// currentSlug = el que se VE ahora; cambia al navegar in-engine (link.site).
const originalSlug = params.get('slug')
const currentSlug = ref(params.get('slug'))
const validType = !!projectType

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
  // El snapshot/canal alimenta el sitio que se EDITA. Si navegamos a un hermano
  // (currentSlug ≠ originalSlug), ignoramos los updates para no pisar lo que se ve.
  if (currentSlug.value !== originalSlug) return
  const payload = p as LivePayload
  if (!payload.site || typeof payload.site !== 'object') return
  // Validar para aplicar defaults de Zod (rotation:0, etc.) como el sitio
  // público. Si el doc está a medio editar (inválido), usamos el crudo igual
  // (best-effort) — el engine ya es defensivo con rotation undefined.
  const parsed = validateSite(payload.site)
  rawSite.value = parsed.ok ? (parsed.data as Site) : payload.site
  if (payload.deviceMode === 'desktop' || payload.deviceMode === 'mobile') {
    deviceMode.value = payload.deviceMode
  }
  errorMsg.value = null
  nonce.value++
}

// ── Navegación in-engine entre sitios (link.site) en la Vista en vivo ──────────
// Al click en un elemento con link.site, el engine emite `navigate(slug)`. Aquí
// traemos el site.json GUARDADO de ese slug (del propio /content del editor) y
// hacemos la transición. (En el canvas del editor esto NO pasa: ahí va
// mode="dev" y ElementLink no navega.)
//
// ROBUSTEZ DE SIZING: el mundo ENTRANTE se renderiza SIEMPRE como un
// <ParallaxSite> normal en flujo (viewport completo) — nunca dentro de un
// wrapper con hijos `absolute`/medición, que era lo que lo dejaba "a media
// pantalla" / corrido a la derecha. La transición es un cross-fade: el mundo
// SALIENTE se congela en un overlay `position:fixed inset:0` por encima y se
// desvanece (opacity 1→0) hasta desmontarse. El destino, por debajo, ya está
// montado a tamaño correcto desde el primer frame.
const fadeSite = shallowRef<any | null>(null) // mundo saliente (overlay que se va)
const fadeOut = ref(false) // dispara la transición CSS de opacidad del overlay
const txCfg = ref<{ duration: number }>({ duration: 600 })
// Pila para "Volver" (el botón atrás de la Vista en vivo): cada navegación
// apila el slug de origen; goBack() lo desapila.
const backStack = ref<string[]>([])

async function go(targetSlug: string, opts: { skipStack?: boolean } = {}) {
  if (!validType || !targetSlug || targetSlug === currentSlug.value) return
  try {
    const res = await fetch(`/content/${projectType}/${encodeURIComponent(targetSlug)}/site.json`)
    if (!res.ok) return
    const raw = await res.json()
    if (!raw || typeof raw !== 'object') return
    // VALIDAR (igual que loadWorldSite en la web): Zod aplica los defaults
    // (p.ej. rotation:0). Sin esto el engine recibe rotation=undefined y arma
    // `rotate(undefineddeg)` → transform inválido → el navegador lo descarta →
    // el sitio queda corrido. El sitio público no tenía el bug porque valida.
    const parsed = validateSite(raw)
    const site = parsed.ok ? (parsed.data as any) : raw
    if (!opts.skipStack && currentSlug.value) backStack.value.push(currentSlug.value)
    // El cross-fade es, visualmente, el sitio que DEJAS desvaneciéndose → lo
    // gobierna la SALIDA (out) del sitio de ORIGEN. Si el origen no tiene salida
    // configurada ("(ninguno)") → swap instantáneo (no fade).
    const sourceT = (rawSite.value as any)?.meta?.transition
    const txType = sourceT?.out
    txCfg.value = { duration: sourceT?.duration || 600 }
    const outgoing = previewSite.value // snapshot del sitio actual (ya construido)
    rawSite.value = site
    currentSlug.value = targetSlug
    // NO bumpeamos `nonce` al navegar: dejamos que `previewSite` (reactivo)
    // PARCHEE la MISMA instancia de <ParallaxSite> (igual que la web, que centra
    // bien). Remontar por key al navegar era justo lo que descuadraba el mundo
    // destino a la derecha (la web nunca remonta, solo parchea). El remount por
    // `nonce` se reserva para ediciones en vivo del MISMO sitio (applyPayload).
    document.title = `Vista en vivo · ${targetSlug}`
    // Arranca el cross-fade del mundo saliente SOLO si hay transición configurada.
    if (outgoing && txType) {
      fadeSite.value = outgoing
      fadeOut.value = false
      // Doble rAF: garantiza un frame pintado a opacity:1 antes de pasar a 0,
      // si no el navegador no anima la transición.
      await nextTick()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          fadeOut.value = true
        }),
      )
    }
  } catch {
    /* no-op: una navegación fallida no rompe la vista */
  }
}
function goBack() {
  const prev = backStack.value.pop()
  if (prev) go(prev, { skipStack: true })
}
function onFadeEnd() {
  fadeSite.value = null
  fadeOut.value = false
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
      currentSlug.value,
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
  if (!validType || !originalSlug) return
  if (e.key !== liveStorageKey(projectType as string, originalSlug)) return
  if (!e.newValue) return
  try {
    applyPayload(JSON.parse(e.newValue))
  } catch {
    /* ignore malformed snapshot */
  }
}

onMounted(() => {
  document.title = originalSlug ? `Vista en vivo · ${originalSlug}` : 'Vista en vivo'
  if (!validType || !originalSlug) {
    errorMsg.value =
      'Falta el proyecto. Abre "Vista en vivo" desde el editor con un proyecto abierto.'
    return
  }
  const sKey = liveStorageKey(projectType as string, originalSlug)
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
        liveChannelName(projectType as string, originalSlug),
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
    <!-- Botón Volver: aparece tras navegar a otro sitio (link.site). -->
    <button v-if="backStack.length" class="live-back" type="button" @click="goBack" data-test="live-back">
      ← Volver
    </button>

    <!-- Mundo ENTRANTE: siempre <ParallaxSite> normal en flujo, viewport completo
         (sizing correcto garantizado). Al navegar (link.site) emite `navigate`. -->
    <ParallaxSite
      v-if="previewSite"
      :key="nonce"
      :site="previewSite"
      :components="components"
      mode="prod"
      @navigate="go"
    />

    <!-- Mundo SALIENTE: overlay fijo que se desvanece encima y se desmonta. -->
    <div
      v-if="fadeSite"
      class="live-fade"
      :class="{ 'is-out': fadeOut }"
      :style="{ transitionDuration: txCfg.duration + 'ms' }"
      @transitionend="onFadeEnd"
    >
      <ParallaxSite :site="fadeSite" :components="components" mode="prod" />
    </div>

    <div v-if="!previewSite" class="live-waiting" data-test="live-waiting">
      <span v-if="!errorMsg" class="live-spinner" aria-label="Cargando" role="status" />
      <p v-if="errorMsg" class="live-waiting-msg">{{ errorMsg }}</p>
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
  /* El index.html del editor pone `#app { width:100vw; height:100vh }` +
     `body { overflow:hidden }` (para la app de paneles). En la vista en vivo hay
     que NEUTRALIZARLO a la fuerza (!important) o el mundo hereda ese encuadre y
     se ve corrido/encajonado. Reglas:
       • width:100% (NO 100vw → 100vw incluye el scrollbar y corre el contenido).
       • overflow-x:hidden + overflow-y:visible (AMBOS longhands: el shorthand
         `overflow:hidden` de index.html dejaría overflow-y hidden y el mundo no
         scrollearía).
       • display:block (por si algún día #app fuera flex/grid). */
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
  min-height: 100% !important;
  height: auto !important;
  overflow-x: hidden !important;
  overflow-y: visible !important;
  display: block !important;
  background: #fff;
}
.live-root {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-height: 100vh;
  overflow-x: hidden;
  margin: 0;
}
.live-waiting {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #666;
  font-size: 15px;
  background: #fafafa;
  text-align: center;
  padding: 24px;
}
.live-spinner {
  width: 38px;
  height: 38px;
  border: 3px solid rgba(0, 0, 0, 0.12);
  border-top-color: #444;
  border-radius: 50%;
  animation: live-spin 0.8s linear infinite;
}
@keyframes live-spin { to { transform: rotate(360deg); } }
.live-waiting-msg { margin: 0; max-width: 28rem; }
.live-back {
  position: fixed;
  top: 16px;
  left: 16px;
  z-index: 2147483000;
  background: rgba(20, 20, 20, 0.78);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  padding: 8px 16px;
  font: 600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}
.live-back:hover { background: rgba(20, 20, 20, 0.92); }
.live-fade {
  position: fixed;
  inset: 0;
  z-index: 40;
  opacity: 1;
  transition-property: opacity;
  transition-timing-function: ease;
  pointer-events: none; /* los clics pasan al mundo entrante de abajo */
  overflow: hidden;
}
.live-fade.is-out { opacity: 0; }
</style>
