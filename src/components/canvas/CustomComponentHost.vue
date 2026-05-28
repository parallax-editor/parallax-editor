<script setup lang="ts">
import {
  ref,
  shallowRef,
  watch,
  onErrorCaptured,
  computed,
  type Component,
} from 'vue'

// Best-effort resolver + error boundary for ONE custom component instance
// rendered inside the canvas preview. Workspaces can register custom Vue
// components via `parallax.config.ts`; if the SFC can be resolved at runtime
// it renders, otherwise we show a RED placeholder ("Componente <Name>
// falló: <error>") instead of crashing the whole <ParallaxSite> preview.
//
// KNOWN LIMITATION: Vite's `import.meta.glob` is build-time and only works
// against the editor's own source tree. Workspaces live wherever the user
// picks them with the native folder picker — there is no static path that
// can reach them. As a convenience we glob `../../../../*/components/*.vue`
// so a workspace cloned **next to parallax-editor on the same machine** has
// its components rendered in preview; arbitrary-path workspaces always fall
// through to the placeholder. A proper server-side bundler that compiles the
// active workspace's SFC and serves it over HTTP for runtime import is the
// planned fix (tracked as a follow-up; see CONTRIBUTING). The placeholder
// keeps the editor usable in the meantime: layout/size are accurate, the
// real component renders correctly in the published site.

const props = defineProps<{
  name: string
  // Props forwarded verbatim to the resolved SFC (el.props from the schema).
  componentProps: Record<string, unknown>
}>()

const SFC_MODULES = import.meta.glob(
  '../../../../*/components/*.vue',
) as Record<string, () => Promise<{ default: Component }>>

// Build a name → loader map keyed by the file's basename (component name).
const LOADERS: Record<string, () => Promise<{ default: Component }>> = {}
for (const [path, loader] of Object.entries(SFC_MODULES)) {
  const base = path.split('/').pop()?.replace(/\.vue$/, '')
  if (base) LOADERS[base] = loader
}

const resolved = shallowRef<Component | null>(null)
const failure = ref<string | null>(null)

// Resolve (or re-resolve) whenever the component name changes. A missing
// loader or a rejected import → recorded as a failure (placeholder shown);
// never throws out of here.
watch(
  () => props.name,
  async (name) => {
    resolved.value = null
    failure.value = null
    const loader = LOADERS[name]
    if (!loader) {
      failure.value = `no encontrado en ningún <workspace>/components/${name}.vue`
      return
    }
    try {
      const mod = await loader()
      resolved.value = mod?.default ?? null
      if (!resolved.value) failure.value = 'el archivo no exporta un componente'
    } catch (e: any) {
      failure.value = e?.message || String(e)
    }
  },
  { immediate: true },
)

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
