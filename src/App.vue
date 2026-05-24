<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import DialogHost from './components/ui/DialogHost.vue'
import DoctorHost from './components/doctor/DoctorHost.vue'
import { useElectron } from './composables/useElectron'
import { emitMenu, onMenu } from './composables/useMenu'
import { useDialog } from './composables/useDialog'
import { APP_VERSION } from './version'

const router = useRouter()
const electron = useElectron()
const dialog = useDialog()
const LANDING = 'http://parallax-engine.s3-website-us-east-1.amazonaws.com'

let disposeIpc: (() => void) | null = null
let disposeBus: (() => void) | null = null

onMounted(() => {
  // IPC del menú nativo → bus interno (las vistas se suscriben con onMenu).
  disposeIpc = electron.onMenuAction((action) => emitMenu(action))

  // Acciones GLOBALES (válidas en cualquier vista): navegación + ayuda + update.
  disposeBus = onMenu(async (action) => {
    if (action === 'file.new' || action === 'file.open') {
      router.push('/')
    } else if (action === 'help.downloads') {
      window.open(LANDING, '_blank')
    } else if (action === 'help.guide') {
      window.open(`${LANDING}/editor.html`, '_blank')
    } else if (action === 'app.checkUpdates') {
      try {
        const list = await fetch(`${LANDING}/versions.json`).then((r) => r.json())
        const latest = Array.isArray(list) && list[0]?.version
        if (latest && latest !== APP_VERSION) {
          await dialog.alert({
            title: 'Actualización disponible',
            message: `Hay una versión nueva (v${latest}). Tienes la v${APP_VERSION}. Descárgala en:\n${LANDING}`,
          })
        } else {
          await dialog.alert({
            title: 'Estás al día',
            message: `Tienes la última versión (v${APP_VERSION}).`,
          })
        }
      } catch {
        await dialog.alert({
          title: 'Sin conexión',
          message: 'No se pudo verificar la versión más reciente.',
        })
      }
    }
  })
})

onBeforeUnmount(() => {
  disposeIpc?.()
  disposeBus?.()
})
</script>

<template>
  <router-view />
  <!-- Host global de diálogos (confirm/alert/prompt propios). Montado una vez. -->
  <DialogHost />
  <!-- Pantalla doctor (primer arranque / menú Ayuda). Montada una vez. -->
  <DoctorHost />
</template>
