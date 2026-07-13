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
// Presets de tamaños de dispositivo — los MISMOS del dropdown del canvas del
// editor (módulo puro, sin dependencia del store del editor).
import { MOBILE_PRESETS, DESKTOP_PRESETS } from '../constants/devicePresets'

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
// simulado (390×844 por defecto — configurable con el menú de tamaños)
// centrado en la pantalla, con un fondo neutro alrededor. El engine sigue
// pintando `mode="prod"` como siempre; el frame es puramente visual — como el
// simulador de Xcode o el modo mobile de Chrome DevTools. `vh`/`vw` resuelven
// naturalmente contra ese contenedor (ancho controlado por CSS).
//
// ── Menú de tamaños (mismos presets del canvas del editor) ──
// `simMobile` / `simDesktop` guardan el tamaño elegido por modo. En desktop
// hay además la opción "Ventana actual" (default) = comportamiento histórico:
// el mundo ocupa la ventana real, sin frame ni remap. Con un preset desktop
// activo, el frame se encaja con `zoom` CSS si es más ancho que la ventana
// (Chrome/Electron only — el editor no corre en otros browsers).
const simMobile = ref({ width: 390, height: 844 })
const simDesktop = ref<{ width: number; height: number } | null>(null) // null = ventana actual
const sizeMenuOpen = ref(false)
const customW = ref(390)
const customH = ref(844)
// Ancho real de la ventana (reactivo a resize) para el zoom-to-fit desktop.
const winW = ref(typeof window !== 'undefined' ? window.innerWidth : 1440)
function onWinResize() { winW.value = window.innerWidth }

const activeFrame = computed(() =>
  deviceMode.value === 'mobile' ? simMobile.value : simDesktop.value,
)
const presetsForMode = computed(() =>
  deviceMode.value === 'mobile' ? MOBILE_PRESETS : DESKTOP_PRESETS,
)
const activePresetId = computed(() => {
  const f = activeFrame.value
  if (!f) return null
  const match = presetsForMode.value.find((p) => p.width === f.width && p.height === f.height)
  return match ? match.id : null
})
// "Personalizado" activo = hay frame pero no coincide con ningún preset.
const isCustomSize = computed(() => activeFrame.value !== null && activePresetId.value === null)
const sizeButtonLabel = computed(() => {
  const f = activeFrame.value
  return f ? `${f.width}×${f.height}` : t('live.fitWindow')
})

const controlsRef = ref<HTMLElement | null>(null)
function onDocMouseDown(e: MouseEvent) {
  // Click fuera de la barra (y su desplegable) → cierra el menú y deja que
  // el auto-hide vuelva a mandar.
  if (controlsRef.value && !controlsRef.value.contains(e.target as Node)) {
    sizeMenuOpen.value = false
    document.removeEventListener('mousedown', onDocMouseDown, true)
    scheduleHide(600)
  }
}
function toggleSizeMenu() {
  sizeMenuOpen.value = !sizeMenuOpen.value
  if (sizeMenuOpen.value) {
    const f = activeFrame.value
    customW.value = f?.width ?? (deviceMode.value === 'mobile' ? 390 : 1440)
    customH.value = f?.height ?? (deviceMode.value === 'mobile' ? 844 : 900)
    document.addEventListener('mousedown', onDocMouseDown, true)
  } else {
    document.removeEventListener('mousedown', onDocMouseDown, true)
  }
}
function pickSizePreset(id: string) {
  const p = presetsForMode.value.find((x) => x.id === id)
  if (!p) return
  applyFrameSize({ width: p.width, height: p.height })
  sizeMenuOpen.value = false
}
function pickFitWindow() {
  // Solo existe en desktop: vuelve al comportamiento sin frame.
  simDesktop.value = null
  sizeMenuOpen.value = false
}
function applyCustomSize() {
  const w = Number(customW.value)
  const h = Number(customH.value)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200) return
  applyFrameSize({ width: Math.round(w), height: Math.round(h) })
}
function applyFrameSize(size: { width: number; height: number }) {
  if (deviceMode.value === 'mobile') simMobile.value = size
  else simDesktop.value = size
}
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
    // Con el menú de tamaños abierto la barra no se oculta jamás (el mouse
    // puede estar sobre el desplegable, fuera del strip de la barra).
    if (!inHotZone && !sizeMenuOpen.value) controlsVisible.value = false
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
  // El menú de tamaños es POR MODO (presets distintos) — se cierra al cambiar.
  sizeMenuOpen.value = false
}
// Estilo del contenedor del engine. Sin frame activo (desktop "Ventana
// actual"): nada — el mundo ocupa la ventana. Con frame (móvil siempre;
// desktop con preset): ancho fijo + minHeight del tamaño elegido, centrado.
// `overflow:hidden` + borderRadius para el look de dispositivo. Si el frame
// es más ancho que la ventana (p.ej. PC 2K en un laptop), `zoom` lo encaja —
// el remap vw/vh ya convirtió a px, así que el zoom escala todo uniforme.
const stageStyle = computed<Record<string, string>>(() => {
  const f = activeFrame.value
  if (!f) return {}
  const isMobile = deviceMode.value === 'mobile'
  const fit = Math.min(1, (winW.value - 48) / f.width)
  const style: Record<string, string> = {
    width: `${f.width}px`,
    maxWidth: `${f.width}px`,
    minHeight: `${f.height}px`,
    margin: '0 auto',
    boxShadow: '0 0 0 1px rgba(255,255,255,.08), 0 20px 60px rgba(0,0,0,.35)',
    background: '#fff',
    // Radio de 24px que evoca la esquina de un teléfono en móvil; en desktop
    // un radio más sobrio de monitor/ventana.
    borderRadius: isMobile ? '24px' : '10px',
    overflow: 'hidden',
  }
  if (fit < 1) style.zoom = String(fit)
  return style
})
// The engine-ready render copy: shared asset-prefix + active-view resolution.
// Con un frame activo (móvil siempre; desktop con preset) remapeamos `vw`/`vh`
// a `px` contra el tamaño del frame, así el engine se comporta como si ese
// frame fuera el viewport real. Sin frame (desktop "Ventana actual") NO se
// remapea — resuelven contra el viewport real como en el sitio publicado.
const previewSite = computed(() => {
  if (!rawSite.value) return null
  try {
    const base = buildPreviewSite(
      rawSite.value,
      validType ? projectType : null,
      currentSlug.value,
      deviceMode.value,
    )
    const f = activeFrame.value
    if (f && base) {
      return remapSiteViewportUnits(base, { width: f.width, height: f.height })
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
  // Discovery inicial de los controles: visibles 2.5s y luego se ocultan.
  // Debe armarse ANTES del early-return de "proyecto inválido" — la barra
  // existe también en la pantalla de espera/error y sin esto quedaba
  // visible para siempre en esa ruta.
  controlsVisible.value = true
  scheduleHide(2500)
  window.addEventListener('resize', onWinResize)
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
  window.removeEventListener('resize', onWinResize)
  document.removeEventListener('mousedown', onDocMouseDown, true)
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
      ref="controlsRef"
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

      <span class="live-controls-sep" aria-hidden="true" />

      <!-- Tamaño del dispositivo: mismos presets del canvas del editor. -->
      <button
        type="button"
        class="live-size-btn"
        :aria-expanded="sizeMenuOpen"
        data-test="live-size-toggle"
        @click="toggleSizeMenu"
      >
        <span class="live-size-value">{{ sizeButtonLabel }}</span>
        <span class="live-size-caret" aria-hidden="true">▾</span>
      </button>

      <!-- Desplegable anclado a la barra (dentro de .live-controls para que
           el hover lo cuente como "en la barra" y no se auto-oculte). -->
      <div v-if="sizeMenuOpen" class="live-size-menu" role="menu" data-test="live-size-menu">
        <div class="lsm-title">{{ deviceMode === 'mobile' ? t('mobileSize.titleMobile') : t('mobileSize.titleDesktop') }}</div>
        <button
          v-if="deviceMode === 'desktop'"
          type="button"
          :class="['lsm-item', { active: !activeFrame }]"
          role="menuitemradio"
          :aria-checked="!activeFrame"
          data-test="live-size-fit-window"
          @click="pickFitWindow"
        >
          <span class="lsm-check">{{ !activeFrame ? '✓' : '' }}</span>
          <span class="lsm-label">{{ t('live.fitWindow') }}</span>
        </button>
        <button
          v-for="p in presetsForMode"
          :key="p.id"
          type="button"
          :class="['lsm-item', { active: activePresetId === p.id }]"
          role="menuitemradio"
          :aria-checked="activePresetId === p.id"
          :data-test="`live-size-preset-${p.id}`"
          @click="pickSizePreset(p.id)"
        >
          <span class="lsm-check">{{ activePresetId === p.id ? '✓' : '' }}</span>
          <span class="lsm-label">{{ p.label }}</span>
          <span class="lsm-dim">{{ p.width }}×{{ p.height }}</span>
        </button>
        <div class="lsm-sep" />
        <div :class="['lsm-custom', { active: isCustomSize }]">
          <span class="lsm-check">{{ isCustomSize ? '✓' : '' }}</span>
          <span class="lsm-label">{{ t('mobileSize.custom') }}</span>
          <div class="lsm-inputs">
            <input
              type="number"
              v-model.number="customW"
              min="200"
              max="3840"
              :aria-label="t('mobileSize.customWidth')"
              data-test="live-size-custom-width"
              @keydown.enter="applyCustomSize"
            />
            <span class="lsm-times">×</span>
            <input
              type="number"
              v-model.number="customH"
              min="200"
              max="3840"
              :aria-label="t('mobileSize.customHeight')"
              data-test="live-size-custom-height"
              @keydown.enter="applyCustomSize"
            />
            <button type="button" class="lsm-apply" data-test="live-size-custom-apply" @click="applyCustomSize">{{ t('mobileSize.apply') }}</button>
          </div>
        </div>
      </div>
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

/* ── Menú de tamaños de dispositivo (mismos presets del canvas) ────────── */
.live-controls-sep {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.16);
  margin: 0 2px;
  flex: none;
}
.live-size-btn {
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
  transition: background 0.12s, color 0.12s;
}
.live-size-btn:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.live-size-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.live-size-caret { font-size: 9px; opacity: 0.8; }

/* Desplegable anclado bajo la barra. Vive DENTRO de .live-controls, así el
   mouseenter de la barra lo cubre y el auto-hide no lo mata mientras eliges. */
.live-size-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 252px;
  background: rgba(24, 24, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  max-height: 70vh;
  overflow-y: auto;
  text-align: left;
}
.lsm-title { font-size: 11px; color: #8a8a94; padding: 4px 8px 6px; font-weight: 600; }
.lsm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  color: #ccc;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.lsm-item:hover { background: rgba(255, 255, 255, 0.07); color: #fff; }
.lsm-item.active { color: #fff; }
.lsm-check { width: 12px; color: var(--accent-strong, #4a9eff); font-size: 12px; flex-shrink: 0; }
.lsm-label { flex: 1; font-weight: 500; }
.lsm-dim { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a8a94; font-size: 11px; }
.lsm-sep { height: 1px; background: rgba(255, 255, 255, 0.12); margin: 6px 4px; }
.lsm-custom { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; flex-wrap: wrap; font-size: 12px; color: #ccc; }
.lsm-custom.active { color: #fff; }
.lsm-inputs { display: flex; align-items: center; gap: 4px; width: 100%; margin-top: 6px; padding-left: 20px; }
.lsm-inputs input {
  width: 64px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: #eee;
  border-radius: 5px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.lsm-inputs input:focus { outline: none; border-color: var(--accent-strong, #4a9eff); }
.lsm-times { color: #8a8a94; }
.lsm-apply {
  background: var(--accent, #0066cc);
  border: none;
  color: var(--accent-fg, #fff);
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.lsm-apply:hover { background: var(--accent-hover, #157ae0); }
</style>
