<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { projectsApi } from '../composables/useApi'
import type { ProjectListItem } from '../composables/useApi'
import ProjectCard from '../components/selector/ProjectCard.vue'
// The SAME canonical slug transform the server uses to create the folder, so
// this live preview ALWAYS matches the folder/route that gets created.
import { slugify } from '../../server/slug'

const router = useRouter()
const projects = ref<{ eventos: ProjectListItem[]; site: ProjectListItem[] }>({ eventos: [], site: [] })
const loading = ref(true)
// Free-form NAME the human types (becomes meta.title / the HTML <title>).
const newName = ref('')
const showCreate = ref<string | null>(null)
const creating = ref(false)

// Live, read-only derived slug = the folder/route. The human never types this.
const slugPreview = computed(() => slugify(newName.value))

const nameInput = ref<HTMLInputElement | null>(null)
function closeCreate() {
  showCreate.value = null
  newName.value = ''
}
// Focus the name input when the modal opens (autofocus is unreliable through a
// Teleport that mounts on demand).
watch(showCreate, (v) => {
  if (v) nextTick(() => nameInput.value?.focus())
})
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && showCreate.value) {
    e.stopPropagation()
    closeCreate()
  }
}

// ── Search (Task 2) ─────────────────────────────────────────────────────────
// Case- AND accent-insensitive filter over BOTH groups, matching title OR slug.
const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
function norm(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}
function matches(p: ProjectListItem, q: string): boolean {
  if (!q) return true
  return norm(p.title).includes(q) || norm(p.slug).includes(q)
}

// ── Sort (Task 1) ───────────────────────────────────────────────────────────
// Most-recently-edited first (updatedAt DESC); ties fall back to title A→Z.
function sortByRecent(list: ProjectListItem[]): ProjectListItem[] {
  return [...list].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return (a.title || a.slug).localeCompare(b.title || b.slug, 'es')
  })
}

const groups = computed(() => {
  const q = norm(search.value)
  const build = (type: 'eventos' | 'site') => {
    const all = sortByRecent(projects.value[type] || [])
    const visible = all.filter((p) => matches(p, q))
    return { all, visible }
  }
  // Portafolio first, then Eventos (insertion order drives the v-for).
  return { site: build('site'), eventos: build('eventos') }
})

const GROUP_LABELS: Record<string, string> = { eventos: 'Eventos', site: 'Portafolio' }

onMounted(async () => {
  document.addEventListener('keydown', onKey, true)
  projects.value = await projectsApi.list()
  loading.value = false
  nextTick(() => searchInput.value?.focus())
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))

function openProject(type: string, slug: string) {
  router.push(`/edit/${type}/${slug}`)
}

async function createNew() {
  if (!showCreate.value || !newName.value.trim() || creating.value) return
  creating.value = true
  // Capture the type before we clear showCreate so we can open the new project.
  const type = showCreate.value
  try {
    // Send the FREE-FORM name; the server sets meta.title to it verbatim and
    // derives the slug with the SAME slugify() shown in the preview. It
    // returns the FINAL slug (auto-incremented if the slug collided).
    const r = await projectsApi.create(type, newName.value.trim())
    const created = r?.slug
    const expected = slugPreview.value
    showCreate.value = null
    newName.value = ''
    // If a same-named project already existed the slug was auto-incremented —
    // tell Daniela (non-technical) which folder/address was actually used.
    if (created && expected && created !== expected) {
      window.alert(
        `Ya existía un sitio con esa dirección.\n` +
          `Se creó como: "${created}"`,
      )
    }
    // Open the freshly-created project straight away (don't leave her on the
    // list wondering what happened).
    if (created) {
      openProject(type, created)
      return
    }
  } finally {
    creating.value = false
  }
}

// Duplicate: ask Daniela (in Spanish, non-technical) for the new name. Empty
// or Cancel → the server auto-names "<slug>-copia" and auto-increments
// "-copia-2", "-copia-3"… on collision, so duplicating the same project twice
// never errors. The server sanitizes whatever she types to a valid slug.
async function duplicate(type: string, slug: string) {
  const proposed = window.prompt(
    `Nombre para la copia de "${slug}"\n\n` +
      'Déjalo vacío para usar un nombre automático ' +
      `(por ejemplo "${slug}-copia").`,
    `${slug}-copia`,
  )
  // prompt() returns null only when the user pressed Cancel → do nothing.
  if (proposed === null) return
  const r = await projectsApi.duplicate(type, slug, proposed.trim() || undefined)
  projects.value = await projectsApi.list()
  if (r?.slug) {
    window.alert(`Copia creada: "${r.slug}"`)
  }
}

async function remove(type: string, slug: string) {
  if (!confirm(`Eliminar "${slug}"? Esta accion no se puede deshacer.`)) return
  await projectsApi.delete(type, slug)
  projects.value = await projectsApi.list()
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
      <button
        v-if="search"
        type="button"
        class="search-clear"
        aria-label="Limpiar búsqueda"
        @click="search = ''"
      >&times;</button>
    </div>

    <div v-if="loading" class="loading">Cargando proyectos...</div>

    <template v-else>
      <section
        v-for="(g, type) in groups"
        :key="type"
        class="project-group"
      >
        <div class="group-header">
          <h2>{{ GROUP_LABELS[type] }}</h2>
          <span class="group-count">{{ g.all.length }}</span>
          <button class="btn-new" @click="showCreate = type as string">+ Nuevo</button>
        </div>

        <!-- Empty: the group genuinely has no projects yet. -->
        <div v-if="g.all.length === 0" class="empty">
          No hay proyectos aún. Crea uno con <strong>+ Nuevo</strong>.
        </div>

        <!-- Search hid every project in this group. -->
        <div v-else-if="g.visible.length === 0" class="no-results" :data-test="`no-results-${type}`">
          Sin resultados para “{{ search }}”.
        </div>

        <div v-else class="cards">
          <ProjectCard
            v-for="p in g.visible"
            :key="p.slug"
            :type="type as 'eventos' | 'site'"
            :project="p"
            @open="openProject(type as string, p.slug)"
            @duplicate="duplicate(type as string, p.slug)"
            @remove="remove(type as string, p.slug)"
          />
        </div>
      </section>
    </template>

    <!-- Create dialog as a MODAL: the project list can grow long, so an inline
         form at the bottom gets cut off (no page scroll). A teleported,
         centered, scrollable modal is always visible. -->
    <Teleport to="body">
      <div
        v-if="showCreate"
        class="create-backdrop"
        @click.self="closeCreate"
      >
        <div class="create-dialog" role="dialog" aria-label="Nuevo proyecto" data-test="create-dialog">
          <header class="cd-head">
            <h3>Nuevo {{ showCreate === 'eventos' ? 'evento' : 'mundo' }}</h3>
            <button class="cd-close" aria-label="Cerrar" @click="closeCreate">&times;</button>
          </header>

          <div class="cd-body">
            <label class="field-label" for="new-site-name">Nombre del sitio</label>
            <input
              id="new-site-name"
              ref="nameInput"
              v-model="newName"
              data-test="new-site-name"
              placeholder="Ej: Sofía &amp; Juan — 15 de marzo"
              @keydown.enter="createNew"
            />

            <div class="slug-caption">
              Dirección/carpeta:
              <code data-test="new-site-slug">{{ slugPreview || '—' }}</code>
            </div>
            <p class="slug-hint">Se genera automático a partir del nombre.</p>
          </div>

          <div class="dialog-actions">
            <button @click="closeCreate">Cancelar</button>
            <button
              class="primary"
              data-test="new-site-create"
              :disabled="!slugPreview || creating"
              @click="createNew"
            >
              {{ creating ? 'Creando…' : 'Crear' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* body{overflow:hidden} + #app{height:100vh} (index.html, for the editor's
   fixed layout) clip this list. Make the selector its OWN full-height scroll
   container and center its content, so a long list scrolls natively. */
.selector { height: 100vh; height: 100dvh; overflow-y: auto; padding: 56px 24px 80px; }
.selector > * { max-width: 760px; margin-left: auto; margin-right: auto; }

.hero { margin-bottom: 22px; }
.title {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 4px;
  background: linear-gradient(90deg, #ffffff, #b9c4d6);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.subtitle { color: #8a8a8a; font-size: 14px; }
.loading { color: #888; padding: 24px 0; }

/* ── Search bar ── */
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1c1c1c;
  border: 1px solid #313131;
  border-radius: 10px;
  padding: 0 12px;
  margin-bottom: 36px;
  transition: border-color 0.15s;
}
.search-bar:focus-within { border-color: #3b82f6; }
.search-icon { font-size: 13px; opacity: 0.55; }
.search-input {
  flex: 1 1 auto;
  background: none;
  border: none;
  outline: none;
  color: #e8e8e8;
  font-size: 14px;
  padding: 11px 0;
}
.search-input::placeholder { color: #6b6b6b; }
/* Hide the native search "x" so only ours shows. */
.search-input::-webkit-search-cancel-button { -webkit-appearance: none; }
.search-clear {
  background: none;
  border: none;
  color: #888;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}
.search-clear:hover { color: #fff; }

/* ── Groups ── */
.project-group { margin-bottom: 34px; }
.group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid #282828;
}
.group-header h2 {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #c4c4c4;
}
.group-count {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  background: #262626;
  border-radius: 999px;
  padding: 1px 8px;
}
.btn-new {
  margin-left: auto;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  color: #e0e0e0;
  padding: 5px 13px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s, border-color 0.15s;
}
.btn-new:hover { background: #353535; border-color: #4a4a4a; }

.empty { color: #777; font-size: 13px; padding: 6px 2px; }
.empty strong { color: #aaa; font-weight: 600; }
.no-results { color: #777; font-size: 13px; padding: 6px 2px; font-style: italic; }

.cards { display: flex; flex-direction: column; gap: 8px; }

/* ── Create modal ── */
.create-backdrop {
  position: fixed; inset: 0; z-index: 100001;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.create-dialog {
  width: min(480px, 92vw); max-height: 86vh;
  display: flex; flex-direction: column;
  background: #252525; border: 1px solid #3a3a3a; border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6); overflow: hidden;
}
.cd-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 18px 24px; border-bottom: 1px solid #333;
}
.cd-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.cd-close {
  background: none; border: none; color: #999; font-size: 24px; line-height: 1;
  cursor: pointer; padding: 0 4px; border-radius: 4px;
}
.cd-close:hover { color: #fff; background: #ffffff14; }
.cd-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 20px 24px; }
.field-label { display: block; font-size: 13px; color: #bbb; margin-bottom: 6px; }
.create-dialog input { width: 100%; padding: 10px 12px; border: 1px solid #555; border-radius: 6px; background: #1a1a1a; color: #e0e0e0; font-size: 14px; margin-bottom: 10px; }
.slug-caption { font-size: 13px; color: #aaa; }
.slug-caption code { color: #6aa9e9; font-family: monospace; background: #1a1a1a; padding: 2px 6px; border-radius: 4px; }
.slug-hint { font-size: 11px; color: #777; margin: 4px 0 0; }
/* Task 4 (#59): give the footer real breathing room — buttons were flush
   against the modal edge. Padding + a subtle top divider separates actions
   from the body. */
.dialog-actions {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 16px 24px;
  border-top: 1px solid #333;
}
.dialog-actions button { padding: 8px 16px; border: 1px solid #555; border-radius: 6px; background: #333; color: #e0e0e0; cursor: pointer; }
.dialog-actions button:hover { background: #3c3c3c; }
.dialog-actions .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); transition: background .12s ease; }
.dialog-actions .primary:hover { background: var(--accent-hover); }
.dialog-actions .primary:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
.dialog-actions .primary:disabled { opacity: 0.5; cursor: default; }
</style>
