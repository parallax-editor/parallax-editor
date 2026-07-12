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
import { useI18n } from 'vue-i18n'
import { ParallaxSite, FormBlock } from '@parallax-editor/parallax-engine'

const { t } = useI18n()
import { validateSite, type Site } from '@parallax-editor/parallax-engine/schema'
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
// Remap de `vw`/`vh` a `px` cuando el usuario simula un móvil dentro de la
// ventana real. Sin esto, el engine seguiría midiendo `vw` contra
// window.innerWidth (grande) y los textos con `clamp(…,9vw,…)` desbordan por
// los bordes del frame 390.
import { remapSiteViewportUnits } from '../composables/useDeviceUnitRemap'

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
    document.title = t('live.titleWithSlug', { slug: targetSlug })
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

// ── Device toggle propio de la Vista en vivo ─────────────────────────────
// Antes SÓLO se hereda del editor por `applyPayload`. Ahora hay UI para
// cambiarlo directamente aquí — así puedes tener el editor en Desktop y ver
// en vivo cómo se rendería en Móvil sin salir de esta pestaña.
//
// Cuando el usuario elige Móvil, envolvemos <ParallaxSite> en un frame
// simulado 390×844 (el mismo tamaño lógico del artboard móvil del editor)
// centrado en la pantalla, con un fondo neutro alrededor. El engine sigue
// pintando `mode="prod"` como siempre; el frame es puramente visual — como el
// simulador de Xcode o el modo mobile de Chrome DevTools. `vh`/`vw` resuelven
// naturalmente contra ese contenedor (ancho controlado por CSS).
const MOBILE_W = 390
const MOBILE_H = 844
// Overlay de controles — feedback Josh (2ª iteración): con el mousemove global
// el escondido era "de suerte" porque CUALQUIER movimiento del mouse (que en
// una vista previa pasa todo el tiempo) reseteaba el timer y los dejaba
// visibles casi siempre. Rediseño estilo controles de video en fullscreen:
//   • Estado por defecto: OCULTOS.
//   • Reveal INTENCIONAL: hover strip transparente pegado al top del viewport
//     (48px de alto, ancho completo). Pasar el mouse por ahí los muestra.
//   • Se mantienen visibles mientras el mouse esté sobre el strip O sobre la
//     barra (mouseenter/leave abajo). Al salir, timer corto (600ms) y ocultar.
//   • Discovery inicial: al montar los mostramos 2.5s para que el usuario los
//     descubra; después se ocultan y ya funcionan a demanda.
const controlsVisible = ref(true)
let hideTimer: ReturnType<typeof setTimeout> | null = null
let inHotZone = false
function scheduleHide(delay: number) {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!inHotZone) controlsVisible.value = false
  }, delay)
}
function onHotZoneEnter() {
  inHotZone = true
  controlsVisible.value = true
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}
function onHotZoneLeave() {
  inHotZone = false
  scheduleHide(600)
}
function setDevice(m: DeviceMode) {
  deviceMode.value = m
  // No forzamos visibilidad extra: el usuario ya está encima de la barra.
}
// Estilo del contenedor del engine. En desktop: no aplicamos nada (el mundo
// ocupa la ventana). En mobile: ancho fijo 390 y `min-height:844`, centrado
// horizontalmente. `overflow:visible` para no cortar posibles secciones más
// altas — el usuario scrollea dentro de la ventana como en el móvil real.
const stageStyle = computed<Record<string, string>>(() => {
  if (deviceMode.value !== 'mobile') return {}
  return {
    width: `${MOBILE_W}px`,
    maxWidth: `${MOBILE_W}px`,
    minHeight: `${MOBILE_H}px`,
    margin: '0 auto',
    boxShadow: '0 0 0 1px rgba(255,255,255,.08), 0 20px 60px rgba(0,0,0,.35)',
    background: '#fff',
    // Radio de 24px que evoca la esquina de un iPhone sin caer en el "chrome
    // completo" con notch etc. — sobrio pero claro.
    borderRadius: '24px',
    overflow: 'hidden',
  }
})
// The engine-ready render copy: shared asset-prefix + active-view resolution.
// En modo mobile-sim adicionalmente remapeamos `vw`/`vh` a `px` contra
// 390×844 (el frame simulado), así el engine se comporta como si estuviera en
// un móvil real dentro de una ventana grande. En desktop NO se remapea —
// resuelven contra el viewport real como en el sitio publicado.
const previewSite = computed(() => {
  if (!rawSite.value) return null
  try {
    const base = buildPreviewSite(
      rawSite.value,
      validType ? projectType : null,
      currentSlug.value,
      deviceMode.value,
    )
    if (deviceMode.value === 'mobile' && base) {
      return remapSiteViewportUnits(base, { width: MOBILE_W, height: MOBILE_H })
    }
    return base
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
  document.title = originalSlug ? t('live.titleWithSlug', { slug: originalSlug }) : t('live.title')
  if (!validType || !originalSlug) {
    errorMsg.value = t('live.missingProject')
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
  // Discovery inicial: visibles 2.5s al montar y luego se ocultan. Después
  // los revela el hot-zone del borde superior (v-on en la template).
  controlsVisible.value = true
  scheduleHide(2500)
  if (rawSite.value === null) {
    errorMsg.value = t('live.waitingForData')
  }
})

onBeforeUnmount(() => {
  if (channel) {
    channel.onmessage = null
    channel.close()
    channel = null
  }
  window.removeEventListener('storage', onStorage)
  if (hideTimer) clearTimeout(hideTimer)
})
</script>

<template>
  <!-- Full real viewport, NO editor chrome. En móvil envolvemos el engine en
       un "frame" 390×844 centrado; el fondo alrededor es la ventana real. -->
  <div
    class="live-root"
    :class="{ 'is-mobile-sim': deviceMode === 'mobile' }"
    data-test="live-root"
  >
    <!-- Botón Volver: aparece tras navegar a otro sitio (link.site). -->
    <button v-if="backStack.length" class="live-back" type="button" @click="goBack" data-test="live-back">
      {{ t('live.backBtn') }}
    </button>

    <!-- Hot-zone: banda invisible pegada al borde superior. Al entrar el
         mouse aquí, se revela la barra; al salir (y no estar sobre la barra),
         se oculta a los 600ms. Es la ÚNICA manera de mostrarlos después del
         discovery inicial → nunca aparecen por movimiento accidental. -->
    <div
      class="live-controls-hotzone"
      data-test="live-controls-hotzone"
      @mouseenter="onHotZoneEnter"
      @mouseleave="onHotZoneLeave"
    />

    <!-- Barra flotante de controles (Ver como: 🖥 / 📱). Reveal por hot-zone
         del borde superior. Copia el mismo copy del toolbar del editor. -->
    <div
      class="live-controls"
      :class="{ 'is-visible': controlsVisible }"
      data-test="live-controls"
      aria-label="Vista"
      @mouseenter="onHotZoneEnter"
      @mouseleave="onHotZoneLeave"
    >
      <span class="live-controls-label">{{ t('toolbar.previewViewingAs') }}</span>
      <button
        type="button"
        class="live-device-btn"
        :class="{ active: deviceMode === 'desktop' }"
        data-test="live-device-desktop"
        @click="setDevice('desktop')"
      >&#x1F4BB; <span class="live-device-lbl">{{ t('toolbar.desktop') }}</span></button>
      <button
        type="button"
        class="live-device-btn"
        :class="{ active: deviceMode === 'mobile' }"
        data-test="live-device-mobile"
        @click="setDevice('mobile')"
      >&#x1F4F1; <span class="live-device-lbl">{{ t('toolbar.mobile') }}</span></button>
    </div>

    <!-- Contenedor del engine. Si es mobile, aplicamos ancho fijo + centrado y
         encajamos el <ParallaxSite> adentro, así `vw`/`vh` resuelven contra el
         frame (no contra la ventana real) y ves EXACTAMENTE el layout móvil. -->
    <div class="live-stage" :style="stageStyle">
      <ParallaxSite
        v-if="previewSite"
        :key="nonce"
        :site="previewSite"
        :components="components"
        mode="prod"
        @navigate="go"
      />
    </div>

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
      <span v-if="!errorMsg" class="live-spinner" :aria-label="t('live.waiting')" role="status" />
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

/* ── Simulador móvil ─────────────────────────────────────────────────────
   En modo mobile, el fondo detrás del frame 390×844 se pinta oscuro para que
   el frame blanco resalte como una "pantalla" flotante. Padding vertical
   generoso: si la composición es más alta que 844, el usuario scrollea la
   ventana real y el frame se mueve con él (natural). */
.live-root.is-mobile-sim {
  min-height: 100vh;
  padding: 32px 0;
  background: #1a1a1a;
}
.live-root.is-mobile-sim :deep(body) { background: #1a1a1a; }

/* Hot-zone del borde superior: invisible, ancho completo, 48px de alto.
   Detecta mouseenter/leave para revelar/ocultar la barra a demanda. z-index
   ligeramente por debajo de la barra para que hover-through-controls funcione
   sin flicker. pointer-events auto para que reciba el hover. */
.live-controls-hotzone {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 48px;
  z-index: 2147482999;
  pointer-events: auto;
  background: transparent;
}

/* ── Overlay de controles (Bloque C5) ───────────────────────────────────
   Barra chica flotante top-center. Fade in/out con la clase `is-visible`.
   Elevada por encima del engine (mismo stacking que .live-back). El
   backdrop-filter le da profundidad sin ocupar visualmente. */
.live-controls {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  background: rgba(20, 20, 20, 0.78);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  font: 600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.live-controls.is-visible { opacity: 1; pointer-events: auto; }
.live-controls-label {
  font-size: 11px;
  font-weight: 500;
  color: #b4b4b4;
  margin-right: 4px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.live-device-btn {
  background: transparent;
  color: #d6d6d6;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 4px 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: 600 12px inherit;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.live-device-btn:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.live-device-btn.active {
  background: rgba(255, 213, 109, 0.16);
  color: #ffe2a3;
  border-color: rgba(255, 213, 109, 0.4);
}
.live-device-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
</style>
