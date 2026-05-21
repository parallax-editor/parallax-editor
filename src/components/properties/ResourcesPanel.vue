<script setup lang="ts">
/**
 * ResourcesPanel (TASK #85; redesigned in TASK #93) — the "Recursos" browser
 * shown in PROPIEDADES when the global "Recursos" tree entry is selected
 * (sentinel GLOBAL_RESOURCES). View-agnostic: assets are per project, not per
 * desktop/mobile view (exactly like meta/theme).
 *
 * Per kind (Imágenes / Fuentes / Audio / Video) it lists every file that
 * physically exists under content/<...>/{images,fonts,audio,video}/ via
 * GET /api/projects/:type/:slug/assets. Each file is a consistent card row
 * (thumbnail/icon + name + size + delete) matching the other property panels.
 *
 * #93 redesign:
 *  - The raw native <input type=file> "Choose File" is GONE. Every group has
 *    the editor's STYLED upload affordance: the SAME .img-dropzone +
 *    .img-pick-btn pattern used by the png/meta image controls (drag-drop +
 *    a "+ Agregar" button that proxies a hidden file input).
 *  - Clicking an IMAGE row (thumbnail/name) opens a LIGHTBOX showing it large
 *    (centered, fit to viewport) with filename + size + natural dimensions;
 *    closeable by Esc, backdrop click, or an explicit ×. Non-image resources
 *    don't open it.
 *
 * After any add/delete it re-fetches so the list always mirrors disk. The
 * SAME endpoint feeds the image/font autocomplete (single source of truth);
 * a `reload` is exposed so the panel can be refreshed externally.
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state } from '../../stores/editor'
import { projectsApi } from '../../composables/useApi'
import type { ProjectAsset, ProjectAssetKind } from '../../composables/useApi'
import { useDialog } from '../../composables/useDialog'

const dialog = useDialog()

const GROUPS: { kind: ProjectAssetKind; label: string; accept: string }[] = [
  { kind: 'image', label: 'Imágenes', accept: 'image/*' },
  { kind: 'font', label: 'Fuentes', accept: '.ttf,.otf,.woff,.woff2,font/*' },
  { kind: 'audio', label: 'Audio', accept: 'audio/*' },
  { kind: 'video', label: 'Video', accept: 'video/*' },
]
// DOM data-test suffix per kind (images/fonts/audio/video — plural to match
// the visible labels and the spec's resource-group-<images|fonts|audio|video>).
const KIND_SLUG: Record<ProjectAssetKind, string> = {
  image: 'images',
  font: 'fonts',
  audio: 'audio',
  video: 'video',
}

const assets = ref<Record<ProjectAssetKind, ProjectAsset[]>>({
  image: [],
  font: [],
  audio: [],
  video: [],
})
const loading = ref(false)
const error = ref<string | null>(null)
const busy = ref<Record<string, boolean>>({})
const groupError = ref<Record<string, string | null>>({})
const groupWarn = ref<Record<string, string | null>>({})
const dragOver = ref<Record<string, boolean>>({})
const fileInputs = ref<Record<string, HTMLInputElement | null>>({})

// TASK #102: small transient toast confirming that an add/delete was
// committed atomically (server commits each upload/delete in its own
// `asset+:` / `asset-:` commit). State drives [data-test=resource-commit-toast].
//  - commit === 'ok'      → "✓ Guardado y versionado" (green)
//  - commit === 'skipped' → "⚠ Guardado, sin versionar" (yellow)
// Auto-dismisses ~1.5s after the latest action; non-blocking; the user
// can still click around. We deliberately do NOT block the panel — UI
// remains responsive throughout.
type ToastTone = 'ok' | 'skipped'
const commitToast = ref<{ tone: ToastTone; text: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showCommitToast(commit: 'ok' | 'skipped' | undefined) {
  // No flag from the server (older response shape) → keep silent rather than
  // showing a misleading "no versionado" — the previous behavior (the next
  // save sweeps the asset in) is unchanged for that case.
  if (commit !== 'ok' && commit !== 'skipped') return
  commitToast.value = commit === 'ok'
    ? { tone: 'ok', text: '✓ Guardado y versionado' }
    : { tone: 'skipped', text: '⚠ Guardado, sin versionar' }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { commitToast.value = null; toastTimer = null }, 1500)
}

function setFileInput(kind: ProjectAssetKind, el: any) {
  fileInputs.value[kind] = (el as HTMLInputElement) || null
}

async function reload() {
  if (!state.projectType || !state.slug) return
  loading.value = true
  error.value = null
  try {
    const r = await projectsApi.listAssets(state.projectType, state.slug)
    if (r.error || !r.assets) {
      error.value = r.error || 'No se pudieron cargar los recursos'
      return
    }
    assets.value = {
      image: r.assets.image || [],
      font: r.assets.font || [],
      audio: r.assets.audio || [],
      video: r.assets.video || [],
    }
  } catch (e: any) {
    error.value = e?.message || 'Error al cargar los recursos'
  } finally {
    loading.value = false
  }
}

onMounted(reload)
// Re-fetch if the active project changes while the panel is mounted.
watch(() => [state.projectType, state.slug], reload)

defineExpose({ reload })

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// Resolve a relative src to the served editor URL for thumbnails/lightbox.
function previewSrc(src: string): string {
  if (!src) return ''
  return src.startsWith('http') || src.startsWith('/')
    ? src
    : `/content/${state.projectType}/${state.slug}/${src}`
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('No se pudo leer el archivo'))
    fr.readAsDataURL(file)
  })
}

async function onAddPick(kind: ProjectAssetKind, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await uploadOne(kind, file)
}

async function onDrop(kind: ProjectAssetKind, e: DragEvent) {
  dragOver.value = { ...dragOver.value, [kind]: false }
  const file = e.dataTransfer?.files?.[0]
  if (file) await uploadOne(kind, file)
}

async function uploadOne(kind: ProjectAssetKind, file: File) {
  if (!state.projectType || !state.slug) return
  const gk = `add-${kind}`
  groupError.value = { ...groupError.value, [gk]: null }
  groupWarn.value = { ...groupWarn.value, [gk]: null }
  busy.value = { ...busy.value, [gk]: true }
  try {
    const dataUrl = await readAsDataUrl(file)
    const r = await projectsApi.uploadAsset(state.projectType, state.slug, file.name, dataUrl)
    if (r.error || !r.src) {
      groupError.value = { ...groupError.value, [gk]: r.error || 'No se pudo subir el archivo' }
      return
    }
    if (r.warning) groupWarn.value = { ...groupWarn.value, [gk]: r.warning }
    // TASK #102: confirm atomic commit (✓ Guardado y versionado / ⚠ sin
    // versionar). Fires for both add and delete; auto-dismisses in ~1.5s.
    showCommitToast(r.commit)
    await reload()
  } catch (e: any) {
    groupError.value = { ...groupError.value, [gk]: e?.message || 'Error al subir el archivo' }
  } finally {
    busy.value = { ...busy.value, [gk]: false }
  }
}

async function onDelete(kind: ProjectAssetKind, file: ProjectAsset) {
  if (!state.projectType || !state.slug) return
  // Spanish confirm — Daniela is non-technical.
  const ok = await dialog.confirm({
    title: 'Eliminar archivo',
    message: `¿Eliminar "${file.name}"? Esta acción no se puede deshacer y el archivo se borra del proyecto.`,
    confirmText: 'Eliminar',
    danger: true,
  })
  if (!ok) return
  const dk = `del-${kind}-${file.name}`
  groupError.value = { ...groupError.value, [`add-${kind}`]: null }
  busy.value = { ...busy.value, [dk]: true }
  try {
    const r = await projectsApi.deleteAsset(state.projectType, state.slug, kind, file.name)
    if (r.error) {
      groupError.value = { ...groupError.value, [`add-${kind}`]: r.error }
      return
    }
    // If the deleted file is open in the lightbox, close it.
    if (modalFile.value && modalFile.value.name === file.name) closeModal()
    // TASK #102: same toast as upload — confirms the delete was committed.
    showCommitToast(r.commit)
    await reload()
  } catch (e: any) {
    groupError.value = { ...groupError.value, [`add-${kind}`]: e?.message || 'Error al eliminar' }
  } finally {
    busy.value = { ...busy.value, [dk]: false }
  }
}

const totalCount = computed(
  () =>
    assets.value.image.length +
    assets.value.font.length +
    assets.value.audio.length +
    assets.value.video.length,
)

// ─── Image lightbox (TASK #93) ──────────────────────────────────────────────
// Clicking an IMAGE row opens a modal showing the image large (centered, fit
// to viewport) with filename + size + natural dimensions. Esc / backdrop /
// the × all dismiss it. Non-image resources never open it.
const modalFile = ref<ProjectAsset | null>(null)
const modalDims = ref<{ w: number; h: number } | null>(null)

function openModal(kind: ProjectAssetKind, f: ProjectAsset) {
  if (kind !== 'image') return
  modalFile.value = f
  modalDims.value = null
}
function closeModal() {
  modalFile.value = null
  modalDims.value = null
}
function onModalImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth) modalDims.value = { w: img.naturalWidth, h: img.naturalHeight }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && modalFile.value) {
    e.preventDefault()
    closeModal()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="props-content rc-panel" data-test="props-resources">
    <!-- TASK #102: tiny non-blocking toast confirming the atomic commit
         (✓ Guardado y versionado / ⚠ Guardado, sin versionar). Auto-dismisses
         in ~1.5s. Lives at the top of the panel so it's reliably in view. -->
    <transition name="rc-toast-fade">
      <div
        v-if="commitToast"
        class="rc-commit-toast"
        :class="`rc-commit-toast-${commitToast.tone}`"
        data-test="resource-commit-toast"
        role="status"
        aria-live="polite"
      >{{ commitToast.text }}</div>
    </transition>
    <div class="prop-section-title">Recursos</div>
    <p class="global-note">
      Archivos del proyecto (imágenes, fuentes, audio, video). Se comparten en
      escritorio y móvil. Aquí puedes verlos, eliminarlos o agregar nuevos.
    </p>

    <div v-if="loading" class="rc-status" data-test="resources-loading">Cargando recursos…</div>
    <div v-else-if="error" class="img-msg img-err" data-test="resources-error">{{ error }}</div>
    <p v-else-if="totalCount === 0" class="fb-empty rc-empty-all" data-test="resources-empty">
      Aún no hay archivos. Usa “+ Agregar” en cualquier grupo para subir uno.
    </p>

    <div
      v-for="g in GROUPS"
      :key="g.kind"
      class="rc-group"
      :data-test="`resource-group-${KIND_SLUG[g.kind]}`"
    >
      <div class="rc-group-head">
        <span class="rc-group-title">{{ g.label }}</span>
        <span class="rc-group-count">{{ assets[g.kind].length }}</span>
      </div>

      <ul v-if="assets[g.kind].length" class="rc-items">
        <li
          v-for="f in assets[g.kind]"
          :key="f.name"
          class="rc-item"
          :class="{ 'rc-item-clickable': g.kind === 'image' }"
          :data-test="`resource-item-${g.kind}-${f.name}`"
        >
          <button
            v-if="g.kind === 'image'"
            class="rc-thumb-btn"
            type="button"
            :data-test="`resource-open-${g.kind}-${f.name}`"
            :title="`Ver ${f.name} en grande`"
            :aria-label="`Ver ${f.name} en grande`"
            @click="openModal(g.kind, f)"
          >
            <img class="rc-item-thumb" :src="previewSrc(f.src)" :alt="f.name" />
          </button>
          <span v-else class="rc-item-icon" aria-hidden="true">
            {{ g.kind === 'font' ? 'Aa' : g.kind === 'audio' ? '♪' : '▶' }}
          </span>

          <button
            v-if="g.kind === 'image'"
            class="rc-item-meta rc-item-meta-btn"
            type="button"
            :title="`Ver ${f.name} en grande`"
            @click="openModal(g.kind, f)"
          >
            <span class="rc-item-name">{{ f.name }}</span>
            <span class="rc-item-size">{{ fmtBytes(f.bytes) }}</span>
          </button>
          <span v-else class="rc-item-meta">
            <span class="rc-item-name" :title="f.name">{{ f.name }}</span>
            <span class="rc-item-size">{{ fmtBytes(f.bytes) }}</span>
          </span>

          <button
            class="rc-del"
            type="button"
            :data-test="`resource-delete-${g.kind}-${f.name}`"
            :disabled="busy[`del-${g.kind}-${f.name}`]"
            title="Eliminar archivo"
            aria-label="Eliminar archivo"
            @click="onDelete(g.kind, f)"
          >&times;</button>
        </li>
      </ul>

      <!-- Styled upload affordance — SAME .img-dropzone/.img-pick-btn pattern
           as the png/meta image controls. NO raw native "Choose File". -->
      <div
        class="img-dropzone rc-dropzone"
        :class="{ 'drag-over': dragOver[g.kind], 'is-uploading': busy[`add-${g.kind}`] }"
        :data-test="`resource-dropzone-${KIND_SLUG[g.kind]}`"
        @dragover.prevent="dragOver = { ...dragOver, [g.kind]: true }"
        @dragenter.prevent="dragOver = { ...dragOver, [g.kind]: true }"
        @dragleave.prevent="dragOver = { ...dragOver, [g.kind]: false }"
        @drop.prevent="onDrop(g.kind, $event)"
      >
        <div class="img-dz-text">
          <span v-if="busy[`add-${g.kind}`]">Subiendo…</span>
          <span v-else>Arrastra un archivo aquí o cárgalo desde la PC</span>
        </div>
        <button
          class="img-pick-btn"
          type="button"
          :data-test="`resource-add-${KIND_SLUG[g.kind]}`"
          :disabled="busy[`add-${g.kind}`]"
          :title="`Agregar ${g.label.toLowerCase()}`"
          :aria-label="`Agregar ${g.label.toLowerCase()}`"
          @click="fileInputs[g.kind]?.click()"
        >+ Agregar</button>
        <input
          :ref="(el) => setFileInput(g.kind, el)"
          class="img-file-input"
          type="file"
          :accept="g.accept"
          :data-test="`resource-add-${KIND_SLUG[g.kind]}-input`"
          @change="onAddPick(g.kind, $event)"
        />
      </div>

      <div
        v-if="groupError[`add-${g.kind}`]"
        class="img-msg img-err"
        :data-test="`resource-group-${KIND_SLUG[g.kind]}-error`"
      >{{ groupError[`add-${g.kind}`] }}</div>
      <div
        v-if="groupWarn[`add-${g.kind}`]"
        class="img-msg img-warn"
        :data-test="`resource-group-${KIND_SLUG[g.kind]}-warning`"
      >{{ groupWarn[`add-${g.kind}`] }}</div>
    </div>

    <!-- Image lightbox -->
    <Teleport to="body">
      <div
        v-if="modalFile"
        class="rc-modal-backdrop"
        data-test="resource-image-modal"
        @click.self="closeModal"
      >
        <div class="rc-modal" role="dialog" aria-modal="true" :aria-label="modalFile.name">
          <button
            class="rc-modal-close"
            type="button"
            data-test="resource-modal-close"
            title="Cerrar (Esc)"
            aria-label="Cerrar"
            @click="closeModal"
          >&times;</button>
          <div class="rc-modal-imgwrap">
            <img
              class="rc-modal-img"
              :src="previewSrc(modalFile.src)"
              :alt="modalFile.name"
              @load="onModalImgLoad"
            />
          </div>
          <div class="rc-modal-meta">
            <span class="rc-modal-name">{{ modalFile.name }}</span>
            <span class="rc-modal-sub">
              {{ fmtBytes(modalFile.bytes) }}
              <template v-if="modalDims"> · {{ modalDims.w }}×{{ modalDims.h }} px</template>
            </span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* The shared panel chrome (.props-content, .prop-section-title, .global-note,
   .fb-empty, .img-dropzone/.img-pick-btn/.img-file-input,
   .img-msg/.img-err/.img-warn) is declared by PropertiesPanel with `scoped`
   styles, which only reach THIS component's ROOT element — not its nested
   nodes. So re-declare the exact same contract here (verbatim values from
   PropertiesPanel) so the redesigned panel is reliably consistent on its own. */
.props-content { padding: 8px 12px; }
.prop-section-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; text-transform: capitalize; }
.global-note { font-size: 11px; color: #8a8a8a; line-height: 1.5; margin: 2px 0 8px; }
.fb-empty { font-size: 11px; color: #777; margin: 4px 0; line-height: 1.4; }
.img-dropzone {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  border: 1.5px dashed #444; border-radius: 6px; padding: 12px;
  background: #242424; margin: 4px 0 8px; text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.img-dropzone.drag-over { border-color: var(--accent-strong); background: #242c38; }
.img-dropzone.is-uploading { opacity: 0.7; }
.img-dz-text { font-size: 11px; color: #888; }
.img-pick-btn {
  background: var(--accent); border: none; color: var(--accent-fg); padding: 6px 12px;
  border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: background .12s ease;
}
.img-pick-btn:hover:not(:disabled) { background: var(--accent-hover); }
.img-pick-btn:disabled { opacity: 0.6; cursor: default; }
.img-file-input { display: none; }
.img-msg { font-size: 11px; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px; }
.img-err { color: #ff8a8a; background: #3a1f1f; border: 1px solid #5a2a2a; }
.img-warn { color: #ffd27a; background: #3a321f; border: 1px solid #5a4a2a; }

.rc-status { font-size: 12px; color: #888; padding: 6px 0; }
.rc-empty-all { margin: 8px 0 12px; }

/* Group: a card-like block with a tidy header + count, consistent spacing /
   borders with the other property panels. */
.rc-group {
  border: 1px solid #333;
  border-radius: 7px;
  background: #232323;
  padding: 8px;
  margin: 0 0 10px;
}
.rc-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 6px;
  border-bottom: 1px solid #333;
  margin-bottom: 8px;
}
.rc-group-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #9a9a9a;
  flex: 1;
}
.rc-group-count {
  font-size: 10px;
  font-weight: 700;
  color: #cfcfcf;
  background: #00000040;
  border-radius: 9px;
  padding: 1px 8px;
  min-width: 16px;
  text-align: center;
}

.rc-items {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rc-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 7px;
  background: #1d1d1d;
  border: 1px solid #353535;
  border-radius: 6px;
}
.rc-item-clickable:hover { border-color: #3a6ea5; background: #1f2733; }
.rc-thumb-btn {
  padding: 0;
  border: none;
  background: none;
  cursor: zoom-in;
  flex-shrink: 0;
  line-height: 0;
  border-radius: 4px;
}
.rc-item-thumb {
  width: 38px;
  height: 38px;
  object-fit: cover;
  border-radius: 4px;
  background: repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 12px 12px;
  display: block;
}
.rc-item-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 15px;
  font-weight: 700;
}
.rc-item-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
  gap: 1px;
}
.rc-item-meta-btn {
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  cursor: zoom-in;
  font: inherit;
}
.rc-item-name {
  font-size: 12px;
  color: #e3e3e3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-item-size {
  font-size: 10px;
  color: #888;
}
.rc-del {
  background: none;
  border: none;
  color: #888;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
}
.rc-del:hover:not(:disabled) { color: #ff6b6b; background: #00000033; }
.rc-del:disabled { opacity: 0.4; cursor: default; }

/* Compact the shared .img-dropzone a touch inside the group card. */
.rc-dropzone { margin: 0; padding: 10px; }

/* ── Lightbox ──────────────────────────────────────────────────────────────
   Centered, image fit to the viewport, with filename + size + dimensions.
   Closeable by Esc / backdrop / the × button. */
.rc-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 4vh 4vw;
}
.rc-modal {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 92vw;
  max-height: 92vh;
}
.rc-modal-close {
  position: absolute;
  top: -10px;
  right: -10px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: #2a2a2a;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
.rc-modal-close:hover { background: #c0392b; }
.rc-modal-imgwrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  background: repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 22px 22px;
  border-radius: 6px;
  overflow: hidden;
}
.rc-modal-img {
  display: block;
  max-width: 88vw;
  max-height: 80vh;
  object-fit: contain;
}
.rc-modal-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  color: #e0e0e0;
}
.rc-modal-name { font-size: 13px; font-weight: 600; }
.rc-modal-sub { font-size: 11px; color: #aaa; }

/* TASK #102: atomic-commit confirmation toast. Sits at the top of the
   panel, non-blocking, auto-dismisses in ~1.5s. Two tones mirror the
   server's `commit: 'ok' | 'skipped'`. */
.rc-commit-toast {
  font-size: 11px;
  font-weight: 600;
  padding: 5px 9px;
  border-radius: 5px;
  margin: 0 0 8px;
  text-align: center;
}
.rc-commit-toast-ok {
  color: #b9f0c2;
  background: #1f3a26;
  border: 1px solid #2c5a39;
}
.rc-commit-toast-skipped {
  color: #ffd27a;
  background: #3a321f;
  border: 1px solid #5a4a2a;
}
.rc-toast-fade-enter-active,
.rc-toast-fade-leave-active { transition: opacity 0.2s ease; }
.rc-toast-fade-enter-from,
.rc-toast-fade-leave-to { opacity: 0; }
</style>
