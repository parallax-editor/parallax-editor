<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { diagnosticsApi, type Diagnostics } from '../../composables/useApi'
import { useElectron } from '../../composables/useElectron'

/**
 * Pantalla "doctor" (FASE 4). Verifica el entorno de la máquina del usuario:
 *   • git configurado (necesario para guardar/publicar)
 *   • CLI `claude` disponible (botón "Hablar con Claude")
 *   • credenciales AWS (OPCIONAL: solo si el sitio publica a S3)
 *
 * Se muestra sola en el PRIMER arranque y cuando git no está configurado
 * (bloqueante). Siempre accesible desde el menú nativo "Ayuda → Diagnóstico".
 * Montada una vez en App.vue, junto a DialogHost.
 */
const ONBOARDED_KEY = 'parallax-editor:onboarded'

const electron = useElectron()
const open = ref(false)
const loading = ref(false)
const diag = ref<Diagnostics | null>(null)
const showDetails = ref(false)
const autoStart = ref(false)
let disposeMenu: (() => void) | null = null

const gitOk = computed(() => !!diag.value?.git?.configured)
const claudeOk = computed(() => !!diag.value?.claude?.available)
const awsOk = computed(() => !!diag.value?.aws?.configured)
// Nada bloquea: git, claude y aws son OPCIONALES (workspaces solo-disco/S3 no
// necesitan git; el editor funciona sin Claude/AWS). El doctor SIEMPRE se cierra.

async function load() {
  loading.value = true
  try {
    diag.value = await diagnosticsApi.get()
  } catch {
    diag.value = null
  } finally {
    loading.value = false
  }
  if (electron.isElectron) autoStart.value = await electron.getAutoStart()
}

async function show() {
  open.value = true
  await load()
}

function dismiss() {
  open.value = false
  try { localStorage.setItem(ONBOARDED_KEY, '1') } catch { /* private mode */ }
}

async function toggleAutoStart() {
  const next = !autoStart.value
  autoStart.value = await electron.setAutoStart(next)
}

onMounted(async () => {
  // Menú nativo "Ayuda → Diagnóstico".
  disposeMenu = electron.onOpenDoctor(() => { show() })

  // Auto-mostrar SOLO en el primer arranque. git/claude/aws son opcionales, así
  // que NO se fuerza la pantalla en arranques posteriores aunque falte alguno —
  // siempre queda accesible desde el menú "Ayuda → Diagnóstico".
  let onboarded = false
  try { onboarded = localStorage.getItem(ONBOARDED_KEY) === '1' } catch { /* noop */ }
  if (!onboarded) await show()
})

onBeforeUnmount(() => { if (disposeMenu) disposeMenu() })

function statusClass(ok: boolean, optional = false) {
  if (ok) return 'ok'
  return optional ? 'warn' : 'bad'
}
</script>

<template>
  <div v-if="open" class="doctor-backdrop" @click.self="dismiss()">
    <div class="doctor" role="dialog" aria-modal="true" aria-label="Diagnóstico del editor" data-test="doctor">
      <header class="doctor-head">
        <h2>Diagnóstico del editor</h2>
        <p class="sub">Revisamos que tu Mac tenga todo listo para crear y publicar sitios.</p>
      </header>

      <div v-if="loading && !diag" class="doctor-loading">Revisando entorno…</div>

      <div v-else class="checks">
        <!-- GIT (opcional: solo workspaces con git) -->
        <div class="check" :class="statusClass(gitOk, true)" data-test="doctor-git">
          <span class="dot" />
          <div class="body">
            <div class="title">Git {{ gitOk ? 'configurado' : 'sin configurar (opcional)' }}</div>
            <div v-if="gitOk" class="detail">
              {{ diag?.git.name }} &lt;{{ diag?.git.email }}&gt;
            </div>
            <div v-else class="detail">
              Solo necesario para workspaces con control de versiones. Los
              workspaces solo en disco o con S3 no lo necesitan. Si lo quieres:
              <code>git config --global user.name "Tu Nombre"</code>
              <code>git config --global user.email "tu@correo.com"</code>
            </div>
          </div>
        </div>

        <!-- CLAUDE -->
        <div class="check" :class="statusClass(claudeOk)" data-test="doctor-claude">
          <span class="dot" />
          <div class="body">
            <div class="title">Claude {{ claudeOk ? 'disponible' : 'no encontrado' }}</div>
            <div v-if="claudeOk" class="detail">El asistente "Hablar con Claude" está listo.</div>
            <div v-else class="detail">
              Sin el CLI <code>claude</code> el asistente no funciona. Instálalo y vuelve a abrir la app.
            </div>
          </div>
        </div>

        <!-- AWS (opcional) -->
        <div class="check" :class="statusClass(awsOk, true)" data-test="doctor-aws">
          <span class="dot" />
          <div class="body">
            <div class="title">AWS {{ awsOk ? 'configurado' : 'sin credenciales (opcional)' }}</div>
            <div v-if="awsOk" class="detail">Credenciales desde {{ diag?.aws.source }}. Podrás publicar a S3.</div>
            <div v-else class="detail">
              Solo necesario si vas a <strong>publicar a S3</strong>. Puedes usar el editor sin esto.
            </div>
          </div>
        </div>
      </div>

      <!-- Auto-inicio (solo en la app de escritorio) -->
      <label v-if="electron.isElectron" class="autostart">
        <input type="checkbox" :checked="autoStart" @change="toggleAutoStart" />
        Abrir el editor automáticamente al encender la Mac
      </label>

      <!-- Detalles técnicos -->
      <button class="details-toggle" type="button" @click="showDetails = !showDetails">
        {{ showDetails ? '▾' : '▸' }} Detalles técnicos
      </button>
      <pre v-if="showDetails && diag" class="details">git:    {{ diag.bins.git || '(no encontrado — opcional)' }}
claude: {{ diag.bins.claude || '(no encontrado en PATH)' }}
aws:    SDK JS (lee ~/.aws o variables de entorno; no usa CLI)
runtime: incluido en la app (no necesitas instalar Node)</pre>

      <footer class="doctor-foot">
        <button type="button" class="btn ghost" :disabled="loading" @click="load" data-test="doctor-retry">
          {{ loading ? 'Revisando…' : 'Reintentar' }}
        </button>
        <button
          type="button"
          class="btn primary"
          @click="dismiss"
          data-test="doctor-continue"
        >
          Entendido
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.doctor-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100050;
  padding: 24px;
}
.doctor {
  width: min(560px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 14px;
  padding: 24px;
  color: #ececec;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.doctor-head h2 { margin: 0 0 4px; font-size: 18px; }
.doctor-head .sub { margin: 0 0 18px; font-size: 13px; color: #9a9a9a; }
.doctor-loading { padding: 24px 0; color: #9a9a9a; }

.checks { display: flex; flex-direction: column; gap: 10px; }
.check {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  background: #232323;
  border: 1px solid #2e2e2e;
  border-radius: 10px;
}
.check .dot {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-top: 3px;
  background: #6b7280;
}
.check.ok .dot { background: #34d399; }
.check.warn .dot { background: #fbbf24; }
.check.bad .dot { background: #f87171; }
.check.bad { border-color: #5a2a2a; }
.check .title { font-weight: 600; font-size: 14px; }
.check .detail { font-size: 12.5px; color: #a8a8a8; margin-top: 3px; line-height: 1.5; }
.check .detail code {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: #7fa8d6;
  background: #1a1a1a;
  border: 1px solid #2c2c2c;
  border-radius: 5px;
  padding: 1px 6px;
  margin-top: 4px;
}

.autostart {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  font-size: 13px;
  color: #cfcfcf;
  cursor: pointer;
}

.details-toggle {
  margin-top: 16px;
  background: none;
  border: none;
  color: #8a8a8a;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.details {
  margin: 8px 0 0;
  padding: 10px 12px;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  font-size: 11.5px;
  color: #8fae8f;
  white-space: pre-wrap;
  word-break: break-all;
}

.doctor-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
}
.btn {
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.btn.ghost { background: #2e2e2e; border-color: #3a3a3a; color: #cfcfcf; }
.btn.ghost:hover { background: #3a3a3a; }
.btn.primary { background: #3b82f6; color: #fff; }
.btn.primary:hover { background: #2f6fe0; }
.btn.primary:disabled { background: #2a2a2a; color: #7a7a7a; cursor: not-allowed; }
</style>
