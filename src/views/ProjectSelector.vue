<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { projectsApi } from '../composables/useApi'

const router = useRouter()
const projects = ref<{ eventos: any[]; site: any[] }>({ eventos: [], site: [] })
const loading = ref(true)
const newSlug = ref('')
const showCreate = ref<string | null>(null)

onMounted(async () => {
  projects.value = await projectsApi.list()
  loading.value = false
})

function openProject(type: string, slug: string) {
  router.push(`/edit/${type}/${slug}`)
}

async function createNew() {
  if (!showCreate.value || !newSlug.value.trim()) return
  const slug = newSlug.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  await projectsApi.create(showCreate.value, slug)
  projects.value = await projectsApi.list()
  showCreate.value = null
  newSlug.value = ''
}

async function duplicate(type: string, slug: string) {
  await projectsApi.duplicate(type, slug)
  projects.value = await projectsApi.list()
}

async function remove(type: string, slug: string) {
  if (!confirm(`Eliminar "${slug}"? Esta accion no se puede deshacer.`)) return
  await projectsApi.delete(type, slug)
  projects.value = await projectsApi.list()
}
</script>

<template>
  <div class="selector">
    <h1 class="title">Parallax Editor</h1>
    <p class="subtitle">Selecciona un proyecto para editar</p>

    <div v-if="loading" class="loading">Cargando proyectos...</div>

    <template v-else>
      <div v-for="(label, type) in { eventos: 'Eventos', site: 'Portafolio' }" :key="type" class="project-group">
        <div class="group-header">
          <h2>{{ label }}</h2>
          <button class="btn-small" @click="showCreate = type as string">+ Nuevo</button>
        </div>

        <div v-if="(projects as any)[type]?.length === 0" class="empty">
          No hay proyectos aun.
        </div>

        <div
          v-for="p in (projects as any)[type]"
          :key="p.slug"
          class="project-card"
          @click="openProject(type as string, p.slug)"
        >
          <span class="project-title">{{ p.title }}</span>
          <span class="project-slug">{{ p.slug }}</span>
          <div class="project-actions" @click.stop>
            <button @click="duplicate(type as string, p.slug)" title="Duplicar">&#x2398;</button>
            <button @click="remove(type as string, p.slug)" title="Eliminar" class="danger">&#x2715;</button>
          </div>
        </div>
      </div>

      <!-- Create dialog -->
      <div v-if="showCreate" class="create-dialog">
        <h3>Nuevo {{ showCreate === 'eventos' ? 'evento' : 'mundo' }}</h3>
        <input
          v-model="newSlug"
          placeholder="nombre-en-kebab-case"
          @keydown.enter="createNew"
          autofocus
        />
        <div class="dialog-actions">
          <button @click="showCreate = null">Cancelar</button>
          <button class="primary" @click="createNew">Crear</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.selector { max-width: 700px; margin: 0 auto; padding: 60px 24px; }
.title { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
.subtitle { color: #888; margin-bottom: 40px; }
.loading { color: #888; }
.project-group { margin-bottom: 32px; }
.group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.group-header h2 { font-size: 18px; font-weight: 600; }
.btn-small { background: #333; border: 1px solid #555; color: #e0e0e0; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn-small:hover { background: #444; }
.empty { color: #666; font-size: 14px; padding: 12px 0; }
.project-card { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #252525; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: background 0.15s; }
.project-card:hover { background: #333; }
.project-title { font-weight: 500; flex: 1; }
.project-slug { color: #888; font-size: 13px; font-family: monospace; }
.project-actions { display: flex; gap: 4px; }
.project-actions button { background: none; border: none; color: #888; cursor: pointer; padding: 4px 8px; border-radius: 4px; font-size: 16px; }
.project-actions button:hover { background: #444; color: #e0e0e0; }
.project-actions .danger:hover { color: #f66; }
.create-dialog { background: #252525; border-radius: 12px; padding: 24px; margin-top: 24px; }
.create-dialog h3 { margin-bottom: 12px; }
.create-dialog input { width: 100%; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; background: #1a1a1a; color: #e0e0e0; font-size: 14px; margin-bottom: 12px; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
.dialog-actions button { padding: 8px 16px; border: 1px solid #555; border-radius: 6px; background: #333; color: #e0e0e0; cursor: pointer; }
.dialog-actions .primary { background: #0066cc; border-color: #0066cc; }
</style>
