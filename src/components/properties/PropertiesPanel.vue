<script setup lang="ts">
import { computed, ref } from 'vue'
import { state, getSelected, setAtPath, getAtPath, addAnimation, removeAnimation } from '../../stores/editor'
import { ANCHOR_TYPES, SCROLL_BEHAVIORS, SEMANTIC_TAGS, SPLIT_MODES, TRIGGER_TYPES, ANIMATION_TYPES, EASING_PRESETS } from 'parallax-engine/schema'
import { projectsApi } from '../../composables/useApi'
import { usePanelScroll } from '../../composables/usePanelScroll'
import PropField from './PropField.vue'
import FontSizeField from './FontSizeField.vue'
import HelpHint from './HelpHint.vue'
import FormColorField from './FormColorField.vue'

// Plain-Spanish, non-technical help copy shown by the per-control "?" button.
const HELP = {
  sectionId: 'Nombre interno de esta sección. Sirve para identificarla; usa palabras sin acentos ni espacios.',
  sectionHeight: 'Qué tan alta es esta sección. "100vh" = una pantalla completa; "150vh" = una pantalla y media.',
  sectionScroll: 'Cómo se mueve el contenido al hacer scroll en esta sección (continuo, fijo, etc.).',
  layerId: 'Nombre interno de esta capa.',
  depth: 'Profundidad del efecto parallax. 0 = sin movimiento; valores más altos o más bajos hacen que se mueva más rápido o más lento que el resto.',
  blur: 'Desenfoque de toda la capa. 0 = nítido; más alto = más borroso (útil para fondos).',
  layerOpacity: 'Transparencia de toda la capa. 1 = visible; 0 = invisible.',
  perspective3d: 'Activa un efecto de profundidad 3D en esta capa.',
  blend: 'Modo de fusión con lo que hay debajo (ej. "multiply", "screen"). Déjalo vacío si no lo necesitas.',
  elementId: 'Nombre interno de este elemento.',
  posX: 'Posición horizontal, en porcentaje del ancho. 0 = pegado a la izquierda, 50 = centro, 100 = derecha.',
  posY: 'Posición vertical, en porcentaje del alto. 0 = arriba, 50 = centro, 100 = abajo.',
  width: 'Ancho del elemento como porcentaje del ancho de la sección.',
  height: 'Alto del elemento como porcentaje del alto de la sección.',
  anchor: 'Punto del elemento que se coloca en la posición elegida (centro, esquina, etc.).',
  opacity: 'Transparencia del elemento. 1 = totalmente visible; 0 = invisible.',
  rotation: 'Giro del elemento en grados. 0 = derecho; 90 = de costado.',
  visible: 'Si está desactivado, el elemento no se muestra en el sitio.',
  interactive: 'Permite que el elemento responda al mouse (clicks, hover).',
  src: 'Ruta del archivo de imagen. Normalmente se llena solo al cargar una imagen.',
  alt: 'Texto descriptivo de la imagen para accesibilidad y buscadores.',
  videoSrc: 'Ruta del archivo de video. Normalmente se llena solo al cargar un video.',
  audioSrc: 'Ruta del archivo de audio. Normalmente se llena solo al cargar un audio.',
  mediaAutoplay: 'Reproduce automáticamente al cargar. (El navegador suele exigir que esté en silencio).',
  mediaMuted: 'Inicia sin sonido.',
  mediaLoop: 'Vuelve a empezar automáticamente al terminar.',
  mediaControls: 'Muestra los controles de reproducción (play, volumen, etc.).',
  content: 'El texto que se muestra. Puedes escribir varias líneas.',
  font: 'Tipografía del texto. Déjalo vacío para usar la del sitio.',
  fontSize: 'Tamaño del texto. Usa los botones (Pequeño/Mediano/Grande/Título) o ajusta el número. El texto se adapta solo en móvil.',
  fontWeight: 'Grosor del texto. 400 = normal, 700 = negrita.',
  color: 'Color del texto.',
  semanticTag: 'Rol del texto en la página (título, párrafo…). Afecta accesibilidad y SEO, no el tamaño.',
  splitMode: 'Cómo se anima el texto al aparecer: por letras, por palabras o completo.',
  stagger: 'Retraso entre cada letra/palabra al animar (en segundos). 0 = todas a la vez.',
  linkUrl: 'Si pones una dirección, el elemento se vuelve un enlace al hacer click.',
  linkTarget: 'Dónde se abre el enlace: en una pestaña nueva o en la misma.',
  animType: 'Qué efecto se aplica (aparecer, deslizar, escalar…).',
  animTrigger: 'Cuándo se dispara la animación (al entrar en pantalla, al hacer scroll, al pasar el mouse…).',
  animFrom: 'Valor inicial de la animación.',
  animTo: 'Valor final de la animación.',
  animRange: 'Tramo del scroll (de 0 a 1) en el que ocurre la animación.',
  animDuration: 'Cuánto dura la animación, en milisegundos. 1000 = 1 segundo.',
  animDelay: 'Cuánto espera antes de empezar, en milisegundos.',
  animEasing: 'Estilo del movimiento (suave al inicio, al final, rebote…).',
  animLoop: 'Repite la animación en bucle.',
  animYoyo: 'Hace que la animación vaya y vuelva (ida y vuelta) en cada repetición.',
  // FormBlock
  formWebhook: 'Dirección a donde se envían las respuestas del formulario (por ejemplo un webhook de Make o Zapier). Déjalo vacío mientras no lo tengas.',
  formSubmit: 'Texto del botón para enviar el formulario (ej. "Confirmar").',
  formSuccess: 'Mensaje que se muestra cuando alguien envía el formulario correctamente.',
  formError: 'Mensaje que se muestra si el envío falla.',
  formHoneypot: 'Campo trampa anti-spam, invisible para las personas. Déjalo así salvo que sepas lo que haces.',
  formInputBg: 'Color de fondo de las casillas donde se escribe.',
  formInputBorder: 'Color del borde de las casillas.',
  formButtonBg: 'Color de fondo del botón de enviar.',
  formButtonText: 'Color del texto del botón de enviar.',
  formFont: 'Tipografía del formulario. Déjalo vacío para usar la del sitio.',
  formFieldName: 'Nombre interno del campo (sin acentos ni espacios). Es el que llega en la respuesta.',
  formFieldLabel: 'Texto visible que se le muestra a la persona sobre este campo.',
  formFieldType: 'Qué tipo de dato pide este campo (texto, email, teléfono, lista de opciones, etc.).',
  formFieldRequired: 'Si está activado, la persona está obligada a llenar este campo.',
  formFieldOptions: 'Opciones disponibles cuando el campo es lista, opción única o casillas. Una por línea.',
  formFieldMin: 'Valor mínimo permitido (solo para campos numéricos).',
  formFieldMax: 'Valor máximo permitido (solo para campos numéricos).',
}

// Field types supported by the engine FormBlock.
const FORM_FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'radio', 'checkbox', 'date']

// Wheel scrolling fix: keep wheel events over this panel away from the
// engine's window-level Lenis listener (see usePanelScroll).
const { panelScrollRef } = usePanelScroll()

const selected = computed(() => getSelected())

const TYPE_LABELS: Record<string, string> = {
  text: 'Texto',
  png: 'Imagen',
  video: 'Video',
  audio: 'Audio',
  component: 'Componente',
}

function updateProp(propName: string, value: any) {
  if (!state.selectedPath) return
  setAtPath(`${state.selectedPath}.${propName}`, value)
}

function updateNestedProp(baseProp: string, key: string, value: any) {
  if (!state.selectedPath) return
  const current = getAtPath(`${state.selectedPath}.${baseProp}`) || {}
  setAtPath(`${state.selectedPath}.${baseProp}`, { ...current, [key]: value })
}

// ─── FormBlock (component/FormBlock) editor ────────────────────────────────────

const isFormBlock = computed(
  () => selected.value?.data?.type === 'component' && selected.value?.data?.name === 'FormBlock',
)

// Ensure props object exists and update a single top-level prop on it.
function updateFormProp(key: string, value: any) {
  if (!state.selectedPath) return
  const current = getAtPath(`${state.selectedPath}.props`) || {}
  setAtPath(`${state.selectedPath}.props`, { ...current, [key]: value })
}

// Update a key inside props.styling.
function updateFormStyling(key: string, value: any) {
  if (!state.selectedPath) return
  const props = getAtPath(`${state.selectedPath}.props`) || {}
  const styling = { ...(props.styling || {}), [key]: value }
  setAtPath(`${state.selectedPath}.props`, { ...props, styling })
}

function formFields(): any[] {
  const f = getAtPath(`${state.selectedPath}.props.fields`)
  return Array.isArray(f) ? f : []
}

function writeFormFields(fields: any[]) {
  if (!state.selectedPath) return
  const props = getAtPath(`${state.selectedPath}.props`) || {}
  setAtPath(`${state.selectedPath}.props`, { ...props, fields })
}

function addFormField() {
  const fields = formFields().map((f) => ({ ...f }))
  const n = fields.length + 1
  fields.push({ name: `campo${n}`, label: `Campo ${n}`, type: 'text', required: false })
  writeFormFields(fields)
}

function removeFormField(index: number) {
  const fields = formFields().map((f) => ({ ...f }))
  fields.splice(index, 1)
  writeFormFields(fields)
}

function moveFormField(index: number, dir: -1 | 1) {
  const fields = formFields().map((f) => ({ ...f }))
  const to = index + dir
  if (to < 0 || to >= fields.length) return
  const [item] = fields.splice(index, 1)
  fields.splice(to, 0, item)
  writeFormFields(fields)
}

function updateFormField(index: number, key: string, value: any) {
  const fields = formFields().map((f) => ({ ...f }))
  if (!fields[index]) return
  fields[index] = { ...fields[index], [key]: value }
  writeFormFields(fields)
}

// options[] <-> one-per-line textarea string
function fieldOptionsText(field: any): string {
  return Array.isArray(field?.options) ? field.options.join('\n') : ''
}

function updateFormFieldOptions(index: number, text: string) {
  const opts = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  updateFormField(index, 'options', opts)
}

const FORM_FIELD_TYPE_OPTS = [...FORM_FIELD_TYPES]

// Friendly font choices. The site theme exposes --font-display / --font-body
// (see ParallaxSite.vue). We store the CSS string verbatim so the form
// inherits the site theme. "custom" lets her type her own family.
const FORM_FONT_OPTS = [
  { value: '', label: 'La del sitio (por defecto)' },
  { value: 'var(--font-body)', label: 'Texto del sitio' },
  { value: 'var(--font-display)', label: 'Títulos del sitio' },
  { value: '__custom__', label: 'Personalizada…' },
]

// Is the current fontFamily one of our presets, or a custom string?
function isCustomFont(v: string): boolean {
  if (!v) return false
  return !FORM_FONT_OPTS.some((o) => o.value === v && o.value !== '__custom__')
}

// The <select> shows "__custom__" whenever the stored value isn't a preset.
function fontSelectValue(v: string): string {
  return isCustomFont(v) ? '__custom__' : v || ''
}

function onFontSelect(sel: string) {
  // Picking "Personalizada…" keeps whatever custom value exists (or seeds
  // an empty one so the text box appears); presets store the CSS verbatim.
  if (sel === '__custom__') {
    const cur = (getAtPath(`${state.selectedPath}.props.styling.fontFamily`) as string) || ''
    updateFormStyling('fontFamily', isCustomFont(cur) ? cur : ' ')
    return
  }
  updateFormStyling('fontFamily', sel)
}

// ─── FormBlock editor: collapsible sections (accordion) ────────────────────────
// Lightweight disclosure, no deps. CAMPOS open by default (the essence of a
// form); Avanzado collapsed (webhook/honeypot are rarely touched). This kills
// the endless-scroll wall — only one or two groups are open at a time.
const formGroups = ref<Record<string, boolean>>({
  campos: true,
  textos: false,
  estilo: false,
  avanzado: false,
})

function toggleFormGroup(key: string) {
  formGroups.value[key] = !formGroups.value[key]
}

// ─── Asset upload: image / video / audio (pick from anywhere / drag&drop) ──────

// Per-kind upload state so the png, video and audio dropzones are independent.
type UploadKind = 'image' | 'video' | 'audio'

const fileInput = ref<HTMLInputElement | null>(null)
const videoFileInput = ref<HTMLInputElement | null>(null)
const audioFileInput = ref<HTMLInputElement | null>(null)

const uploading = ref(false)
const uploadError = ref<string | null>(null)
const uploadWarning = ref<string | null>(null)
const dragOver = ref(false)

const KIND_MIME_PREFIX: Record<UploadKind, string> = { image: 'image/', video: 'video/', audio: 'audio/' }
const KIND_NOUN: Record<UploadKind, string> = { image: 'imágenes', video: 'video', audio: 'audio' }

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('No se pudo leer el archivo'))
    fr.readAsDataURL(file)
  })
}

async function uploadAssetFile(file: File, kind: UploadKind) {
  uploadError.value = null
  uploadWarning.value = null
  if (!state.projectType || !state.slug || !state.selectedPath) return
  if (!file.type.startsWith(KIND_MIME_PREFIX[kind])) {
    uploadError.value = `Solo se permiten ${KIND_NOUN[kind]}`
    return
  }
  uploading.value = true
  try {
    const dataUrl = await readAsDataUrl(file)
    const r = await projectsApi.uploadAsset(state.projectType, state.slug, file.name, dataUrl)
    if (r.error || !r.src) {
      uploadError.value = r.error || 'No se pudo subir el archivo'
      return
    }
    // Store the CANONICAL relative src ("images/<f>" | "video/<f>" |
    // "audio/<f>") through the store (records undo + marks dirty). The
    // canvas/preview prefixes it with /content/<type>/<slug>/.
    setAtPath(`${state.selectedPath}.src`, r.src)
    if (r.warning) uploadWarning.value = r.warning
  } catch (e: any) {
    uploadError.value = e?.message || 'Error al subir el archivo'
  } finally {
    uploading.value = false
  }
}

// Back-compat alias for the (unchanged) PNG flow.
function uploadImageFile(file: File) {
  return uploadAssetFile(file, 'image')
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadImageFile(file)
  input.value = '' // allow re-picking the same file
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadImageFile(file)
}

// Generic pick/drop handlers for video & audio.
function onMediaPick(e: Event, kind: UploadKind) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) uploadAssetFile(file, kind)
  input.value = ''
}

function onMediaDrop(e: DragEvent, kind: UploadKind) {
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) uploadAssetFile(file, kind)
}

// Resolve a relative asset src to a preview URL (mirrors the png thumb logic).
function previewSrc(src: string): string {
  if (!src) return ''
  return src.startsWith('http') || src.startsWith('/')
    ? src
    : `/content/${state.projectType}/${state.slug}/${src}`
}

// ─── Animations sub-panel ──────────────────────────────────────────────────────

function updateAnim(index: number, key: string, value: any) {
  if (!state.selectedPath) return
  const anims = getAtPath(`${state.selectedPath}.animations`)
  if (!Array.isArray(anims) || !anims[index]) return
  setAtPath(`${state.selectedPath}.animations.${index}.${key}`, value)
}

function updateAnimRange(index: number, which: 0 | 1, value: any) {
  if (!state.selectedPath) return
  const anims = getAtPath(`${state.selectedPath}.animations`)
  if (!Array.isArray(anims) || !anims[index]) return
  const cur = Array.isArray(anims[index].range) ? [...anims[index].range] : [0, 1]
  cur[which] = Number(value)
  setAtPath(`${state.selectedPath}.animations.${index}.range`, cur)
}

// Display-only unit hint for size.width / size.height. The engine treats a
// bare number as % of the section (parallax-engine units util); a string is
// passed through verbatim, so it may already carry its own unit (px, clamp(),
// vw…). We never coerce the stored value — just label what it currently is.
function sizeUnit(v: unknown): string {
  if (v == null || v === '') return ''
  if (typeof v === 'number') return '%'
  const s = String(v).trim()
  if (s === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(s)) return '%' // numeric string → still %
  if (/clamp\s*\(/i.test(s)) return 'clamp()'
  const m = s.match(/(px|%|vw|vh|rem|em)\s*$/i)
  if (m) return m[1].toLowerCase()
  return '' // unknown expression: don't mislabel
}

const ANIM_TYPE_OPTS = [...ANIMATION_TYPES]
const TRIGGER_OPTS = [...TRIGGER_TYPES]
const EASING_OPTS = [...EASING_PRESETS]
</script>

<template>
  <div class="properties-panel">
    <div class="panel-header">Propiedades</div>

    <div class="panel-body" :ref="panelScrollRef">
      <div v-if="!selected" class="empty-state">
        Selecciona un elemento para editar sus propiedades
      </div>

      <div v-else class="props-content">
      <div class="prop-section-title">{{ selected.type }}</div>

      <!-- Section props -->
      <template v-if="selected.type === 'section'">
        <PropField label="ID" :help="HELP.sectionId" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField label="Altura" :help="HELP.sectionHeight" :modelValue="selected.data.height" @update:modelValue="updateProp('height', $event)" />
        <PropField label="Scroll" :help="HELP.sectionScroll" :modelValue="selected.data.scrollBehavior" type="select" :options="[...SCROLL_BEHAVIORS]" @update:modelValue="updateProp('scrollBehavior', $event)" />
      </template>

      <!-- Layer props -->
      <template v-if="selected.type === 'layer'">
        <PropField label="ID" :help="HELP.layerId" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <PropField label="Depth" :help="HELP.depth" :modelValue="selected.data.depth" type="number" :min="-1" :max="1" :step="0.1" @update:modelValue="updateProp('depth', $event)" />
        <PropField label="Blur" :help="HELP.blur" :modelValue="selected.data.blur" type="number" :min="0" @update:modelValue="updateProp('blur', $event)" />
        <PropField label="Opacidad" :help="HELP.layerOpacity" unit="0–1" :modelValue="selected.data.opacity" type="number" :min="0" :max="1" :step="0.1" @update:modelValue="updateProp('opacity', $event)" />
        <PropField label="3D" :help="HELP.perspective3d" :modelValue="selected.data.perspective3d" type="checkbox" @update:modelValue="updateProp('perspective3d', $event)" />
        <PropField label="Blend" :help="HELP.blend" :modelValue="selected.data.blendMode || ''" @update:modelValue="updateProp('blendMode', $event || undefined)" />
      </template>

      <!-- Element common props -->
      <template v-if="selected.type === 'element'">
        <PropField label="ID" :help="HELP.elementId" :modelValue="selected.data.id" @update:modelValue="updateProp('id', $event)" />
        <div class="prop-readonly">
          <span class="ro-label">Tipo</span>
          <span class="ro-value">{{ TYPE_LABELS[selected.data.type] || selected.data.type }}</span>
        </div>

        <div class="prop-group-title">Posicion</div>
        <PropField label="X" :help="HELP.posX" unit="%" :modelValue="selected.data.position?.x" type="number" @update:modelValue="updateNestedProp('position', 'x', $event)" />
        <PropField label="Y" :help="HELP.posY" unit="%" :modelValue="selected.data.position?.y" type="number" @update:modelValue="updateNestedProp('position', 'y', $event)" />

        <div class="prop-group-title">Tamano</div>
        <PropField label="Ancho" :help="HELP.width" :unit="sizeUnit(selected.data.size?.width)" placeholder="auto" :modelValue="selected.data.size?.width" @update:modelValue="updateNestedProp('size', 'width', $event)" />
        <PropField label="Alto" :help="HELP.height" :unit="sizeUnit(selected.data.size?.height)" placeholder="auto" :modelValue="selected.data.size?.height" @update:modelValue="updateNestedProp('size', 'height', $event)" />

        <div class="prop-group-title">Estilo</div>
        <PropField label="Anchor" :help="HELP.anchor" :modelValue="selected.data.anchor || 'center'" type="select" :options="[...ANCHOR_TYPES]" @update:modelValue="updateProp('anchor', $event)" />
        <PropField label="Opacidad" :help="HELP.opacity" unit="0–1" :modelValue="selected.data.opacity" type="number" :min="0" :max="1" :step="0.1" @update:modelValue="updateProp('opacity', $event)" />
        <PropField label="Rotacion" :help="HELP.rotation" unit="°" :modelValue="selected.data.rotation" type="number" @update:modelValue="updateProp('rotation', $event)" />
        <PropField label="Visible" :help="HELP.visible" :modelValue="selected.data.visible" type="checkbox" @update:modelValue="updateProp('visible', $event)" />
        <PropField label="Interactivo" :help="HELP.interactive" :modelValue="selected.data.interactive" type="checkbox" @update:modelValue="updateProp('interactive', $event)" />

        <!-- Type-specific -->
        <template v-if="selected.data.type === 'png'">
          <div class="prop-group-title">PNG</div>

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="png-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onDrop"
          >
            <img
              v-if="selected.data.src"
              class="img-preview-thumb"
              :src="selected.data.src.startsWith('http') || selected.data.src.startsWith('/')
                ? selected.data.src
                : `/content/${state.projectType}/${state.slug}/${selected.data.src}`"
              alt=""
            />
            <div class="img-dz-text">
              <span v-if="uploading">Subiendo…</span>
              <span v-else>Arrastra una imagen aquí</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="png-upload-btn"
              :disabled="uploading"
              @click="fileInput?.click()"
            >Cargar imagen</button>
            <input
              ref="fileInput"
              class="img-file-input"
              type="file"
              accept="image/*"
              data-test="png-file-input"
              @change="onFilePick"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="png-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="png-upload-warning">{{ uploadWarning }}</div>

          <PropField label="Src" :help="HELP.src" :modelValue="selected.data.src" @update:modelValue="updateProp('src', $event)" />
          <PropField label="Alt" :help="HELP.alt" :modelValue="selected.data.alt || ''" @update:modelValue="updateProp('alt', $event)" />
        </template>

        <template v-if="selected.data.type === 'text'">
          <div class="prop-group-title">Texto</div>
          <PropField label="Contenido" :help="HELP.content" :modelValue="selected.data.content" type="textarea" @update:modelValue="updateProp('content', $event)" />
          <PropField label="Fuente" :help="HELP.font" :modelValue="selected.data.font || ''" @update:modelValue="updateProp('font', $event)" />
          <FontSizeField :help="HELP.fontSize" :modelValue="selected.data.fontSize" @update:modelValue="updateProp('fontSize', $event)" />
          <PropField label="Peso" :help="HELP.fontWeight" :modelValue="selected.data.fontWeight || 400" type="number" @update:modelValue="updateProp('fontWeight', $event)" />
          <PropField label="Color" :help="HELP.color" :modelValue="selected.data.color || '#000'" type="color" @update:modelValue="updateProp('color', $event)" />
          <PropField label="Tag" :help="HELP.semanticTag" :modelValue="selected.data.semanticTag" type="select" :options="[...SEMANTIC_TAGS]" @update:modelValue="updateProp('semanticTag', $event)" />
          <PropField label="Split" :help="HELP.splitMode" :modelValue="selected.data.splitMode || 'none'" type="select" :options="[...SPLIT_MODES]" @update:modelValue="updateProp('splitMode', $event)" />
          <PropField label="Stagger" :help="HELP.stagger" :modelValue="selected.data.staggerDelay || 0" type="number" :min="0" @update:modelValue="updateProp('staggerDelay', $event)" />
        </template>

        <template v-if="selected.data.type === 'video'">
          <div class="prop-group-title">Video</div>

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="video-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onMediaDrop($event, 'video')"
          >
            <video
              v-if="selected.data.src"
              class="img-preview-thumb"
              :src="previewSrc(selected.data.src)"
              muted
              playsinline
            />
            <div class="img-dz-text">
              <span v-if="uploading">Subiendo…</span>
              <span v-else>Arrastra un video aquí</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="video-upload-btn"
              :disabled="uploading"
              @click="videoFileInput?.click()"
            >Cargar video</button>
            <input
              ref="videoFileInput"
              class="img-file-input"
              type="file"
              accept="video/*"
              data-test="video-file-input"
              @change="onMediaPick($event, 'video')"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="video-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="video-upload-warning">{{ uploadWarning }}</div>

          <PropField label="Src" :help="HELP.videoSrc" :modelValue="selected.data.src" @update:modelValue="updateProp('src', $event)" />
          <PropField label="Autoplay" :help="HELP.mediaAutoplay" :modelValue="selected.data.autoplay ?? false" type="checkbox" @update:modelValue="updateProp('autoplay', $event)" />
          <PropField label="Silencio" :help="HELP.mediaMuted" :modelValue="selected.data.muted ?? true" type="checkbox" @update:modelValue="updateProp('muted', $event)" />
          <PropField label="Loop" :help="HELP.mediaLoop" :modelValue="selected.data.loopMedia ?? false" type="checkbox" @update:modelValue="updateProp('loopMedia', $event)" />
          <PropField label="Controles" :help="HELP.mediaControls" :modelValue="selected.data.controls ?? true" type="checkbox" @update:modelValue="updateProp('controls', $event)" />
        </template>

        <template v-if="selected.data.type === 'audio'">
          <div class="prop-group-title">Audio</div>

          <div
            class="img-dropzone"
            :class="{ 'drag-over': dragOver, 'is-uploading': uploading }"
            data-test="audio-dropzone"
            @dragover.prevent="dragOver = true"
            @dragenter.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="onMediaDrop($event, 'audio')"
          >
            <audio
              v-if="selected.data.src"
              class="audio-preview"
              :src="previewSrc(selected.data.src)"
              controls
            />
            <div class="img-dz-text">
              <span v-if="uploading">Subiendo…</span>
              <span v-else>Arrastra un audio aquí</span>
            </div>
            <button
              class="img-pick-btn"
              type="button"
              data-test="audio-upload-btn"
              :disabled="uploading"
              @click="audioFileInput?.click()"
            >Cargar audio</button>
            <input
              ref="audioFileInput"
              class="img-file-input"
              type="file"
              accept="audio/*"
              data-test="audio-file-input"
              @change="onMediaPick($event, 'audio')"
            />
          </div>
          <div v-if="uploadError" class="img-msg img-err" data-test="audio-upload-error">{{ uploadError }}</div>
          <div v-if="uploadWarning" class="img-msg img-warn" data-test="audio-upload-warning">{{ uploadWarning }}</div>

          <PropField label="Src" :help="HELP.audioSrc" :modelValue="selected.data.src" @update:modelValue="updateProp('src', $event)" />
          <PropField label="Autoplay" :help="HELP.mediaAutoplay" :modelValue="selected.data.autoplay ?? false" type="checkbox" @update:modelValue="updateProp('autoplay', $event)" />
          <PropField label="Silencio" :help="HELP.mediaMuted" :modelValue="selected.data.muted ?? true" type="checkbox" @update:modelValue="updateProp('muted', $event)" />
          <PropField label="Loop" :help="HELP.mediaLoop" :modelValue="selected.data.loopMedia ?? false" type="checkbox" @update:modelValue="updateProp('loopMedia', $event)" />
          <PropField label="Controles" :help="HELP.mediaControls" :modelValue="selected.data.controls ?? true" type="checkbox" @update:modelValue="updateProp('controls', $event)" />
        </template>

        <!-- FormBlock (component/FormBlock) -->
        <template v-if="isFormBlock">
          <div class="prop-group-title">Formulario</div>
          <div class="form-editor" data-test="formblock-editor">

            <!-- ── CAMPOS (the essence of a form) — FIRST, open by default ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-campos"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.campos"
                @click="toggleFormGroup('campos')"
                @keydown.enter.prevent="toggleFormGroup('campos')"
                @keydown.space.prevent="toggleFormGroup('campos')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-campos-toggle">{{ formGroups.campos ? '▾' : '▸' }}</span>
                <span class="fb-group-name">Campos ({{ (selected.data.props?.fields || []).length }})</span>
                <button
                  class="anim-add"
                  data-test="formblock-add-field"
                  @click.stop="addFormField()"
                  title="Agregar campo"
                  aria-label="Agregar campo"
                >+</button>
              </div>

              <div v-show="formGroups.campos" class="fb-group-body" data-test="formblock-group-campos-body">
                <p v-if="!(selected.data.props?.fields || []).length" class="fb-empty">
                  Aún no hay campos. Usa el botón “+” para agregar el primero.
                </p>

                <div
                  v-for="(field, fi) in (selected.data.props?.fields || [])"
                  :key="fi"
                  class="anim-card form-field-card"
                  data-test="formblock-field"
                >
                  <div class="anim-card-head">
                    <span class="anim-card-title">{{ field.label || field.name || 'Campo' }}</span>
                    <span class="form-field-actions">
                      <button class="form-field-move" data-test="formblock-field-up" :disabled="fi === 0" @click="moveFormField(fi, -1)" title="Subir" aria-label="Subir campo">&uarr;</button>
                      <button class="form-field-move" data-test="formblock-field-down" :disabled="fi === (selected.data.props?.fields || []).length - 1" @click="moveFormField(fi, 1)" title="Bajar" aria-label="Bajar campo">&darr;</button>
                      <button class="anim-remove" data-test="formblock-field-remove" @click="removeFormField(fi)" title="Eliminar" aria-label="Eliminar campo">&times;</button>
                    </span>
                  </div>

                  <PropField label="Nombre" :help="HELP.formFieldName" :modelValue="field.name || ''" @update:modelValue="updateFormField(fi, 'name', $event)" />
                  <PropField label="Etiqueta" :help="HELP.formFieldLabel" :modelValue="field.label || ''" @update:modelValue="updateFormField(fi, 'label', $event)" />
                  <PropField label="Tipo" :help="HELP.formFieldType" :modelValue="field.type || 'text'" type="select" :options="FORM_FIELD_TYPE_OPTS" @update:modelValue="updateFormField(fi, 'type', $event)" />
                  <PropField label="Requerido" :help="HELP.formFieldRequired" :modelValue="!!field.required" type="checkbox" @update:modelValue="updateFormField(fi, 'required', $event)" />

                  <template v-if="field.type === 'select' || field.type === 'radio' || field.type === 'checkbox'">
                    <div class="prop-field form-options-field">
                      <label class="field-label">Opciones</label>
                      <textarea
                        class="field-input"
                        rows="3"
                        data-test="formblock-field-options"
                        :value="fieldOptionsText(field)"
                        @input="updateFormFieldOptions(fi, ($event.target as any).value)"
                      />
                      <HelpHint :text="HELP.formFieldOptions" label="Opciones" />
                    </div>
                  </template>

                  <template v-if="field.type === 'number'">
                    <PropField label="Mínimo" :help="HELP.formFieldMin" :modelValue="field.min ?? 0" type="number" @update:modelValue="updateFormField(fi, 'min', $event)" />
                    <PropField label="Máximo" :help="HELP.formFieldMax" :modelValue="field.max ?? 0" type="number" @update:modelValue="updateFormField(fi, 'max', $event)" />
                  </template>
                </div>
              </div>
            </section>

            <!-- ── TEXTOS (botón / éxito / error) ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-textos"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.textos"
                @click="toggleFormGroup('textos')"
                @keydown.enter.prevent="toggleFormGroup('textos')"
                @keydown.space.prevent="toggleFormGroup('textos')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-textos-toggle">{{ formGroups.textos ? '▾' : '▸' }}</span>
                <span class="fb-group-name">Textos</span>
              </div>

              <div v-show="formGroups.textos" class="fb-group-body" data-test="formblock-group-textos-body">
                <PropField label="Botón" :help="HELP.formSubmit" :modelValue="selected.data.props?.submitLabel || ''" @update:modelValue="updateFormProp('submitLabel', $event)" />
                <PropField label="Éxito" :help="HELP.formSuccess" :modelValue="selected.data.props?.successMessage || ''" type="textarea" @update:modelValue="updateFormProp('successMessage', $event)" />
                <PropField label="Error" :help="HELP.formError" :modelValue="selected.data.props?.errorMessage || ''" type="textarea" @update:modelValue="updateFormProp('errorMessage', $event)" />
              </div>
            </section>

            <!-- ── ESTILO (friendly color/font controls, no raw CSS) ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-estilo"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.estilo"
                @click="toggleFormGroup('estilo')"
                @keydown.enter.prevent="toggleFormGroup('estilo')"
                @keydown.space.prevent="toggleFormGroup('estilo')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-estilo-toggle">{{ formGroups.estilo ? '▾' : '▸' }}</span>
                <span class="fb-group-name">Estilo</span>
              </div>

              <div v-show="formGroups.estilo" class="fb-group-body" data-test="formblock-group-estilo-body">
                <FormColorField
                  label="Fondo de las casillas"
                  testKey="inputBg"
                  :help="HELP.formInputBg"
                  :modelValue="selected.data.props?.styling?.inputBg || ''"
                  @update:modelValue="updateFormStyling('inputBg', $event)"
                />
                <FormColorField
                  label="Borde de las casillas"
                  testKey="inputBorder"
                  :help="HELP.formInputBorder"
                  :modelValue="selected.data.props?.styling?.inputBorder || ''"
                  @update:modelValue="updateFormStyling('inputBorder', $event)"
                />
                <FormColorField
                  label="Fondo del botón"
                  testKey="buttonBg"
                  :help="HELP.formButtonBg"
                  :modelValue="selected.data.props?.styling?.buttonBg || ''"
                  @update:modelValue="updateFormStyling('buttonBg', $event)"
                />
                <FormColorField
                  label="Texto del botón"
                  testKey="buttonText"
                  :help="HELP.formButtonText"
                  :modelValue="selected.data.props?.styling?.buttonText || ''"
                  @update:modelValue="updateFormStyling('buttonText', $event)"
                />

                <div class="prop-field" data-test="formblock-style-fontFamily">
                  <label class="field-label">Tipografía</label>
                  <select
                    class="field-input field-control"
                    data-test="formblock-style-fontFamily-select"
                    :value="fontSelectValue(selected.data.props?.styling?.fontFamily || '')"
                    @change="onFontSelect(($event.target as any).value)"
                  >
                    <option v-for="o in FORM_FONT_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <HelpHint :text="HELP.formFont" label="Tipografía" />
                </div>
                <div
                  v-if="isCustomFont(selected.data.props?.styling?.fontFamily || '')"
                  class="prop-field"
                >
                  <label class="field-label">Personalizada</label>
                  <input
                    type="text"
                    class="field-input field-control"
                    data-test="formblock-style-fontFamily-custom"
                    placeholder="ej. Georgia, serif"
                    :value="(selected.data.props?.styling?.fontFamily || '').trim()"
                    @input="updateFormStyling('fontFamily', ($event.target as any).value)"
                  />
                </div>
              </div>
            </section>

            <!-- ── AVANZADO (webhook / honeypot) — collapsed by default ── -->
            <section class="fb-group">
              <div
                class="fb-group-head"
                data-test="formblock-group-avanzado"
                role="button"
                tabindex="0"
                :aria-expanded="formGroups.avanzado"
                @click="toggleFormGroup('avanzado')"
                @keydown.enter.prevent="toggleFormGroup('avanzado')"
                @keydown.space.prevent="toggleFormGroup('avanzado')"
              >
                <span class="fb-group-toggle" data-test="formblock-group-avanzado-toggle">{{ formGroups.avanzado ? '▾' : '▸' }}</span>
                <span class="fb-group-name">Avanzado</span>
              </div>

              <div v-show="formGroups.avanzado" class="fb-group-body" data-test="formblock-group-avanzado-body">
                <PropField label="Webhook" :help="HELP.formWebhook" :modelValue="selected.data.props?.webhookUrl || ''" @update:modelValue="updateFormProp('webhookUrl', $event)" />
                <PropField label="Honeypot" :help="HELP.formHoneypot" :modelValue="selected.data.props?.honeypotField || ''" @update:modelValue="updateFormProp('honeypotField', $event)" />
              </div>
            </section>

          </div>
        </template>

        <!-- Link -->
        <div class="prop-group-title">Link</div>
        <PropField label="URL" :help="HELP.linkUrl" :modelValue="selected.data.link?.href || ''" @update:modelValue="updateNestedProp('link', 'href', $event)" />
        <PropField label="Target" :help="HELP.linkTarget" :modelValue="selected.data.link?.target || '_blank'" type="select" :options="['_blank', '_self']" @update:modelValue="updateNestedProp('link', 'target', $event)" />

        <!-- Animations sub-panel -->
        <div class="prop-group-title anim-header">
          <span>Animaciones ({{ selected.data.animations?.length || 0 }})</span>
          <button class="anim-add" @click="addAnimation()" title="Agregar animacion" aria-label="Agregar animacion">+</button>
        </div>

        <div
          v-for="(anim, i) in (selected.data.animations || [])"
          :key="i"
          class="anim-card"
        >
          <div class="anim-card-head">
            <span class="anim-card-title">{{ anim.type }} · {{ anim.trigger }}</span>
            <button class="anim-remove" @click="removeAnimation(i)" title="Eliminar" aria-label="Eliminar animacion">&times;</button>
          </div>

          <PropField
            label="Tipo"
            :help="HELP.animType"
            :modelValue="anim.type"
            type="select"
            :options="ANIM_TYPE_OPTS"
            @update:modelValue="updateAnim(i, 'type', $event)"
          />
          <PropField
            label="Trigger"
            :help="HELP.animTrigger"
            :modelValue="anim.trigger"
            type="select"
            :options="TRIGGER_OPTS"
            @update:modelValue="updateAnim(i, 'trigger', $event)"
          />
          <PropField
            label="Desde"
            :help="HELP.animFrom"
            :modelValue="anim.from"
            type="number"
            @update:modelValue="updateAnim(i, 'from', $event)"
          />
          <PropField
            label="Hasta"
            :help="HELP.animTo"
            :modelValue="anim.to"
            type="number"
            @update:modelValue="updateAnim(i, 'to', $event)"
          />

          <template v-if="anim.trigger === 'scroll'">
            <div class="anim-range-row">
              <span class="field-label-inline">Rango</span>
              <span class="anim-range-inputs">
                <input
                  class="anim-range-input"
                  type="number"
                  step="0.05"
                  :value="Array.isArray(anim.range) ? anim.range[0] : 0"
                  @input="updateAnimRange(i, 0, ($event.target as any).value)"
                  aria-label="Rango inicio"
                />
                <input
                  class="anim-range-input"
                  type="number"
                  step="0.05"
                  :value="Array.isArray(anim.range) ? anim.range[1] : 1"
                  @input="updateAnimRange(i, 1, ($event.target as any).value)"
                  aria-label="Rango fin"
                />
              </span>
              <HelpHint :text="HELP.animRange" label="Rango" />
            </div>
          </template>

          <PropField
            label="Duracion"
            :help="HELP.animDuration"
            unit="ms"
            :modelValue="anim.duration ?? 800"
            type="number"
            :min="0"
            @update:modelValue="updateAnim(i, 'duration', $event)"
          />
          <PropField
            label="Delay"
            :help="HELP.animDelay"
            unit="ms"
            :modelValue="anim.delay ?? 0"
            type="number"
            :min="0"
            @update:modelValue="updateAnim(i, 'delay', $event)"
          />
          <PropField
            label="Easing"
            :help="HELP.animEasing"
            :modelValue="anim.easing || 'easeInOut'"
            type="select"
            :options="EASING_OPTS"
            @update:modelValue="updateAnim(i, 'easing', $event)"
          />

          <template v-if="anim.trigger === 'loop'">
            <PropField
              label="Loop"
              :help="HELP.animLoop"
              :modelValue="anim.loop ?? true"
              type="checkbox"
              @update:modelValue="updateAnim(i, 'loop', $event)"
            />
            <PropField
              label="Yoyo"
              :help="HELP.animYoyo"
              :modelValue="anim.yoyo ?? false"
              type="checkbox"
              @update:modelValue="updateAnim(i, 'yoyo', $event)"
            />
          </template>
        </div>
      </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.properties-panel { background: #1e1e1e; font-size: 13px; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.panel-header { padding: 10px 12px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #333; flex-shrink: 0; }
.panel-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.empty-state { padding: 24px 12px; color: #666; text-align: center; font-size: 12px; }
.props-content { padding: 8px 12px; }
.prop-section-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; text-transform: capitalize; }
.prop-group-title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 12px; margin-bottom: 4px; padding-top: 8px; border-top: 1px solid #333; }
.prop-readonly { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.ro-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.ro-value { flex: 1; font-size: 12px; color: #aaa; background: #242424; border: 1px solid #333; border-radius: 4px; padding: 4px 8px; }
.anim-header { display: flex; align-items: center; justify-content: space-between; }
.anim-add { background: #2a7d2a; border: none; color: #fff; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 13px; line-height: 1; }
.anim-add:hover { background: #339933; }
.anim-card { background: #242424; border: 1px solid #333; border-radius: 6px; padding: 8px; margin: 6px 0; }
.anim-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.anim-card-title { font-size: 11px; color: #6cb3ff; text-transform: capitalize; }
.anim-remove { background: none; border: none; color: #888; font-size: 15px; cursor: pointer; line-height: 1; }
.anim-remove:hover { color: #ff6b6b; }
/* Same row contract as PropField: label (auto) + control (flex:1, min-width:0)
   + ? (fixed). Never overflows the panel content width. */
.anim-range-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label-inline { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.anim-range-inputs { flex: 1 1 auto; min-width: 0; display: flex; gap: 6px; }
.anim-range-input { flex: 1 1 0; min-width: 0; width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; }

.img-dropzone { display: flex; flex-direction: column; align-items: center; gap: 8px; border: 1.5px dashed #444; border-radius: 6px; padding: 12px; background: #242424; margin: 4px 0 8px; text-align: center; transition: border-color 0.15s, background 0.15s; }
.img-dropzone.drag-over { border-color: #0066cc; background: #1f2c3a; }
.img-dropzone.is-uploading { opacity: 0.7; }
.img-preview-thumb { max-width: 100%; max-height: 90px; border-radius: 4px; object-fit: contain; background: repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 16px 16px; }
.audio-preview { width: 100%; height: 32px; }
.img-dz-text { font-size: 11px; color: #888; }
.img-pick-btn { background: #0066cc; border: none; color: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
.img-pick-btn:hover:not(:disabled) { background: #0077e6; }
.img-pick-btn:disabled { opacity: 0.6; cursor: default; }
.img-file-input { display: none; }
.form-field-card { border-color: #3a3a4a; }
.form-field-actions { display: flex; align-items: center; gap: 4px; }
.form-field-move { background: none; border: none; color: #888; font-size: 12px; cursor: pointer; line-height: 1; padding: 0 2px; }
.form-field-move:hover:not(:disabled) { color: #6cb3ff; }
.form-field-move:disabled { opacity: 0.3; cursor: default; }
/* The hand-rolled "Opciones" row mirrors PropField's row contract so its "?"
   never overflows the panel (PropField's scoped styles don't leak here). */
.form-options-field { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; max-width: 100%; }
.form-options-field .field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; padding-top: 4px; }
.form-options-field .field-input { flex: 1 1 auto; min-width: 0; width: 100%; box-sizing: border-box; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 8px; font-size: 12px; font-family: inherit; resize: vertical; }

/* ── FormBlock accordion groups ──────────────────────────────────────────── */
.form-editor { max-width: 100%; }
.fb-group { border: 1px solid #333; border-radius: 6px; margin: 8px 0; overflow: hidden; background: #1f1f1f; }
.fb-group-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: pointer; user-select: none;
  background: #262626; border-bottom: 1px solid transparent;
}
.fb-group-head:hover { background: #2c2c2c; }
.fb-group-head:focus-visible { outline: 2px solid #0099ff; outline-offset: -2px; }
.fb-group-toggle { font-size: 11px; color: #888; width: 12px; flex: 0 0 12px; }
.fb-group-name {
  flex: 1 1 auto; font-size: 12px; font-weight: 600; color: #ddd;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.fb-group-body { padding: 8px 10px; border-top: 1px solid #333; }
.fb-empty { font-size: 11px; color: #777; margin: 4px 0; line-height: 1.4; }

.img-msg { font-size: 11px; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px; }
.img-err { color: #ff8a8a; background: #3a1f1f; border: 1px solid #5a2a2a; }
.img-warn { color: #ffd27a; background: #3a321f; border: 1px solid #5a4a2a; }
</style>
