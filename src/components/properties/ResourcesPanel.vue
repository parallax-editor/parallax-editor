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
import { state, getAtPath, setAtPath } from '../../stores/editor'
import { projectsApi } from '../../composables/useApi'
import type { ProjectAsset, ProjectAssetKind } from '../../composables/useApi'
import { useDialog } from '../../composables/useDialog'
import { fileToFontFamily } from '../../composables/fontName'

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
// assetsNonce: refresca también ante cambios de OTROS paneles o del watcher
// (cambio externo / Claude), no solo al cambiar de proyecto.
watch(() => [state.projectType, state.slug, state.assetsNonce], reload)

defineExpose({ reload })

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// Resolve a relative src to the served editor URL for thumbnails/lightbox.
// Incluye `?v=assetsNonce` (cache-bust) para que al borrar/reemplazar/RECORTAR un
// asset, el navegador no muestre el bitmap viejo cacheado (mismo nombre de
// archivo). assetsNonce es reactivo → al bumpearlo se recargan thumbs y lightbox.
function previewSrc(src: string): string {
  if (!src) return ''
  if (src.startsWith('http') || src.startsWith('/')) return src
  return `/content/${state.projectType}/${state.slug}/${src}?v=${state.assetsNonce}`
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('No se pudo leer el archivo'))
    fr.readAsDataURL(file)
  })
}

// Subida MÚLTIPLE: el selector y el drop aceptan varios archivos a la vez. Se
// suben en serie (uno tras otro) a propósito — uploadOne hace git add+commit por
// archivo, y correr varios commits en paralelo en el mismo repo se pisaría.
async function onAddPick(kind: ProjectAssetKind, e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  for (const file of files) await uploadOne(kind, file)
}

async function onDrop(kind: ProjectAssetKind, e: DragEvent) {
  dragOver.value = { ...dragOver.value, [kind]: false }
  const files = Array.from(e.dataTransfer?.files || [])
  for (const file of files) await uploadOne(kind, file)
}

// Arrastrar un recurso (imagen/video/audio) HACIA la mesa para crear el
// elemento (#154). Pone {kind, src} en dataTransfer con un MIME propio que
// EditorCanvas reconoce; el src relativo (`images/<f>` etc.) es justo el que
// va en el elemento. Las fuentes no se arrastran (no son elementos de la mesa).
function onItemDragStart(kind: ProjectAssetKind, f: ProjectAsset, e: DragEvent) {
  if (kind === 'font' || !e.dataTransfer) return
  e.dataTransfer.setData(
    'application/x-parallax-resource',
    JSON.stringify({ kind, src: f.src }),
  )
  e.dataTransfer.effectAllowed = 'copy'
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
    // Subir una FUENTE en Recursos antes solo dejaba el .otf en disco: el engine
    // solo inyecta @font-face para las que estén en meta.fonts, así que la fuente
    // quedaba invisible (no se aplicaba ni en el editor ni desplegada). Ahora al
    // subirla la REGISTRAMOS en meta.fonts (source custom, url = src relativo
    // `fonts/<archivo>`) con el MISMO nombre de familia que ofrece el selector
    // (fileToFontFamily) → ya queda disponible y se carga de verdad. setAtPath
    // graba undo + marca dirty; Daniela guarda para versionar el registro.
    // Idempotente: si esa familia ya está registrada, no duplica.
    if (kind === 'font' && r.src) {
      const family = fileToFontFamily(file.name)
      const fonts = ((getAtPath('meta.fonts') as any[]) || []).map((f) => ({ ...f }))
      if (family && !fonts.some((f) => (f.family || '').toLowerCase() === family.toLowerCase())) {
        fonts.push({ family, source: 'custom', url: r.src })
        setAtPath('meta.fonts', fonts)
      }
    }
    // TASK #102: confirm atomic commit (✓ Guardado y versionado / ⚠ sin
    // versionar). Fires for both add and delete; auto-dismisses in ~1.5s.
    showCommitToast(r.commit)
    // Bump compartido → refresca este panel (vía watch) y los autocompletes
    // de PropertiesPanel / ComponentPropsEditor sin reentrar al proyecto.
    state.assetsNonce++
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
    // Bump compartido → refresca este panel (vía watch) y los autocompletes
    // de PropertiesPanel / ComponentPropsEditor sin reentrar al proyecto.
    state.assetsNonce++
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
  exitCrop()
}
function closeModal() {
  modalFile.value = null
  modalDims.value = null
  exitCrop()
}
function onModalImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth) modalDims.value = { w: img.naturalWidth, h: img.naturalHeight }
}

// ─── Recorte de imagen desde Recursos (#159) ─────────────────────────────────
// Recorta la imagen ABIERTA en el lightbox y SOBRESCRIBE el archivo en disco
// (mismo `src`), así su recorte aplica dondequiera que se use. Dos caminos:
//  • Manual: rectángulo con 8 manijas + arrastrar para mover (coords normalizadas
//    0..1 sobre la imagen mostrada).
//  • "Quitar espacio vacío": detecta el recuadro de píxeles NO transparentes y
//    encuadra ahí (justo el caso de PNGs con mucho margen).
// El recorte se hace en un <canvas> a resolución NATURAL → dataURL → upload con
// overwrite=true. Luego assetsNonce++ cache-bustea thumbs/preview/elementos.
const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type CropHandle = (typeof CROP_HANDLES)[number]
const cropMode = ref(false)
const crop = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const cropBusy = ref(false)
const cropError = ref('')
const cropImgEl = ref<HTMLImageElement | null>(null)

const cropRectStyle = computed(() => {
  const c = crop.value
  if (!c) return undefined
  return { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }
})

function clamp01(n: number) { return Math.max(0, Math.min(1, n)) }

function enterCrop() {
  cropError.value = ''
  crop.value = { x: 0, y: 0, w: 1, h: 1 } // arranca con la imagen completa
  cropMode.value = true
}
function exitCrop() {
  cropMode.value = false
  crop.value = null
  cropError.value = ''
  cropBusy.value = false
  window.removeEventListener('mousemove', onCropPointerMove)
  window.removeEventListener('mouseup', onCropPointerUp)
}

let cropDragKind: CropHandle | 'move' | '' = ''
let cropDragRect: DOMRect | null = null
let cropDragStartPt = { fx: 0, fy: 0 }
let cropDragStartCrop = { x: 0, y: 0, w: 1, h: 1 }

function onCropPointerDown(kind: CropHandle | 'move', e: MouseEvent) {
  if (!cropImgEl.value || !crop.value) return
  e.preventDefault()
  e.stopPropagation()
  cropDragKind = kind
  cropDragRect = cropImgEl.value.getBoundingClientRect()
  cropDragStartPt = {
    fx: (e.clientX - cropDragRect.left) / cropDragRect.width,
    fy: (e.clientY - cropDragRect.top) / cropDragRect.height,
  }
  cropDragStartCrop = { ...crop.value }
  window.addEventListener('mousemove', onCropPointerMove)
  window.addEventListener('mouseup', onCropPointerUp)
}
function onCropPointerMove(e: MouseEvent) {
  if (!cropDragRect || !cropDragKind) return
  const fx = clamp01((e.clientX - cropDragRect.left) / cropDragRect.width)
  const fy = clamp01((e.clientY - cropDragRect.top) / cropDragRect.height)
  const s = cropDragStartCrop
  if (cropDragKind === 'move') {
    crop.value = {
      x: Math.max(0, Math.min(s.x + (fx - cropDragStartPt.fx), 1 - s.w)),
      y: Math.max(0, Math.min(s.y + (fy - cropDragStartPt.fy), 1 - s.h)),
      w: s.w,
      h: s.h,
    }
    return
  }
  const MIN = 0.03 // recuadro mínimo (3% del lado) para no colapsar
  let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h
  if (cropDragKind.includes('w')) x0 = Math.min(fx, x1 - MIN)
  if (cropDragKind.includes('e')) x1 = Math.max(fx, x0 + MIN)
  if (cropDragKind.includes('n')) y0 = Math.min(fy, y1 - MIN)
  if (cropDragKind.includes('s')) y1 = Math.max(fy, y0 + MIN)
  crop.value = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
function onCropPointerUp() {
  cropDragKind = ''
  cropDragRect = null
  window.removeEventListener('mousemove', onCropPointerMove)
  window.removeEventListener('mouseup', onCropPointerUp)
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('No se pudo cargar la imagen'))
    img.src = src
  })
}

// "Quitar espacio vacío": encuadra al recuadro de píxeles con alpha > umbral.
async function autoTrimTransparent() {
  if (!modalFile.value) return
  cropError.value = ''
  try {
    const img = await loadImageEl(previewSrc(modalFile.value.src))
    const nw = img.naturalWidth, nh = img.naturalHeight
    const cv = document.createElement('canvas')
    cv.width = nw; cv.height = nh
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0)
    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(0, 0, nw, nh).data
    } catch {
      cropError.value = 'No se pudo leer la imagen para el recorte automático.'
      return
    }
    const A = 10
    let minX = nw, minY = nh, maxX = -1, maxY = -1
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        if (data[(y * nw + x) * 4 + 3] > A) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) {
      cropError.value = 'La imagen no tiene zonas transparentes que recortar (es opaca).'
      return
    }
    crop.value = {
      x: minX / nw,
      y: minY / nh,
      w: (maxX - minX + 1) / nw,
      h: (maxY - minY + 1) / nh,
    }
  } catch (e: any) {
    cropError.value = e?.message || 'No se pudo procesar la imagen.'
  }
}

async function applyCrop() {
  if (!modalFile.value || !state.projectType || !state.slug || !crop.value) return
  cropBusy.value = true
  cropError.value = ''
  try {
    const f = modalFile.value
    const img = await loadImageEl(previewSrc(f.src))
    const nw = img.naturalWidth, nh = img.naturalHeight
    const c = crop.value
    const sx = Math.round(c.x * nw)
    const sy = Math.round(c.y * nh)
    const sw = Math.max(1, Math.round(c.w * nw))
    const sh = Math.max(1, Math.round(c.h * nh))
    const cv = document.createElement('canvas')
    cv.width = sw; cv.height = sh
    const ctx = cv.getContext('2d')
    if (!ctx) { cropError.value = 'No se pudo recortar.'; return }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    // Conserva el formato del archivo (jpg sigue jpg; el resto va a PNG con alpha).
    const isJpg = /\.jpe?g$/i.test(f.name)
    const dataUrl = isJpg ? cv.toDataURL('image/jpeg', 0.92) : cv.toDataURL('image/png')
    const r = await projectsApi.uploadAsset(state.projectType, state.slug, f.name, dataUrl, true)
    if (r.error) { cropError.value = r.error; return }
    showCommitToast(r.commit)
    state.assetsNonce++ // cache-bust: thumbs, lightbox y elementos que usan el src
    modalDims.value = { w: sw, h: sh }
    cropMode.value = false
    crop.value = null
  } catch (e: any) {
    cropError.value = e?.message || 'No se pudo recortar la imagen.'
  } finally {
    cropBusy.value = false
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && modalFile.value) {
    e.preventDefault()
    closeModal()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  // Por si se desmonta con un recorte/drag en curso.
  window.removeEventListener('mousemove', onCropPointerMove)
  window.removeEventListener('mouseup', onCropPointerUp)
})
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
          :class="{ 'rc-item-clickable': g.kind === 'image', 'rc-item-draggable': g.kind !== 'font' }"
          :data-test="`resource-item-${g.kind}-${f.name}`"
          :draggable="g.kind !== 'font'"
          :title="g.kind !== 'font' ? `Arrastra a la mesa para agregar ${f.name}` : undefined"
          @dragstart="onItemDragStart(g.kind, f, $event)"
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
          multiple
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
          <!-- Barra de recorte (#159): recortar manualmente o quitar el espacio
               transparente; al aplicar se SOBRESCRIBE el archivo. -->
          <div class="rc-modal-tools">
            <button
              v-if="!cropMode"
              class="rc-tool-btn"
              type="button"
              data-test="resource-crop-start"
              @click="enterCrop"
            >✂ Recortar</button>
            <template v-else>
              <button
                class="rc-tool-btn"
                type="button"
                data-test="resource-crop-autotrim"
                :disabled="cropBusy"
                title="Encuadra automáticamente la ilustración quitando los márgenes transparentes"
                @click="autoTrimTransparent"
              >Quitar espacio vacío</button>
              <button
                class="rc-tool-btn rc-tool-primary"
                type="button"
                data-test="resource-crop-apply"
                :disabled="cropBusy"
                @click="applyCrop"
              >{{ cropBusy ? 'Recortando…' : 'Aplicar recorte' }}</button>
              <button
                class="rc-tool-btn"
                type="button"
                data-test="resource-crop-cancel"
                :disabled="cropBusy"
                @click="exitCrop"
              >Cancelar</button>
            </template>
          </div>

          <div class="rc-modal-imgwrap">
            <div class="rc-crop-stage">
              <img
                ref="cropImgEl"
                class="rc-modal-img"
                :src="previewSrc(modalFile.src)"
                :alt="modalFile.name"
                @load="onModalImgLoad"
              />
              <div
                v-if="cropMode && crop"
                class="rc-crop-rect"
                data-test="resource-crop-rect"
                :style="cropRectStyle"
                @mousedown="onCropPointerDown('move', $event)"
              >
                <span
                  v-for="h in CROP_HANDLES"
                  :key="h"
                  :class="['rc-crop-handle', 'rc-crop-handle-' + h]"
                  @mousedown="onCropPointerDown(h, $event)"
                />
              </div>
            </div>
          </div>

          <div v-if="cropError" class="img-msg img-err" data-test="resource-crop-error">{{ cropError }}</div>
          <div v-if="cropMode" class="rc-crop-hint">
            Arrastra las esquinas o lados para ajustar, o el centro para mover. «Quitar
            espacio vacío» encuadra la ilustración. Al aplicar se reemplaza el archivo
            (y queda con ese tamaño dondequiera que se use).
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
/* Items arrastrables a la mesa (#154): cursor de agarre como pista. */
.rc-item-draggable { cursor: grab; }
.rc-item-draggable:active { cursor: grabbing; }
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
  /* flex-shrink dentro del modal (max-height:92vh) para que la imagen NUNCA
     empuje la barra/pie fuera de la pantalla (#159: se cortaba el recuadro).
     0 0 = no crece de más; 1 = encoge si el alto aprieta. */
  flex: 0 1 auto;
  min-height: 0;
  /* Padding interno: las manijas del recuadro sobresalen 6px del borde de la
     imagen; sin este colchón, overflow:hidden las recortaba. */
  padding: 10px;
  background: repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 22px 22px;
  border-radius: 6px;
  overflow: hidden;
}
.rc-modal-img {
  display: block;
  /* Cabe en el espacio que deja la barra (arriba) + pista/datos (abajo) dentro
     del modal de 92vh, sin recortes ni scroll. */
  max-width: 82vw;
  max-height: 68vh;
  object-fit: contain;
}
/* ── Recorte (#159) ──────────────────────────────────────────────────────── */
/* Barra de acciones sobre la imagen. */
.rc-modal-tools { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.rc-tool-btn {
  background: #2a2a2a; border: 1px solid #444; color: #ddd;
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
}
.rc-tool-btn:hover:not(:disabled) { border-color: var(--accent-strong, #0066cc); color: #fff; }
.rc-tool-btn:disabled { opacity: 0.5; cursor: default; }
.rc-tool-primary { background: var(--accent-strong, #0066cc); border-color: var(--accent-strong, #0066cc); color: #fff; }
/* La "tarima" envuelve la imagen EXACTAMENTE (inline-block) para que el recuadro
   de recorte, posicionado en % sobre ella, mapee 1:1 con los píxeles mostrados. */
.rc-crop-stage { position: relative; display: inline-block; line-height: 0; }
.rc-crop-rect {
  position: absolute;
  border: 1px solid #fff;
  /* Oscurece TODO lo de afuera del recuadro con una sombra gigante. */
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
  cursor: move;
  box-sizing: border-box;
}
.rc-crop-handle {
  position: absolute; width: 12px; height: 12px;
  background: #fff; border: 1px solid var(--accent-strong, #0066cc); border-radius: 2px;
}
.rc-crop-handle-nw { top: -6px; left: -6px; cursor: nwse-resize; }
.rc-crop-handle-n  { top: -6px; left: calc(50% - 6px); cursor: ns-resize; }
.rc-crop-handle-ne { top: -6px; right: -6px; cursor: nesw-resize; }
.rc-crop-handle-e  { top: calc(50% - 6px); right: -6px; cursor: ew-resize; }
.rc-crop-handle-se { bottom: -6px; right: -6px; cursor: nwse-resize; }
.rc-crop-handle-s  { bottom: -6px; left: calc(50% - 6px); cursor: ns-resize; }
.rc-crop-handle-sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.rc-crop-handle-w  { top: calc(50% - 6px); left: -6px; cursor: ew-resize; }
.rc-crop-hint { font-size: 11px; color: #9a9a9a; line-height: 1.4; text-align: center; max-width: 420px; }
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
