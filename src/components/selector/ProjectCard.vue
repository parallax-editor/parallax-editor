<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProjectListItem } from '../../composables/useApi'

const { t } = useI18n()

/**
 * One project card on the start screen (ProjectSelector). Shows a thumbnail
 * from the project's OG image when it exists (graceful letter-block fallback
 * on 404), the title, a relative "edited" date and a monospace slug chip.
 * Duplicar/Eliminar live in a hover-revealed toolbar (no always-on clutter).
 * All copy is Spanish (the user is non-technical).
 */
const props = defineProps<{
  // Workspace id (Fase 2). The two seeded defaults still use 'eventos'/'site',
  // so the /content/<ws>/<slug>/... thumbnail path is unchanged for them.
  type: string
  project: ProjectListItem
  // Borrado asíncrono en curso (commit+push+S3): muestra spinner en la fila y
  // bloquea el click de abrir mientras dura.
  deleting?: boolean
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
  if (!ms || Number.isNaN(ms)) return t('card.noDate')
  const now = Date.now()
  const diff = now - ms
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return t('card.editedJustNow')
  if (diff < hour) {
    const n = Math.round(diff / min)
    return t(n === 1 ? 'card.editedMinute' : 'card.editedMinutes', { n })
  }
  if (diff < day) {
    const n = Math.round(diff / hour)
    return t(n === 1 ? 'card.editedHour' : 'card.editedHours', { n })
  }
  if (diff < 7 * day) {
    const n = Math.round(diff / day)
    return t(n === 1 ? 'card.editedDay' : 'card.editedDays', { n })
  }
  // Older than a week → absolute localized date.
  const d = new Date(ms)
  const fmt = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
  return t('card.editedOn', { date: fmt.replace(/\./g, '') })
}
</script>

<template>
  <div
    class="project-card"
    :class="{ 'is-deleting': deleting }"
    role="button"
    tabindex="0"
    :data-test="`project-card-${type}-${project.slug}`"
    @click="!deleting && emit('open')"
    @keydown.enter.prevent="!deleting && emit('open')"
    @keydown.space.prevent="!deleting && emit('open')"
  >
    <!-- Preview grande arriba (16:10) — dashboard estilo Figma/Framer.
         El OG image del sitio es el preview natural; fallback letra. -->
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
      <span
        v-if="deleting"
        class="act-spinner"
        :data-test="`project-deleting-${project.slug}`"
        role="status"
        :aria-label="t('card.deleting')"
        :title="t('card.deleting')"
      ></span>
      <template v-else>
        <button
          type="button"
          class="act"
          :title="t('card.duplicate')"
          :aria-label="t('card.duplicate')"
          @click="emit('duplicate')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          type="button"
          class="act danger"
          :title="t('card.delete')"
          :aria-label="t('card.delete')"
          @click="emit('remove')"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Card VERTICAL con preview grande (16:10) — el selector pasó de "lista de
   filas" a un grid de dashboard (feedback Josh: diseño apretado y monótono). */
.project-card {
  display: flex;
  flex-direction: column;
  background: #1c1c22;
  border: 1px solid #2a2a32;
  border-radius: 14px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  position: relative;
}
.project-card:hover {
  border-color: #3d3d48;
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}
.project-card:active {
  transform: translateY(0);
}
.project-card:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 2px;
}

.thumb {
  width: 100%;
  aspect-ratio: 16 / 10;
  background: #14141a;
  border-bottom: 1px solid #26262e;
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.25s ease;
}
.project-card:hover .thumb img { transform: scale(1.03); }
.thumb-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 44px;
  font-weight: 700;
  color: #4b5563;
  background:
    radial-gradient(320px 160px at 50% 0%, rgba(120, 130, 170, 0.12), transparent 70%),
    linear-gradient(135deg, #23232b, #17171d);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px 14px 13px;
  min-width: 0;
}
.project-title {
  font-weight: 600;
  font-size: 13.5px;
  color: #ececf1;
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
  font-size: 11.5px;
  color: #82828e;
  white-space: nowrap;
}
.slug-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: #7fa8d6;
  background: #14141a;
  border: 1px solid #2a2a32;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Acciones como overlay flotante sobre la esquina del preview (hover). */
.project-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.12s;
}
.project-card:hover .project-actions,
.project-card:focus-within .project-actions {
  opacity: 1;
}
.project-actions .act {
  background: rgba(18, 18, 24, 0.85);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #c9c9d2;
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  font-size: 16px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.project-actions .act:hover {
  background: rgba(45, 45, 55, 0.95);
  color: #fff;
}
.project-actions .danger:hover {
  background: rgba(70, 25, 25, 0.95);
  color: #ff7676;
  border-color: rgba(160, 60, 60, 0.6);
}

@media (max-width: 520px) {
  /* Touch / narrow: actions always visible (no hover) so they stay reachable. */
  .project-actions { opacity: 1; }
}

/* Deleting in progress: dim the row, block opening, keep the spinner visible. */
.project-card.is-deleting {
  cursor: progress;
  opacity: 0.6;
  pointer-events: none;
}
.project-card.is-deleting .project-actions {
  opacity: 1;
}
.act-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid #4a4a4a;
  border-top-color: #ff7676;
  animation: act-spin 0.7s linear infinite;
}
@keyframes act-spin {
  to { transform: rotate(360deg); }
}
</style>
