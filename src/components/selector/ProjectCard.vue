<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ProjectListItem } from '../../composables/useApi'

/**
 * One project card on the start screen (ProjectSelector). Shows a thumbnail
 * from the project's OG image when it exists (graceful letter-block fallback
 * on 404), the title, a relative "edited" date and a monospace slug chip.
 * Duplicar/Eliminar live in a hover-revealed toolbar (no always-on clutter).
 * All copy is Spanish (Daniela is non-technical).
 */
const props = defineProps<{
  // Workspace id (Fase 2). The two seeded defaults still use 'eventos'/'site',
  // so the /content/<ws>/<slug>/... thumbnail path is unchanged for them.
  type: string
  project: ProjectListItem
}>()

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'duplicate'): void
  (e: 'remove'): void
}>()

// The editor serves project assets at /content/(eventos|site)/<slug>/...
// Use the OG image as a thumbnail; if it 404s, `imgFailed` flips to the
// letter-block fallback so a missing image never shows a broken-image icon.
const imgFailed = ref(false)
const thumbSrc = computed(
  () => `/content/${props.type}/${props.project.slug}/images/og-image.png`,
)
const initial = computed(() =>
  (props.project.title || props.project.slug || '?').trim().charAt(0).toUpperCase(),
)

// Human, Spanish "edited" line: relative for recent edits, absolute date older.
const editedLabel = computed(() => formatEdited(props.project.updatedAt))

function formatEdited(ms: number): string {
  if (!ms || Number.isNaN(ms)) return 'Sin fecha'
  const now = Date.now()
  const diff = now - ms
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return 'Editado hace un momento'
  if (diff < hour) {
    const n = Math.round(diff / min)
    return `Editado hace ${n} ${n === 1 ? 'minuto' : 'minutos'}`
  }
  if (diff < day) {
    const n = Math.round(diff / hour)
    return `Editado hace ${n} ${n === 1 ? 'hora' : 'horas'}`
  }
  if (diff < 7 * day) {
    const n = Math.round(diff / day)
    return `Editado hace ${n} ${n === 1 ? 'día' : 'días'}`
  }
  // Older than a week → absolute Spanish date "Editado el 14 nov 2026".
  const d = new Date(ms)
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
  return `Editado el ${fmt.replace(/\./g, '')}`
}
</script>

<template>
  <div
    class="project-card"
    role="button"
    tabindex="0"
    :data-test="`project-card-${type}-${project.slug}`"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <div class="thumb">
      <img
        v-if="!imgFailed"
        :src="thumbSrc"
        :alt="project.title"
        loading="lazy"
        @error="imgFailed = true"
      />
      <div v-else class="thumb-fallback" aria-hidden="true">{{ initial }}</div>
    </div>

    <div class="info">
      <span class="project-title">{{ project.title }}</span>
      <div class="meta-row">
        <span class="edited">{{ editedLabel }}</span>
        <code class="slug-chip">{{ project.slug }}</code>
      </div>
    </div>

    <div class="project-actions" @click.stop>
      <button
        type="button"
        class="act"
        title="Duplicar"
        aria-label="Duplicar"
        @click="emit('duplicate')"
      >&#x2398;</button>
      <button
        type="button"
        class="act danger"
        title="Eliminar"
        aria-label="Eliminar"
        @click="emit('remove')"
      >&#x2715;</button>
    </div>
  </div>
</template>

<style scoped>
.project-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  background: #232323;
  border: 1px solid #2e2e2e;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
  position: relative;
}
.project-card:hover {
  background: #2b2b2b;
  border-color: #3d3d3d;
}
.project-card:active {
  transform: translateY(1px);
}
.project-card:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 2px;
}

.thumb {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1a1a;
  border: 1px solid #333;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  color: #6b7280;
  background: linear-gradient(135deg, #2a2a2a, #1c1c1c);
}

.info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.project-title {
  font-weight: 600;
  font-size: 14px;
  color: #ececec;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.edited {
  font-size: 12px;
  color: #8a8a8a;
  white-space: nowrap;
}
.slug-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #7fa8d6;
  background: #1a1a1a;
  border: 1px solid #2c2c2c;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
/* Reveal actions on hover/focus; keep them reachable for keyboard users. */
.project-card:hover .project-actions,
.project-card:focus-within .project-actions {
  opacity: 1;
}
.project-actions .act {
  background: #2e2e2e;
  border: 1px solid #3a3a3a;
  color: #b9b9b9;
  cursor: pointer;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  font-size: 15px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.project-actions .act:hover {
  background: #3a3a3a;
  color: #fff;
}
.project-actions .danger:hover {
  background: #3a2020;
  color: #ff7676;
  border-color: #5a2a2a;
}

@media (max-width: 520px) {
  /* Touch / narrow: actions always visible (no hover) so they stay reachable. */
  .project-actions { opacity: 1; }
}
</style>
