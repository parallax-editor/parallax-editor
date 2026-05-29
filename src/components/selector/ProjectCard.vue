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
  align-items: center;
  gap: 6px;
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
  width: 36px;
  height: 36px;
  border-radius: 8px;
  font-size: 18px;
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
