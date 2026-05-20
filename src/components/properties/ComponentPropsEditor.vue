<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { state, getAtPath, setAtPath, type ComponentRegistration, type EditablePropSchema } from '../../stores/editor'
import { projectsApi } from '../../composables/useApi'
import type { ProjectAsset } from '../../composables/useApi'
import PropField from './PropField.vue'
import FormColorField from './FormColorField.vue'
import HelpHint from './HelpHint.vue'
import ResourceCombobox from './ResourceCombobox.vue'
import type { ComboOption } from './ResourceCombobox.vue'

// GENERIC editableProps → controls renderer for any `type:'component'`
// element whose `name` is in the registry (PLAN §13). One control per
// editableProp by `type`:
//   string  → text     number → number   boolean → checkbox
//   select  → labeled select (options)    color  → FormColorField swatches
//   image   → the existing image-upload control (copies into content/)
//   array   → add/remove rows of itemSchema fields
// Props NOT in editableProps are never shown. Writes go through the store
// (undo + dirty), same contract as every other panel control.

const props = defineProps<{ registration: ComponentRegistration }>()

const PROPS_PATH = computed(() => `${state.selectedPath}.props`)

function currentProps(): Record<string, any> {
  const p = getAtPath(PROPS_PATH.value)
  return p && typeof p === 'object' ? p : {}
}

// Update a single top-level prop, preserving the rest. Mirrors FormBlock's
// updateFormProp: replace the whole props object so reactivity + undo fire.
function setProp(key: string, value: any) {
  if (!state.selectedPath) return
  setAtPath(PROPS_PATH.value, { ...currentProps(), [key]: value })
}

function propValue(key: string): any {
  return currentProps()[key]
}

const schemaEntries = computed(() =>
  Object.entries(props.registration.editableProps || {}) as [string, EditablePropSchema][],
)

// ── array prop CRUD (rows of itemSchema fields) ────────────────────────────
function arrayRows(key: string): any[] {
  const v = propValue(key)
  return Array.isArray(v) ? v : []
}

function blankRow(schema: EditablePropSchema): Record<string, any> {
  const row: Record<string, any> = {}
  for (const [k, s] of Object.entries(schema.itemSchema || {})) {
    if (s.default !== undefined) row[k] = JSON.parse(JSON.stringify(s.default))
    else if (s.type === 'number') row[k] = 0
    else if (s.type === 'boolean') row[k] = false
    else row[k] = ''
  }
  return row
}

function addRow(key: string, schema: EditablePropSchema) {
  const rows = arrayRows(key).map((r) => ({ ...r }))
  rows.push(blankRow(schema))
  setProp(key, rows)
}

function removeRow(key: string, idx: number) {
  const rows = arrayRows(key).map((r) => ({ ...r }))
  rows.splice(idx, 1)
  setProp(key, rows)
}

function moveRow(key: string, idx: number, dir: -1 | 1) {
  const rows = arrayRows(key).map((r) => ({ ...r }))
  const to = idx + dir
  if (to < 0 || to >= rows.length) return
  const [item] = rows.splice(idx, 1)
  rows.splice(to, 0, item)
  setProp(key, rows)
}

function updateRowField(key: string, idx: number, field: string, value: any) {
  const rows = arrayRows(key).map((r) => ({ ...r }))
  if (!rows[idx]) return
  rows[idx] = { ...rows[idx], [field]: value }
  setProp(key, rows)
}

// ── image prop upload (reuses the project asset endpoint, like PNG) ────────
const uploading = ref<string | null>(null) // key being uploaded
const uploadError = ref<string | null>(null)
const fileInputs = ref<Record<string, HTMLInputElement | null>>({})

function previewSrc(src: string): string {
  if (!src) return ''
  return src.startsWith('http') || src.startsWith('/')
    ? src
    : `/content/${state.projectType}/${state.slug}/${src}`
}

// Image autocomplete for `type:'image'` editableProps — same source as the
// "Recursos" panel (TASK #85). Free text still allowed; suggestions = the
// project's images/* with thumbnails. Refreshed on mount, project change,
// and after an upload here.
const projectImages = ref<ProjectAsset[]>([])
async function refreshImages() {
  if (!state.projectType || !state.slug) {
    projectImages.value = []
    return
  }
  try {
    const r = await projectsApi.listAssets(state.projectType, state.slug)
    if (r.assets) projectImages.value = r.assets.image || []
  } catch {
    /* keep last list */
  }
}
onMounted(refreshImages)
watch(() => [state.projectType, state.slug], refreshImages)
const imageOptions = computed<ComboOption[]>(() =>
  projectImages.value.map((a) => ({
    value: a.src,
    label: a.src,
    thumb: previewSrc(a.src),
    hint: a.bytes ? `${(a.bytes / 1024).toFixed(0)} KB` : undefined,
  })),
)

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(new Error('No se pudo leer el archivo'))
    fr.readAsDataURL(file)
  })
}

async function onImagePick(key: string, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !state.projectType || !state.slug) return
  if (!file.type.startsWith('image/')) {
    uploadError.value = 'Solo se permiten imágenes'
    return
  }
  uploadError.value = null
  uploading.value = key
  try {
    const dataUrl = await readAsDataUrl(file)
    const r = await projectsApi.uploadAsset(state.projectType, state.slug, file.name, dataUrl)
    if (r.error || !r.src) {
      uploadError.value = r.error || 'No se pudo subir la imagen'
      return
    }
    setProp(key, r.src)
    refreshImages()
  } catch (err: any) {
    uploadError.value = err?.message || 'Error al subir la imagen'
  } finally {
    uploading.value = null
  }
}

function fieldHelp(schema: EditablePropSchema): string {
  return schema.label
    ? `${schema.label} — propiedad del componente "${props.registration.label}".`
    : ''
}
</script>

<template>
  <div class="component-props" data-test="component-props-editor">
    <div class="cp-desc" v-if="registration.description" data-test="component-props-desc">
      {{ registration.description }}
    </div>

    <template v-for="[key, schema] in schemaEntries" :key="key">
      <!-- string -->
      <div v-if="schema.type === 'string'" :data-test="`component-prop-${key}`">
        <PropField
          :label="schema.label || key"
          :help="fieldHelp(schema)"
          :modelValue="propValue(key) ?? ''"
          @update:modelValue="setProp(key, $event)"
        />
      </div>

      <!-- number -->
      <div v-else-if="schema.type === 'number'" :data-test="`component-prop-${key}`">
        <PropField
          :label="schema.label || key"
          :help="fieldHelp(schema)"
          type="number"
          :modelValue="propValue(key) ?? 0"
          @update:modelValue="setProp(key, $event)"
        />
      </div>

      <!-- boolean -->
      <div v-else-if="schema.type === 'boolean'" :data-test="`component-prop-${key}`">
        <PropField
          :label="schema.label || key"
          :help="fieldHelp(schema)"
          type="checkbox"
          :modelValue="propValue(key) ?? false"
          @update:modelValue="setProp(key, $event)"
        />
      </div>

      <!-- select (labeled options) -->
      <div
        v-else-if="schema.type === 'select'"
        class="prop-field"
        :data-test="`component-prop-${key}`"
      >
        <label class="field-label">{{ schema.label || key }}</label>
        <select
          class="field-input field-control"
          :data-test="`component-prop-${key}-select`"
          :value="propValue(key) ?? (schema.options && schema.options[0]) ?? ''"
          @change="setProp(key, ($event.target as any).value)"
        >
          <option v-for="o in (schema.options || [])" :key="o" :value="o">{{ o }}</option>
        </select>
        <HelpHint :text="fieldHelp(schema)" :label="schema.label || key" />
      </div>

      <!-- color -->
      <div v-else-if="schema.type === 'color'" :data-test="`component-prop-${key}`">
        <FormColorField
          :label="schema.label || key"
          :help="fieldHelp(schema)"
          :testKey="`cprop-${key}`"
          :modelValue="propValue(key) ?? ''"
          @update:modelValue="setProp(key, $event)"
        />
      </div>

      <!-- image (upload into content/, store relative src) -->
      <div
        v-else-if="schema.type === 'image'"
        class="cp-image"
        :data-test="`component-prop-${key}`"
      >
        <div class="cp-image-head">
          <label class="field-label">{{ schema.label || key }}</label>
          <HelpHint :text="fieldHelp(schema)" :label="schema.label || key" />
        </div>
        <div class="img-dropzone">
          <img
            v-if="propValue(key)"
            class="img-preview-thumb"
            :src="previewSrc(String(propValue(key)))"
            alt=""
          />
          <div class="img-dz-text">
            <span v-if="uploading === key">Subiendo…</span>
            <span v-else>Imagen del componente</span>
          </div>
          <button
            class="img-pick-btn"
            type="button"
            :data-test="`component-prop-${key}-upload-btn`"
            :disabled="uploading === key"
            @click="fileInputs[key]?.click()"
          >Cargar imagen</button>
          <input
            :ref="(el) => (fileInputs[key] = el as HTMLInputElement)"
            class="img-file-input"
            type="file"
            accept="image/*"
            :data-test="`component-prop-${key}-file-input`"
            @change="onImagePick(key, $event)"
          />
        </div>
        <ResourceCombobox
          label="Src"
          placeholder="images/foto.png"
          :test-id="`component-prop-${key}-src`"
          :suggestions="imageOptions"
          :modelValue="String(propValue(key) ?? '')"
          @update:modelValue="setProp(key, $event)"
        />
      </div>

      <!-- array (rows of itemSchema fields) -->
      <div
        v-else-if="schema.type === 'array'"
        class="cp-array"
        :data-test="`component-prop-${key}`"
      >
        <div class="cp-array-head">
          <span class="cp-array-title">
            {{ schema.label || key }} ({{ arrayRows(key).length }})
          </span>
          <HelpHint :text="fieldHelp(schema)" :label="schema.label || key" />
          <button
            class="cp-array-add"
            type="button"
            :data-test="`component-prop-${key}-add`"
            @click="addRow(key, schema)"
            :aria-label="`Agregar a ${schema.label || key}`"
          >+ Agregar</button>
        </div>
        <p v-if="!arrayRows(key).length" class="cp-array-empty">
          Sin elementos. Usa “+ Agregar”.
        </p>
        <div
          v-for="(row, ri) in arrayRows(key)"
          :key="ri"
          class="cp-array-row"
          :data-test="`component-prop-${key}-row`"
        >
          <div class="cp-row-head">
            <span class="cp-row-idx">#{{ ri + 1 }}</span>
            <span class="cp-row-actions">
              <button
                type="button"
                class="cp-row-btn"
                :data-test="`component-prop-${key}-row-up`"
                :disabled="ri === 0"
                @click="moveRow(key, ri, -1)"
                title="Subir"
                aria-label="Subir"
              >&uarr;</button>
              <button
                type="button"
                class="cp-row-btn"
                :data-test="`component-prop-${key}-row-down`"
                :disabled="ri === arrayRows(key).length - 1"
                @click="moveRow(key, ri, 1)"
                title="Bajar"
                aria-label="Bajar"
              >&darr;</button>
              <button
                type="button"
                class="cp-row-btn cp-row-del"
                :data-test="`component-prop-${key}-row-remove`"
                @click="removeRow(key, ri)"
                title="Eliminar"
                aria-label="Eliminar"
              >&times;</button>
            </span>
          </div>
          <template
            v-for="[fk, fs] in Object.entries(schema.itemSchema || {})"
            :key="fk"
          >
            <PropField
              v-if="fs.type === 'number'"
              :label="fs.label || fk"
              type="number"
              :modelValue="(row && row[fk]) ?? 0"
              @update:modelValue="updateRowField(key, ri, fk, $event)"
            />
            <PropField
              v-else-if="fs.type === 'boolean'"
              :label="fs.label || fk"
              type="checkbox"
              :modelValue="(row && row[fk]) ?? false"
              @update:modelValue="updateRowField(key, ri, fk, $event)"
            />
            <div
              v-else-if="fs.type === 'select'"
              class="prop-field"
            >
              <label class="field-label">{{ fs.label || fk }}</label>
              <select
                class="field-input field-control"
                :value="(row && row[fk]) ?? (fs.options && fs.options[0]) ?? ''"
                @change="updateRowField(key, ri, fk, ($event.target as any).value)"
              >
                <option v-for="o in (fs.options || [])" :key="o" :value="o">{{ o }}</option>
              </select>
            </div>
            <PropField
              v-else
              :label="fs.label || fk"
              :modelValue="(row && row[fk]) ?? ''"
              @update:modelValue="updateRowField(key, ri, fk, $event)"
            />
          </template>
        </div>
      </div>
    </template>

    <div v-if="uploadError" class="img-msg img-err" data-test="component-prop-upload-error">
      {{ uploadError }}
    </div>
  </div>
</template>

<style scoped>
.component-props { padding-top: 2px; }
.cp-desc { font-size: 11px; color: #888; padding: 4px 0 8px; line-height: 1.4; }
.cp-image-head,
.cp-array-head { display: flex; align-items: center; gap: 6px; padding: 6px 0 4px; }
.cp-array-title { font-size: 11px; color: #999; font-weight: 600; flex: 1 1 auto; }
.cp-array-add,
.cp-row-btn {
  background: #2a2a2a; border: 1px solid #444; border-radius: 4px;
  color: #ddd; cursor: pointer; font-size: 11px; padding: 3px 8px;
}
.cp-array-add:hover,
.cp-row-btn:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.cp-row-btn:disabled { opacity: 0.4; cursor: default; }
.cp-array-empty { font-size: 11px; color: #666; padding: 4px 0; }
.cp-array-row {
  border: 1px solid #333; border-radius: 6px; padding: 6px 8px;
  margin-bottom: 6px; background: #232323;
}
.cp-row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.cp-row-idx { font-size: 10px; color: #777; }
.cp-row-actions { display: flex; gap: 4px; }
.cp-row-del:hover { background: #b23a3a; border-color: #b23a3a; }
.cp-image .img-dropzone {
  border: 1px dashed #444; border-radius: 6px; padding: 10px;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  text-align: center; margin-bottom: 4px;
}
.img-preview-thumb { max-width: 100%; max-height: 90px; border-radius: 4px; }
.img-dz-text { font-size: 11px; color: #888; }
.img-pick-btn {
  background: #2a2a2a; border: 1px solid #444; border-radius: 4px;
  color: #ddd; cursor: pointer; font-size: 11px; padding: 4px 10px;
}
.img-pick-btn:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.img-file-input { display: none; }
.img-msg { font-size: 11px; padding: 4px 0; }
.img-err { color: #ff7a7a; }
/* Match PropField row styling for the custom select rows */
.prop-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; max-width: 100%; }
.field-label { font-size: 11px; color: #999; min-width: 70px; flex-shrink: 0; }
.field-control { flex: 1 1 auto; min-width: 0; }
.field-input {
  width: 100%; box-sizing: border-box; background: #2a2a2a;
  border: 1px solid #444; border-radius: 4px; color: #e0e0e0;
  padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.field-input:focus { outline: 1px solid var(--accent-strong); border-color: var(--accent-strong); }
/* Homogenize the <select> chevron to match PropField / GradientBuilder so every
   dropdown in the editor shows the identical custom arrow + right-side gap
   (instead of the native OS arrow). Styling only. */
select.field-input {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='7' viewBox='0 0 10 7'><path d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
</style>
