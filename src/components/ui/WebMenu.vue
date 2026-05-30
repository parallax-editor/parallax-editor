<script setup lang="ts">
// ─── WebMenu — menú superior para la versión web (no-Electron) ───────────────
//
// El menú nativo de Electron (electron/main.cjs → buildMenu) no existe en
// `yarn editor` (navegador). Este componente cubre ese gap: replica las mismas
// acciones, las dispara por el MISMO bus interno (`emitMenu`) que las vistas
// ya escuchan, y agrega el switcher de idioma que en Electron vive en
// "Ventana → Idioma".
//
// Diseño: barra fija arriba, una fila de menús estilo macOS (Archivo, Edición,
// Elemento, Git, Publicar, Ver, Ventana, Idioma, Ayuda). Cada menú abre un
// dropdown al click. Esc cierra. Click fuera cierra.
//
// Solo se renderiza cuando NO estamos en Electron (useElectron.isElectron
// false). En Electron el menú nativo es el oficial; pintar este encima sería
// duplicado.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { emitMenu } from '../../composables/useMenu'
import { setLocale, currentLocale, type Locale } from '../../i18n'
import { activeWorkspace } from '../../stores/workspaces'

const { t } = useI18n()
const route = useRoute()

// `inEditor` = true cuando hay un sitio abierto (ruta /edit). Replica el
// comportamiento del menú nativo: en el home/selector se deshabilitan
// Edición/Elemento/Git/Publicar/Ver/Ventana y los items que no aplican.
const inEditor = computed(() => typeof route.path === 'string' && route.path.startsWith('/edit'))
const ws = computed(() => activeWorkspace.value as any | null)
const useGit = computed(() => !!ws.value && ws.value.useGit !== false)
const hasS3 = computed(() => !!(ws.value && ws.value.s3?.enabled))

interface Item {
  label: string
  action?: string
  disabled?: boolean
  separator?: boolean
  // Custom click handler that bypasses the emitMenu bus (used by Language).
  onClick?: () => void
  // For the language radio items.
  checked?: boolean
}
interface Menu {
  id: string
  label: string
  items: Item[]
}

const menus = computed<Menu[]>(() => [
  {
    id: 'file', label: t('webmenu.file'),
    items: [
      { label: t('webmenu.fileNew'), action: 'file.new' },
      { label: t('webmenu.fileOpen'), action: 'file.open' },
      { separator: true, label: '' },
      { label: t('webmenu.fileSave'), action: 'file.save', disabled: !inEditor.value },
      { label: t('webmenu.fileImport'), action: 'file.import', disabled: !inEditor.value },
      { separator: true, label: '' },
      { label: t('webmenu.fileClose'), action: 'file.close', disabled: !inEditor.value },
    ],
  },
  {
    id: 'edit', label: t('webmenu.edit'),
    items: [
      { label: t('webmenu.undo'), action: 'edit.undo', disabled: !inEditor.value },
      { label: t('webmenu.redo'), action: 'edit.redo', disabled: !inEditor.value },
      { separator: true, label: '' },
      { label: t('webmenu.duplicate'), action: 'edit.duplicate', disabled: !inEditor.value },
      { label: t('webmenu.deleteLbl'), action: 'edit.delete', disabled: !inEditor.value },
    ],
  },
  {
    id: 'element', label: t('webmenu.element'),
    items: [
      { label: t('webmenu.addElement'), action: 'element.add', disabled: !inEditor.value },
      { label: t('webmenu.addSection'), action: 'element.addSection', disabled: !inEditor.value },
      { separator: true, label: '' },
      { label: t('webmenu.toggleLock'), action: 'element.toggleLock', disabled: !inEditor.value },
      { label: t('webmenu.toggleVisible'), action: 'element.toggleVisible', disabled: !inEditor.value },
    ],
  },
  {
    id: 'git', label: t('webmenu.git'),
    items: [
      { label: t('webmenu.gitPull'), action: 'git.pull', disabled: !inEditor.value || !useGit.value },
      { label: t('webmenu.gitHistory'), action: 'git.history', disabled: !inEditor.value || !useGit.value },
      { label: t('webmenu.gitStatus'), action: 'git.status', disabled: !inEditor.value || !useGit.value },
    ],
  },
  {
    id: 'publish', label: t('webmenu.publish'),
    items: [
      { label: t('webmenu.publishS3'), action: 'deploy.publish', disabled: !inEditor.value || !hasS3.value },
      { label: t('webmenu.livePreview'), action: 'deploy.preview', disabled: !inEditor.value },
      { label: t('webmenu.openPublished'), action: 'deploy.openSite', disabled: !inEditor.value || !hasS3.value },
    ],
  },
  {
    id: 'view', label: t('webmenu.view'),
    items: [
      { label: t('webmenu.togglePreview'), action: 'view.togglePreview', disabled: !inEditor.value },
      { label: t('webmenu.toggleGrid'), action: 'view.toggleGrid', disabled: !inEditor.value },
    ],
  },
  {
    id: 'window', label: t('webmenu.window'),
    items: [
      { label: t('webmenu.winClaude'), action: 'window.claude', disabled: !inEditor.value },
      { label: t('webmenu.winResources'), action: 'window.resources', disabled: !inEditor.value },
      { label: t('webmenu.winSite'), action: 'window.site', disabled: !inEditor.value },
      { label: t('webmenu.winTheme'), action: 'window.theme', disabled: !inEditor.value },
    ],
  },
  {
    // Top-level "Language" so the user does not have to drill into Window→Idioma
    // (as in the native menu) for what is a frequent toggle on the web.
    id: 'language', label: t('webmenu.language'),
    items: [
      { label: t('locale.es'), checked: currentLocale() === 'es', onClick: () => setLocale('es') },
      { label: t('locale.en'), checked: currentLocale() === 'en', onClick: () => setLocale('en') },
    ],
  },
  {
    id: 'help', label: t('webmenu.help'),
    items: [
      { label: t('webmenu.helpGuide'), action: 'help.guide' },
      { label: t('webmenu.helpDownloads'), action: 'help.downloads' },
    ],
  },
])

// Which menu is open (by id); null = none.
const openId = ref<string | null>(null)
const rootRef = ref<HTMLElement | null>(null)

function toggle(id: string) { openId.value = openId.value === id ? null : id }
function close() { openId.value = null }

function pick(item: Item) {
  if (item.disabled) return
  if (item.onClick) item.onClick()
  else if (item.action) emitMenu(item.action)
  close()
}

function onDocPointerDown(e: PointerEvent) {
  if (!openId.value) return
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) close()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && openId.value) close()
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})

// Re-export for typing in the template.
const _Locale: Locale = 'es'
void _Locale
</script>

<template>
  <div class="webmenu" ref="rootRef" data-test="webmenu">
    <button
      v-for="m in menus"
      :key="m.id"
      type="button"
      class="webmenu-trigger"
      :class="{ open: openId === m.id }"
      :data-test="`webmenu-${m.id}`"
      @click="toggle(m.id)"
    >{{ m.label }}</button>

    <div
      v-for="m in menus"
      v-show="openId === m.id"
      :key="`pop-${m.id}`"
      class="webmenu-pop"
      :data-test="`webmenu-pop-${m.id}`"
    >
      <template v-for="(it, i) in m.items">
        <div v-if="it.separator" :key="`s-${m.id}-${i}`" class="webmenu-sep" />
        <button
          v-else
          :key="`i-${m.id}-${i}`"
          type="button"
          class="webmenu-item"
          :class="{ checked: it.checked, disabled: it.disabled }"
          :disabled="it.disabled"
          @click="pick(it)"
        >
          <span class="webmenu-check">{{ it.checked ? '✓' : '' }}</span>
          <span class="webmenu-label">{{ it.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.webmenu {
  position: sticky;
  top: 0;
  z-index: 100001;
  background: #1c1c1c;
  border-bottom: 1px solid #333;
  display: flex;
  align-items: stretch;
  height: 28px;
  font-size: 12px;
  color: #ddd;
  user-select: none;
}
.webmenu-trigger {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  height: 100%;
}
.webmenu-trigger:hover, .webmenu-trigger.open {
  background: #2d2d2d;
  color: #fff;
}
/* Popovers anchored to the menubar; absolute positioning relative to
   .webmenu (the root). Top-aligned to the bottom of the bar (28px). The
   bar itself sits above the canvas chrome via z-index:100001, so its
   popovers (z-index inside this stacking context) paint over everything
   below — SelectionOverlay (10000) included. */
.webmenu-pop {
  position: absolute;
  top: 28px;
  left: 0; /* horizontal alignment is handled by the trigger's flex position;
              we pick the simplest: each pop starts left-aligned to the bar
              and items use min-width so the pop reads without flowing too
              wide. The trigger order is stable so users learn the columns. */
  min-width: 220px;
  background: #2b2b2b;
  border: 1px solid #444;
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.45);
  display: flex;
  flex-direction: column;
}
/* Anchor each pop under its trigger using a CSS variable per-menu. Since the
   triggers' x positions vary, we let the pop start at left:0 and the user
   sees the column open from the leftmost edge of the bar. Acceptable for a
   web-only utility menu; the columns are not very wide. */
.webmenu-item {
  background: transparent;
  border: none;
  color: #ddd;
  font: inherit;
  text-align: left;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.webmenu-item:hover:not(.disabled) { background: var(--accent, #3a3a3a); color: var(--accent-fg, #fff); }
.webmenu-item.disabled { color: #666; cursor: not-allowed; }
.webmenu-item.checked { color: #fff; }
.webmenu-check { width: 12px; text-align: center; color: var(--accent-strong, #b06bff); }
.webmenu-label { flex: 1; }
.webmenu-sep { height: 1px; background: #444; margin: 4px 0; }
</style>
