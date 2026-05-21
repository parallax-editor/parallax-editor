<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { projectsApi, workspaceApi, s3Api } from '../composables/useApi'
import type { ProjectListItem, Workspace } from '../composables/useApi'
import ProjectCard from '../components/selector/ProjectCard.vue'
import HelpHint from '../components/properties/HelpHint.vue'
// The SAME canonical slug transform the server uses to create the folder, so
// this live preview ALWAYS matches the folder/route that gets created.
import { slugify } from '../../server/slug'
import { useDialog } from '../composables/useDialog'
import {
  wsState,
  activeWorkspace,
  loadWorkspaces,
  selectWorkspace,
  addWorkspace,
  updateWorkspace,
  removeWorkspace,
  makeWorkspaceId,
} from '../stores/workspaces'

const router = useRouter()
const dialog = useDialog()
const projects = ref<ProjectListItem[]>([])
const loading = ref(true)
const wsError = ref<string | null>(null)

// Free-form NAME the human types (becomes meta.title / the HTML <title>).
const newName = ref('')
const showCreate = ref(false)
const creating = ref(false)
const slugPreview = computed(() => slugify(newName.value))
const nameInput = ref<HTMLInputElement | null>(null)

// ── Load: workspaces first, then the active workspace's projects ────────────
async function refreshProjects() {
  const ws = activeWorkspace.value
  if (!ws) {
    projects.value = []
    return
  }
  const r = await workspaceApi.projects(ws.id)
  projects.value = Array.isArray(r?.projects) ? r.projects : []
}

async function activateAndLoad() {
  wsError.value = null
  const ws = activeWorkspace.value
  if (!ws) {
    projects.value = []
    return
  }
  const r = await selectWorkspace(ws.id)
  if (!r?.ok) {
    wsError.value = r?.error || 'No se pudo activar el workspace.'
    projects.value = []
    return
  }
  await refreshProjects()
}

onMounted(async () => {
  document.addEventListener('keydown', onKey, true)
  if (!wsState.loaded) await loadWorkspaces()
  await activateAndLoad()
  loading.value = false
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

// Switch active workspace from the selector bar.
async function pickWorkspace(id: string) {
  if (id === wsState.activeId) return
  await selectWorkspace(id)
  search.value = ''
  await activateAndLoad()
}

// ── Search ──────────────────────────────────────────────────────────────────
const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
function norm(s: string): string {
  return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}
function matches(p: ProjectListItem, q: string): boolean {
  if (!q) return true
  return norm(p.title).includes(q) || norm(p.slug).includes(q)
}
function sortByRecent(list: ProjectListItem[]): ProjectListItem[] {
  return [...list].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return (a.title || a.slug).localeCompare(b.title || b.slug, 'es')
  })
}
const visibleProjects = computed(() => {
  const q = norm(search.value)
  return sortByRecent(projects.value).filter((p) => matches(p, q))
})

// ── Create / open / duplicate / delete (scoped to the active workspace) ──────
watch(showCreate, (v) => {
  if (v) nextTick(() => nameInput.value?.focus())
})
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showCreate.value) { e.stopPropagation(); showCreate.value = false; newName.value = '' }
    else if (wsConfigId.value) { e.stopPropagation(); wsConfigId.value = null }
    else if (showNewWs.value) { e.stopPropagation(); showNewWs.value = false }
  }
}

function openProject(slug: string) {
  const ws = activeWorkspace.value
  if (!ws) return
  router.push(`/edit/${ws.id}/${slug}`)
}

async function createNew() {
  const ws = activeWorkspace.value
  if (!ws || !newName.value.trim() || creating.value) return
  creating.value = true
  try {
    const r = await projectsApi.create(ws.id, newName.value.trim())
    const created = r?.slug
    const expected = slugPreview.value
    showCreate.value = false
    newName.value = ''
    if (created && expected && created !== expected) {
      await dialog.alert({
        title: 'Dirección en uso',
        message: `Ya existía un proyecto con esa dirección.\nSe creó como: "${created}"`,
      })
    }
    if (created) { openProject(created); return }
  } finally {
    creating.value = false
  }
}

async function duplicate(slug: string) {
  const ws = activeWorkspace.value
  if (!ws) return
  const proposed = await dialog.prompt({
    title: 'Duplicar proyecto',
    message: `Nombre para la copia de "${slug}"\n\nDéjalo vacío para usar un nombre automático (por ejemplo "${slug}-copia").`,
    defaultValue: `${slug}-copia`,
    confirmText: 'Duplicar',
  })
  if (proposed === null) return
  const r = await projectsApi.duplicate(ws.id, slug, proposed.trim() || undefined)
  await refreshProjects()
  if (r?.slug) await dialog.alert({ title: 'Copia creada', message: `Copia creada: "${r.slug}"` })
}

async function remove(slug: string) {
  const ws = activeWorkspace.value
  if (!ws) return
  const ok = await dialog.confirm({
    title: 'Eliminar proyecto',
    message: `Eliminar "${slug}"? Se borrará la carpeta del repositorio y, si está publicado, también de S3. Esta acción no se puede deshacer.`,
    confirmText: 'Eliminar',
    danger: true,
  })
  if (!ok) return
  await projectsApi.delete(ws.id, slug)
  await refreshProjects()
}

// ── Workspace config modal (gear) ─────────────────────────────────────────────
const wsConfigId = ref<string | null>(null)
const cfg = ref<Workspace>({ id: '', name: '', repoPath: '', contentRoot: 'content' })
const bucketSuggestions = ref<string[]>([])
const wsBusy = ref(false)
const wsModalError = ref<string | null>(null)

function openConfig(id: string) {
  const ws = wsState.list.find((w) => w.id === id)
  if (!ws) return
  // Deep clone so editing the form doesn't mutate the store until "Guardar".
  cfg.value = JSON.parse(JSON.stringify({
    id: ws.id, name: ws.name, repoPath: ws.repoPath, gitRemote: ws.gitRemote || '',
    contentRoot: ws.contentRoot,
    s3: ws.s3 ? { ...ws.s3 } : { enabled: false, bucket: '', prefix: '', region: 'us-east-1' },
  }))
  wsModalError.value = null
  wsConfigId.value = id
  void loadBuckets()
}

async function loadBuckets() {
  try {
    const r = await s3Api.buckets()
    if (r?.ok && Array.isArray(r.buckets)) bucketSuggestions.value = r.buckets
  } catch { /* offline / no creds — leave empty */ }
}

// ── Bucket combobox (Arreglo 2) ───────────────────────────────────────────────
// A real anchored dropdown (not the broken floating <datalist>): a text input
// with a list positioned BELOW it that filters bucketSuggestions as you type.
const bucketOpen = ref(false)
const bucketActiveIdx = ref(-1)
const filteredBuckets = computed<string[]>(() => {
  const q = (cfg.value.s3?.bucket || '').trim().toLowerCase()
  const list = bucketSuggestions.value
  if (!q) return list.slice(0, 50)
  return list.filter((b) => b.toLowerCase().includes(q)).slice(0, 50)
})
function pickBucket(name: string) {
  if (cfg.value.s3) cfg.value.s3.bucket = name
  bucketOpen.value = false
  bucketActiveIdx.value = -1
}
function onBucketInput() {
  bucketOpen.value = true
  bucketActiveIdx.value = -1
}
function onBucketFocus() {
  bucketOpen.value = true
}
function onBucketBlur() {
  // Delay so a click on a suggestion lands before we close.
  setTimeout(() => { bucketOpen.value = false; bucketActiveIdx.value = -1 }, 150)
}
function onBucketKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!bucketOpen.value) bucketOpen.value = true
    bucketActiveIdx.value = Math.min(bucketActiveIdx.value + 1, filteredBuckets.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    bucketActiveIdx.value = Math.max(bucketActiveIdx.value - 1, -1)
  } else if (e.key === 'Enter') {
    if (bucketOpen.value && bucketActiveIdx.value >= 0 && filteredBuckets.value[bucketActiveIdx.value]) {
      e.preventDefault()
      pickBucket(filteredBuckets.value[bucketActiveIdx.value])
    } else {
      bucketOpen.value = false
    }
  } else if (e.key === 'Escape') {
    bucketOpen.value = false
    bucketActiveIdx.value = -1
  }
}

async function pickRepoFolder() {
  const r = await workspaceApi.pickFolder()
  if (r?.ok && r.path) cfg.value.repoPath = r.path
}

async function createS3Bucket() {
  if (!cfg.value.s3?.bucket) return
  wsBusy.value = true
  try {
    const r = await s3Api.createBucket(cfg.value.s3.bucket, cfg.value.s3.region || 'us-east-1')
    if (!r?.ok) wsModalError.value = r?.error || 'No se pudo crear el bucket.'
    else await loadBuckets()
  } finally { wsBusy.value = false }
}

async function saveConfig() {
  if (!wsConfigId.value) return
  wsBusy.value = true
  wsModalError.value = null
  try {
    updateWorkspace(wsConfigId.value, {
      name: cfg.value.name,
      repoPath: cfg.value.repoPath,
      gitRemote: cfg.value.gitRemote || undefined,
      contentRoot: cfg.value.contentRoot,
      s3: cfg.value.s3,
    })
    // If we edited the active workspace, re-activate + reload projects.
    if (wsConfigId.value === wsState.activeId) {
      const r = await selectWorkspace(wsConfigId.value)
      if (!r?.ok) { wsModalError.value = r?.error || 'El host rechazó la configuración.'; return }
      await refreshProjects()
    }
    wsConfigId.value = null
  } finally { wsBusy.value = false }
}

async function deleteWorkspace() {
  if (!wsConfigId.value) return
  const ok = await dialog.confirm({
    title: 'Quitar workspace',
    message: '¿Quitar este workspace de la lista? (No borra archivos en disco.)',
    confirmText: 'Quitar',
    danger: true,
  })
  if (!ok) return
  removeWorkspace(wsConfigId.value)
  wsConfigId.value = null
  void activateAndLoad()
}

// ── New workspace modal ───────────────────────────────────────────────────────
const showNewWs = ref(false)
const newWs = ref({ name: '', repoPath: '', mode: 'folder' as 'folder' | 'clone', gitUrl: '', clonePath: '', contentRoot: 'content' })
const newWsBusy = ref(false)
const newWsError = ref<string | null>(null)

function openNewWs() {
  newWs.value = { name: '', repoPath: '', mode: 'folder', gitUrl: '', clonePath: '', contentRoot: 'content' }
  newWsError.value = null
  showNewWs.value = true
}

async function pickNewWsFolder() {
  const r = await workspaceApi.pickFolder()
  if (r?.ok && r.path) newWs.value.repoPath = r.path
}

// CLONE mode: the destination folder must NOT exist yet (git clone creates it).
// So the picker chooses the EXISTING CONTAINER folder, and we append the repo
// name derived from the GitHub URL (git@github.com:user/mi-repo.git → "mi-repo",
// https://github.com/user/mi-repo → "mi-repo"). If the URL can't yield a name
// yet, fall back to the workspace name in kebab-case, else "repo".
function repoNameFromGitUrl(url: string): string {
  const u = (url || '').trim()
  if (u) {
    // Take the last path segment after the final "/" or ":" and drop a ".git".
    const tail = u.replace(/[/:]+$/, '').split(/[/:]/).pop() || ''
    const name = slugify(tail.replace(/\.git$/i, ''))
    if (name) return name
  }
  return slugify(newWs.value.name) || 'repo'
}

async function pickNewWsClonePath() {
  const r = await workspaceApi.pickFolder()
  if (r?.ok && r.path) {
    const container = r.path.replace(/\/+$/, '')
    newWs.value.clonePath = `${container}/${repoNameFromGitUrl(newWs.value.gitUrl)}`
  }
}

async function createWorkspace() {
  newWsBusy.value = true
  newWsError.value = null
  try {
    let repoPath = newWs.value.repoPath.trim()
    if (newWs.value.mode === 'clone') {
      const r = await workspaceApi.clone(newWs.value.gitUrl.trim(), newWs.value.clonePath.trim())
      if (!r?.ok || !r.path) { newWsError.value = r?.error || 'No se pudo clonar.'; return }
      repoPath = r.path
    }
    if (!repoPath) { newWsError.value = 'Elige una carpeta o clona un repositorio.'; return }
    const name = newWs.value.name.trim() || repoPath.split('/').pop() || 'Workspace'
    const id = addWorkspace({
      name,
      repoPath,
      contentRoot: newWs.value.contentRoot.trim() || 'content',
      s3: { enabled: false, bucket: '', prefix: '', region: 'us-east-1' },
    })
    showNewWs.value = false
    const r = await selectWorkspace(id)
    if (!r?.ok) { wsError.value = r?.error || 'El host rechazó el workspace.'; return }
    await refreshProjects()
  } finally { newWsBusy.value = false }
}
</script>

<template>
  <div class="selector">
    <header class="hero">
      <div class="hero-text">
        <h1 class="title">Parallax Editor</h1>
        <p class="subtitle">Selecciona un proyecto para editar</p>
      </div>
    </header>

    <!-- Git setup banner (persistent until git is configured) -->
    <div v-if="wsState.gitConfigured === false" class="git-banner" data-test="git-config-banner">
      <strong>Falta configurar Git.</strong>
      Para guardar y publicar necesitas configurar tu usuario de Git en esta computadora
      (nombre y correo) y tener acceso a GitHub. Pídele ayuda a tu equipo técnico si no sabes cómo.
    </div>

    <!-- Workspace selector bar -->
    <div class="ws-bar" data-test="workspace-bar">
      <span class="ws-bar-label">Workspace</span>
      <div class="ws-chips">
        <div
          v-for="w in wsState.list"
          :key="w.id"
          class="ws-chip"
          :class="{ active: w.id === wsState.activeId }"
          :data-test="`workspace-chip-${w.id}`"
        >
          <button class="ws-chip-name" type="button" @click="pickWorkspace(w.id)">{{ w.name }}</button>
          <button
            class="ws-gear"
            type="button"
            :data-test="`workspace-gear-${w.id}`"
            aria-label="Configurar workspace"
            title="Configurar"
            @click="openConfig(w.id)"
          >&#9881;</button>
        </div>
        <button class="ws-new" type="button" data-test="workspace-new" @click="openNewWs">+ Nuevo workspace</button>
      </div>
    </div>

    <div v-if="wsError" class="ws-err" data-test="workspace-error">{{ wsError }}</div>

    <div class="search-bar">
      <span class="search-icon" aria-hidden="true">&#x1F50D;</span>
      <input
        ref="searchInput"
        v-model="search"
        type="search"
        class="search-input"
        data-test="project-search"
        placeholder="Buscar por nombre o dirección…"
        aria-label="Buscar proyectos"
        autocomplete="off"
      />
      <button v-if="search" type="button" class="search-clear" aria-label="Limpiar búsqueda" @click="search = ''">&times;</button>
    </div>

    <div v-if="loading" class="loading">Cargando proyectos...</div>

    <template v-else>
      <section class="project-group">
        <div class="group-header">
          <h2>{{ activeWorkspace?.name || 'Proyectos' }}</h2>
          <span class="group-count">{{ projects.length }}</span>
          <button class="btn-new" :disabled="!activeWorkspace" @click="showCreate = true">+ Nuevo proyecto</button>
        </div>

        <div v-if="!activeWorkspace" class="empty">
          No hay ningún workspace seleccionado. Crea uno con <strong>+ Nuevo workspace</strong>.
        </div>
        <div v-else-if="projects.length === 0" class="empty">
          Este workspace aún no tiene proyectos. Crea uno con <strong>+ Nuevo proyecto</strong>.
        </div>
        <div v-else-if="visibleProjects.length === 0" class="no-results" data-test="no-results">
          Sin resultados para “{{ search }}”.
        </div>
        <div v-else class="cards">
          <ProjectCard
            v-for="p in visibleProjects"
            :key="p.slug"
            :type="(activeWorkspace as Workspace).id"
            :project="p"
            @open="openProject(p.slug)"
            @duplicate="duplicate(p.slug)"
            @remove="remove(p.slug)"
          />
        </div>
      </section>
    </template>

    <!-- Create project modal -->
    <Teleport to="body">
      <div v-if="showCreate" class="create-backdrop" @click.self="showCreate = false">
        <div class="create-dialog" role="dialog" aria-label="Nuevo proyecto" data-test="create-dialog">
          <header class="cd-head">
            <h3>Nuevo proyecto</h3>
            <button class="cd-close" aria-label="Cerrar" @click="showCreate = false">&times;</button>
          </header>
          <div class="cd-body">
            <label class="field-label" for="new-site-name">Nombre del proyecto</label>
            <input
              id="new-site-name"
              ref="nameInput"
              v-model="newName"
              data-test="new-site-name"
              placeholder="Ej: Sofía &amp; Juan — 15 de marzo"
              @keydown.enter="createNew"
            />
            <div class="slug-caption">Dirección/carpeta: <code data-test="new-site-slug">{{ slugPreview || '—' }}</code></div>
            <p class="slug-hint">Se genera automático a partir del nombre.</p>
          </div>
          <div class="dialog-actions">
            <button @click="showCreate = false">Cancelar</button>
            <button class="primary" data-test="new-site-create" :disabled="!slugPreview || creating" @click="createNew">
              {{ creating ? 'Creando…' : 'Crear' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Workspace config modal -->
    <Teleport to="body">
      <div v-if="wsConfigId" class="create-backdrop" @click.self="wsConfigId = null">
        <div class="create-dialog wide" role="dialog" aria-label="Configurar workspace" data-test="workspace-config">
          <header class="cd-head">
            <h3>Configurar workspace</h3>
            <button class="cd-close" aria-label="Cerrar" @click="wsConfigId = null">&times;</button>
          </header>
          <div class="cd-body">
            <label class="field-label">Nombre</label>
            <input v-model="cfg.name" data-test="ws-cfg-name" placeholder="Eventos" />

            <label class="field-label">Carpeta del repositorio</label>
            <div class="row-with-btn">
              <input v-model="cfg.repoPath" data-test="ws-cfg-repopath" placeholder="/Users/…/mi-repo" />
              <button class="aux-btn" type="button" data-test="ws-cfg-pick" @click="pickRepoFolder">Elegir carpeta…</button>
            </div>

            <label class="field-label">Remoto de Git (opcional)</label>
            <input v-model="cfg.gitRemote" placeholder="git@github.com:usuario/repo.git" />

            <label class="field-label">Carpeta de contenido (contentRoot)</label>
            <input v-model="cfg.contentRoot" data-test="ws-cfg-contentroot" placeholder="content o content/portafolio" />

            <div class="s3-section" v-if="cfg.s3">
              <h4>Publicación en S3</h4>
              <label class="check-row">
                <input type="checkbox" v-model="cfg.s3.enabled" data-test="ws-cfg-s3-enabled" />
                Habilitar publicación a S3
              </label>
              <template v-if="cfg.s3.enabled">
                <label class="field-label">Bucket</label>
                <div class="bucket-combo">
                  <input
                    v-model="cfg.s3.bucket"
                    class="bucket-input"
                    data-test="ws-cfg-s3-bucket"
                    placeholder="mi-bucket"
                    autocomplete="off"
                    spellcheck="false"
                    @input="onBucketInput"
                    @focus="onBucketFocus"
                    @blur="onBucketBlur"
                    @keydown="onBucketKeydown"
                  />
                  <ul
                    v-if="bucketOpen && filteredBuckets.length"
                    class="bucket-list"
                    data-test="ws-cfg-s3-bucket-list"
                  >
                    <li
                      v-for="(b, i) in filteredBuckets"
                      :key="b"
                      class="bucket-opt"
                      :class="{ active: i === bucketActiveIdx }"
                      @mousedown.prevent="pickBucket(b)"
                      @mouseenter="bucketActiveIdx = i"
                    >{{ b }}</li>
                  </ul>
                </div>
                <div class="bucket-create-row">
                  <button class="aux-btn" type="button" :disabled="wsBusy || !cfg.s3.bucket" @click="createS3Bucket">Crear bucket</button>
                  <span class="bucket-create-hint">Crea el bucket en S3 con el nombre escrito (si aún no existe).</span>
                </div>

                <label class="field-label">Prefijo (opcional)</label>
                <input v-model="cfg.s3.prefix" placeholder="" />

                <label class="field-label">Región</label>
                <input v-model="cfg.s3.region" placeholder="us-east-1" />
              </template>

              <label class="check-row manifest-row">
                <input type="checkbox" v-model="cfg.s3.publishManifest" data-test="ws-cfg-s3-manifest" />
                Mantener manifiesto del catálogo (manifest.json)
                <HelpHint
                  label="Manifiesto del catálogo"
                  text="Genera y mantiene **&lt;contentRoot&gt;/manifest.json** con la lista de proyectos del workspace, para catálogos públicos.

» Apágalo en workspaces privados (por ejemplo invitaciones) para no exponer la lista de proyectos."
                />
              </label>
            </div>

            <p v-if="wsModalError" class="ws-err">{{ wsModalError }}</p>
          </div>
          <div class="dialog-actions spread">
            <button class="danger" data-test="ws-cfg-delete" @click="deleteWorkspace">Quitar workspace</button>
            <span class="spacer" />
            <button @click="wsConfigId = null">Cancelar</button>
            <button class="primary" data-test="ws-cfg-save" :disabled="wsBusy" @click="saveConfig">
              {{ wsBusy ? 'Guardando…' : 'Guardar' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- New workspace modal -->
    <Teleport to="body">
      <div v-if="showNewWs" class="create-backdrop" @click.self="showNewWs = false">
        <div class="create-dialog wide" role="dialog" aria-label="Nuevo workspace" data-test="new-workspace">
          <header class="cd-head">
            <h3>Nuevo workspace</h3>
            <button class="cd-close" aria-label="Cerrar" @click="showNewWs = false">&times;</button>
          </header>
          <div class="cd-body">
            <label class="field-label">Nombre del workspace</label>
            <input v-model="newWs.name" data-test="new-ws-name" placeholder="Ej: Eventos, Portafolio" />

            <div class="mode-tabs">
              <button :class="{ active: newWs.mode === 'folder' }" @click="newWs.mode = 'folder'" data-test="new-ws-mode-folder">Carpeta local</button>
              <button :class="{ active: newWs.mode === 'clone' }" @click="newWs.mode = 'clone'" data-test="new-ws-mode-clone">Clonar de GitHub</button>
            </div>

            <template v-if="newWs.mode === 'folder'">
              <label class="field-label">Carpeta del repositorio</label>
              <div class="row-with-btn">
                <input v-model="newWs.repoPath" data-test="new-ws-repopath" placeholder="/Users/…/mi-repo" />
                <button class="aux-btn" type="button" data-test="new-ws-repopath-pick" @click="pickNewWsFolder">Elegir carpeta…</button>
              </div>
            </template>
            <template v-else>
              <label class="field-label">URL de GitHub</label>
              <input v-model="newWs.gitUrl" data-test="new-ws-giturl" placeholder="git@github.com:usuario/repo.git" />
              <label class="field-label">Ruta local destino</label>
              <div class="row-with-btn">
                <input v-model="newWs.clonePath" data-test="new-ws-clonepath" placeholder="/Users/…/mi-repo" />
                <button class="aux-btn" type="button" data-test="new-ws-clonepath-pick" @click="pickNewWsClonePath">Elegir carpeta…</button>
              </div>
              <p class="slug-hint">Elige la carpeta contenedora; se le agrega el nombre del repo automáticamente (git clone crea la carpeta destino).</p>
            </template>

            <label class="field-label">Carpeta de contenido (contentRoot)</label>
            <input v-model="newWs.contentRoot" placeholder="content o content/portafolio" />

            <p v-if="newWsError" class="ws-err">{{ newWsError }}</p>
          </div>
          <div class="dialog-actions">
            <button @click="showNewWs = false">Cancelar</button>
            <button class="primary" data-test="new-ws-create" :disabled="newWsBusy" @click="createWorkspace">
              {{ newWsBusy ? 'Creando…' : 'Crear workspace' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.selector { height: 100vh; height: 100dvh; overflow-y: auto; padding: 56px 24px 80px; }
.selector > * { max-width: 760px; margin-left: auto; margin-right: auto; }

.hero { margin-bottom: 22px; }
.title {
  font-size: 30px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px;
  background: linear-gradient(90deg, #ffffff, #b9c4d6);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.subtitle { color: #8a8a8a; font-size: 14px; }
.loading { color: #888; padding: 24px 0; }

/* Git banner */
.git-banner {
  background: #3a2a16; border: 1px solid #6b4a1f; color: #f0d9a8;
  border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; font-size: 13px; line-height: 1.5;
}
.git-banner strong { color: #ffd98a; }

/* Workspace bar */
.ws-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.ws-bar-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #888; }
.ws-chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ws-chip {
  display: flex; align-items: center; background: #1f1f1f; border: 1px solid #333;
  border-radius: 999px; overflow: hidden;
}
.ws-chip.active { border-color: var(--accent); background: #2a2418; }
.ws-chip-name { background: none; border: none; color: #ddd; cursor: pointer; padding: 6px 10px 6px 14px; font-size: 13px; }
.ws-chip.active .ws-chip-name { color: #fff; font-weight: 600; }
.ws-gear { background: none; border: none; color: #999; cursor: pointer; padding: 6px 10px 6px 4px; font-size: 13px; }
.ws-gear:hover { color: #fff; }
.ws-new {
  background: #2a2a2a; border: 1px dashed #4a4a4a; color: #cfcfcf; border-radius: 999px;
  padding: 6px 14px; font-size: 13px; cursor: pointer;
}
.ws-new:hover { border-color: var(--accent); color: #fff; }
.ws-err { color: #ff8a8a; font-size: 13px; margin-bottom: 14px; }

/* Search bar */
.search-bar {
  display: flex; align-items: center; gap: 8px; background: #1c1c1c; border: 1px solid #313131;
  border-radius: 10px; padding: 0 12px; margin-bottom: 36px; transition: border-color 0.15s;
}
.search-bar:focus-within { border-color: #3b82f6; }
.search-icon { font-size: 13px; opacity: 0.55; }
.search-input { flex: 1 1 auto; background: none; border: none; outline: none; color: #e8e8e8; font-size: 14px; padding: 11px 0; }
.search-input::placeholder { color: #6b6b6b; }
.search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
.search-clear { background: none; border: none; color: #888; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 4px; }
.search-clear:hover { color: #fff; }

/* Groups */
.project-group { margin-bottom: 34px; }
.group-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #282828; }
.group-header h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #c4c4c4; }
.group-count { font-size: 11px; font-weight: 600; color: #888; background: #262626; border-radius: 999px; padding: 1px 8px; }
.btn-new { margin-left: auto; background: #2a2a2a; border: 1px solid #3a3a3a; color: #e0e0e0; padding: 5px 13px; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.15s, border-color 0.15s; }
.btn-new:hover:not(:disabled) { background: #353535; border-color: #4a4a4a; }
.btn-new:disabled { opacity: 0.5; cursor: default; }

.empty { color: #777; font-size: 13px; padding: 6px 2px; }
.empty strong { color: #aaa; font-weight: 600; }
.no-results { color: #777; font-size: 13px; padding: 6px 2px; font-style: italic; }
.cards { display: flex; flex-direction: column; gap: 8px; }

/* Modals (shared) */
.create-backdrop { position: fixed; inset: 0; z-index: 100001; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; padding: 24px; }
.create-dialog { width: min(480px, 92vw); max-height: 86vh; display: flex; flex-direction: column; background: #252525; border: 1px solid #3a3a3a; border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6); overflow: hidden; }
.create-dialog.wide { width: min(560px, 94vw); }
.cd-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid #333; }
.cd-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.cd-close { background: none; border: none; color: #999; font-size: 24px; line-height: 1; cursor: pointer; padding: 0 4px; border-radius: 4px; }
.cd-close:hover { color: #fff; background: #ffffff14; }
.cd-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 20px 24px; }
.field-label { display: block; font-size: 13px; color: #bbb; margin-bottom: 6px; margin-top: 12px; }
.field-label:first-child { margin-top: 0; }
.create-dialog input[type="text"], .create-dialog input:not([type]) { width: 100%; }
.create-dialog input { width: 100%; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; background: #1a1a1a; color: #e0e0e0; font-size: 14px; box-sizing: border-box; }
.slug-caption { font-size: 13px; color: #aaa; margin-top: 10px; }
.slug-caption code { color: #6aa9e9; font-family: monospace; background: #1a1a1a; padding: 2px 6px; border-radius: 4px; }
.slug-hint { font-size: 11px; color: #777; margin: 4px 0 0; }
.row-with-btn { display: flex; gap: 8px; align-items: center; }
.row-with-btn input { flex: 1 1 auto; }
.aux-btn { background: #333; border: 1px solid #555; color: #e0e0e0; border-radius: 6px; padding: 9px 12px; cursor: pointer; font-size: 13px; white-space: nowrap; }
.aux-btn:hover:not(:disabled) { background: #3c3c3c; }
.aux-btn:disabled { opacity: 0.5; cursor: default; }
.s3-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #333; }
.s3-section h4 { margin: 0 0 8px; font-size: 13px; color: #c4c4c4; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #ccc; margin-bottom: 6px; }
.check-row input { width: auto; }
.manifest-row { margin-top: 14px; padding-top: 12px; border-top: 1px solid #2f2f2f; }

/* Bucket combobox (Arreglo 2): a text input with an anchored dropdown BELOW it.
   The list is absolutely positioned relative to .bucket-combo so it overlays
   the modal content (high z-index) instead of pushing/floating beside the
   input. "Crear bucket" is its OWN row under the input, never over the list. */
.bucket-combo { position: relative; }
.bucket-input { width: 100%; }
.bucket-list {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 100002; /* above the modal (.create-dialog) content */
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  background: #232323;
  border: 1px solid #4a4a4a;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
}
.bucket-opt {
  padding: 6px 9px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #d6d6d6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bucket-opt.active,
.bucket-opt:hover { background: var(--accent-soft, #2a2418); color: #fff; }
.bucket-create-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.bucket-create-hint { font-size: 11px; color: #777; line-height: 1.4; }
.mode-tabs { display: flex; gap: 6px; margin: 14px 0 4px; }
.mode-tabs button { flex: 1 1 auto; background: #2a2a2a; border: 1px solid #444; color: #bbb; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.mode-tabs button.active { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 16px 24px; border-top: 1px solid #333; }
.dialog-actions.spread { justify-content: flex-start; }
.dialog-actions .spacer { flex: 1 1 auto; }
.dialog-actions button { padding: 8px 16px; border: 1px solid #555; border-radius: 6px; background: #333; color: #e0e0e0; cursor: pointer; }
.dialog-actions button:hover:not(:disabled) { background: #3c3c3c; }
.dialog-actions .danger { border-color: #7a3030; color: #ffb0b0; }
.dialog-actions .danger:hover { background: #5a2020; }
.dialog-actions .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); transition: background .12s ease; }
.dialog-actions .primary:hover:not(:disabled) { background: var(--accent-hover); }
.dialog-actions .primary:disabled { opacity: 0.5; cursor: default; }
</style>
