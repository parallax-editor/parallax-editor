<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import DialogHost from './components/ui/DialogHost.vue'
import DoctorHost from './components/doctor/DoctorHost.vue'
import WebMenu from './components/ui/WebMenu.vue'
import { useElectron } from './composables/useElectron'
import { emitMenu, onMenu } from './composables/useMenu'
import { useDialog } from './composables/useDialog'
import { activeWorkspace } from './stores/workspaces'
import { undo as storeUndo, redo as storeRedo } from './stores/editor'
import { APP_VERSION } from './version'

const router = useRouter()
const electron = useElectron()
const dialog = useDialog()
const { t } = useI18n()
// Landing PÚBLICO (GitHub Pages) — lo que abren "Descargas" y "Guía" del menú.
// El chequeo de versiones sigue leyendo del S3 de releases: `versions.json` lo
// genera `yarn release` junto a los .dmg y NO existe en Pages (solo publica
// `landing/`). Son dos superficies distintas a propósito.
const LANDING = 'https://parallax-editor.github.io/parallax-editor'
const UPDATES_BASE = 'http://parallax-engine.s3-website-us-east-1.amazonaws.com'

let disposeIpc: (() => void) | null = null
let disposeBus: (() => void) | null = null

onMounted(() => {
  // IPC del menú nativo → bus interno (las vistas se suscriben con onMenu).
  disposeIpc = electron.onMenuAction((action) => emitMenu(action))

  // Acciones GLOBALES (válidas en cualquier vista): navegación + ayuda + update.
  disposeBus = onMenu(async (action) => {
    if (action === 'edit.undo') { storeUndo(); return }
    if (action === 'edit.redo') { storeRedo(); return }
    if (action === 'file.new' || action === 'file.open') {
      router.push('/')
    } else if (action === 'window.workspaceSettings') {
      // Ventana → Configurar workspace. Preferimos el activo; si no hay
      // (arranque en la pestaña de LivePreview, por ejemplo), volvemos al
      // selector para que elija uno. Nunca navegamos a un id vacío que
      // rompería la vista.
      const active = activeWorkspace.value
      if (active) router.push(`/workspace/${active.id}/settings`)
      else router.push('/')
    } else if (action === 'help.downloads') {
      window.open(LANDING, '_blank')
    } else if (action === 'help.guide') {
      window.open(`${LANDING}/editor.html`, '_blank')
    } else if (action === 'app.checkUpdates') {
      try {
        const list = await fetch(`${UPDATES_BASE}/versions.json`).then((r) => r.json())
        const latest = Array.isArray(list) && list[0]?.version
        if (latest && latest !== APP_VERSION) {
          await dialog.alert({
            title: t('updates.availableTitle'),
            message: t('updates.availableMsg', { latest, current: APP_VERSION, url: LANDING }),
          })
        } else {
          await dialog.alert({
            title: t('updates.upToDateTitle'),
            message: t('updates.upToDateMsg', { current: APP_VERSION }),
          })
        }
      } catch {
        await dialog.alert({
          title: t('updates.offlineTitle'),
          message: t('updates.offlineMsg'),
        })
      }
    }
  })
})

// Reporta al menú nativo las capacidades del workspace ACTIVO (useGit / hasS3)
// para habilitar/deshabilitar Git y Publicar. Inmediato + en cada cambio de
// workspace (o de su config S3/git). En web es no-op.
//
// IMPORTANTE: solo reportamos cuando HAY un workspace cargado. Si `ws` es null
// (arranque antes de cargar workspaces, o la pestaña de "Vista en vivo" que es un
// contexto separado y nunca carga la lista) NO reportamos → el menú conserva su
// último estado real (o el default habilitado) en vez de quedar deshabilitado a
// la fuerza. Antes esto apagaba Git/Publicar aunque el workspace sí los tuviera.
// `inEditor` = estamos en la ruta /edit (un sitio abierto). En el home/selector
// los menús de Edición/Elemento/Git/Publicar/Ver/Ventana + Guardar/Importar se
// deshabilitan (no tienen sentido sin un sitio). Reportamos al cambiar de
// workspace O de ruta. (La pestaña de Vista en vivo tiene ws=null → no reporta,
// así no pisa el estado de la ventana principal.)
watch(
  [activeWorkspace, () => router.currentRoute.value.path],
  ([ws, path]) => {
    if (!ws) return
    electron.setWorkspaceCapabilities({
      useGit: (ws as any).useGit !== false,
      hasS3: !!(ws as any).s3?.enabled,
      inEditor: typeof path === 'string' && path.startsWith('/edit'),
    })
  },
  { immediate: true, deep: true },
)

onBeforeUnmount(() => {
  disposeIpc?.()
  disposeBus?.()
})
</script>

<template>
  <!-- Web-only top menu: replaces the native Electron menu bar on the
       browser version. Hidden inside the Electron app, which has its own. -->
  <WebMenu v-if="!electron.isElectron" />
  <router-view />
  <!-- Host global de diálogos (confirm/alert/prompt propios). Montado una vez. -->
  <DialogHost />
  <!-- Pantalla doctor (primer arranque / menú Ayuda). Montada una vez. -->
  <DoctorHost />
</template>
