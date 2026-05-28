<script setup lang="ts">
import {
  ref,
  shallowRef,
  watch,
  onErrorCaptured,
  computed,
  type Component,
} from 'vue'
import { wsState } from '../../stores/workspaces'
import { useWebSocket } from '../../composables/useWebSocket'

// Best-effort resolver + error boundary for ONE custom component instance
// rendered inside the canvas preview. Workspaces can register custom Vue
// components via `parallax.config.ts`; if the SFC can be resolved at runtime
// it renders, otherwise we show a RED placeholder ("Componente <Name>
// falló: <error>") instead of crashing the whole <ParallaxSite> preview.
//
// The editor server compiles the active workspace's <workspace>/components/
// <Name>.vue file on demand (server/sfcBundler.ts) and serves it as ESM
// from /api/workspaces/:id/components/:name.js. We import it dynamically;
// the file watcher (server/watcher.ts) invalidates the server cache AND
// broadcasts a `component-changed` so the canvas re-imports without a full
// editor reload. Cache-bust via ?v=<bump> when a change message arrives.

const props = defineProps<{
  name: string
  // Props forwarded verbatim to the resolved SFC (el.props from the schema).
  componentProps: Record<string, unknown>
}>()

const resolved = shallowRef<Component | null>(null)
const failure = ref<string | null>(null)
const cacheBust = ref(0)

const endpointUrl = computed(() => {
  const wsId = wsState.activeId
  if (!wsId || !props.name) return ''
  const bust = cacheBust.value ? `?v=${cacheBust.value}` : ''
  return `/api/workspaces/${encodeURIComponent(wsId)}/components/${encodeURIComponent(props.name)}.js${bust}`
})

async function load(name: string) {
  resolved.value = null
  failure.value = null
  const url = endpointUrl.value
  if (!url) {
    failure.value = 'no hay workspace activo'
    return
  }
  try {
    // /* @vite-ignore */ disables Vite's static analysis on the dynamic
    // import so it doesn't try to bundle a workspace path it can't see.
    const mod = await import(/* @vite-ignore */ url)
    resolved.value = mod?.default ?? null
    if (!resolved.value) failure.value = 'el archivo no exporta un componente'
  } catch (e: any) {
    failure.value = e?.message || String(e)
  }
}

watch(() => props.name, (name) => { if (name) load(name) }, { immediate: true })

// Listen for `component-changed` from the server file watcher and re-import
// the SFC with a fresh cache-bust. Affects ALL CustomComponentHost
// instances mounted at the time — cheap because the server caches the
// compile result by mtime.
useWebSocket((payload: { type?: string } | undefined) => {
  if (payload?.type !== 'component-changed') return
  cacheBust.value = Date.now()
  if (props.name) load(props.name)
})

// Render-time errors (e.g. the SFC uses <NuxtLink> / a Nuxt-only API) are
// caught here so they don't propagate up and blow away the whole preview.
onErrorCaptured((err) => {
  failure.value = (err as any)?.message || String(err)
  resolved.value = null
  return false // stop propagation — keep the rest of the canvas alive
})

const placeholderText = computed(
  () => `Componente ${props.name} falló: ${failure.value || 'error desconocido'}`,
)
</script>

<template>
  <component
    :is="resolved"
    v-if="resolved && !failure"
    v-bind="componentProps || {}"
  />
  <div
    v-else-if="failure"
    class="custom-component-failed"
    data-test="custom-component-placeholder"
    :data-component-name="name"
    role="alert"
  >
    {{ placeholderText }}
  </div>
  <div v-else class="custom-component-loading" :data-component-name="name">
    Cargando {{ name }}…
  </div>
</template>

<style scoped>
/* PLAN §16: a clearly RED placeholder so a broken custom component is obvious
   in the canvas but never takes the editor down. */
.custom-component-failed {
  display: inline-block;
  max-width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  background: #3a1414;
  border: 1px solid #d23b3b;
  border-radius: 4px;
  color: #ff8a8a;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.4;
  white-space: normal;
  word-break: break-word;
}
.custom-component-loading {
  display: inline-block;
  padding: 6px 10px;
  color: #888;
  font-size: 12px;
}
</style>
