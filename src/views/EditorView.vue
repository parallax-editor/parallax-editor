<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { projectsApi, gitApi } from '../composables/useApi'
import { useShortcuts } from '../composables/useShortcuts'
import { useWebSocket } from '../composables/useWebSocket'
import { state, loadSite, isDirty } from '../stores/editor'
import { validateSite, assignIds } from 'parallax-engine/schema'
import Toolbar from '../components/toolbar/Toolbar.vue'
import EditorCanvas from '../components/canvas/EditorCanvas.vue'
import LayersPanel from '../components/layers/LayersPanel.vue'
import PropertiesPanel from '../components/properties/PropertiesPanel.vue'
import ClaudePanel from '../components/claude/ClaudePanel.vue'
import GitPanel from '../components/git/GitPanel.vue'

const props = defineProps<{ type: string; slug: string }>()
const router = useRouter()
const loading = ref(true)
const bottomPanel = ref<'claude' | 'git' | null>(null)

async function loadProject() {
  loading.value = true
  const data = await projectsApi.get(props.type, props.slug)
  if (!data || data.error) {
    alert('Proyecto no encontrado')
    router.push('/')
    return
  }
  const result = validateSite(data)
  if (!result.ok) {
    state.errors = result.errors.map((e) => `${e.path}: ${e.message}`)
  }
  const site = result.ok ? assignIds(result.data) : assignIds(data as any)
  loadSite(site, props.type as any, props.slug)
  loading.value = false
}

async function save() {
  if (!state.site || !state.projectType || !state.slug) return
  await projectsApi.save(state.projectType, state.slug, state.site)
  await gitApi.commit(state.projectType, `edit: ${state.slug}`)
  state.originalSite = JSON.stringify(state.site)
}

// File watcher: reload on external changes
useWebSocket((data) => {
  if (data.type === 'file-changed' && state.slug && data.path?.includes(state.slug)) {
    loadProject()
  }
})

useShortcuts(save)

onMounted(loadProject)
</script>

<template>
  <div v-if="loading" class="loading-screen">Cargando...</div>
  <div v-else class="editor-layout">
    <Toolbar
      @save="save"
      @close="router.push('/')"
      @toggle-claude="bottomPanel = bottomPanel === 'claude' ? null : 'claude'"
      @toggle-git="bottomPanel = bottomPanel === 'git' ? null : 'git'"
    />
    <div class="editor-body">
      <LayersPanel class="panel-left" />
      <div class="canvas-area">
        <EditorCanvas />
        <div v-if="bottomPanel" class="bottom-panel">
          <ClaudePanel v-if="bottomPanel === 'claude'" @reload="loadProject" />
          <GitPanel v-if="bottomPanel === 'git'" />
        </div>
      </div>
      <PropertiesPanel class="panel-right" />
    </div>
  </div>
</template>

<style scoped>
.loading-screen { display: flex; align-items: center; justify-content: center; height: 100vh; color: #888; }
/* Root is a fixed-height column: 100dvh (falls back to vh) so the whole
   layout is height-bounded. min-height:0 lets the flex children actually
   shrink instead of growing to content. */
.editor-layout { display: flex; flex-direction: column; height: 100vh; height: 100dvh; min-height: 0; }
/* The body row must (a) be height-bounded and (b) stretch its children to
   that height so each panel gets a DEFINITE height to scroll within.
   align-items:stretch is the default but is stated explicitly because the
   panel's own internal scroll depends on this constraint propagating. */
.editor-body { display: flex; flex: 1 1 0; min-height: 0; overflow: hidden; align-items: stretch; }
/* Panels manage their own internal scroll (fixed header + scrollable body),
   so the outer container must NOT scroll — otherwise the header scrolls away
   and a double scrollbar appears. flex:0 0 <w> fixes the width on the main
   axis; align-self:stretch + min-height:0 + height:100% guarantees the panel
   root resolves to the body's height (so its .panel-body overflow triggers). */
.panel-left {
  flex: 0 0 240px; width: 240px; border-right: 1px solid #333;
  overflow: hidden; align-self: stretch; height: 100%; min-height: 0;
}
.panel-right {
  flex: 0 0 280px; width: 280px; border-left: 1px solid #333;
  overflow: hidden; align-self: stretch; height: 100%; min-height: 0;
}
.canvas-area { flex: 1 1 0; display: flex; flex-direction: column; position: relative; overflow: hidden; min-height: 0; min-width: 0; }
.bottom-panel { height: 200px; border-top: 1px solid #333; overflow-y: auto; flex-shrink: 0; }
</style>
