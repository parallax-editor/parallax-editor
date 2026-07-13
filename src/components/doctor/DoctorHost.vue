<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { diagnosticsApi, type Diagnostics, type SecretsBackend } from '../../composables/useApi'
import { useElectron } from '../../composables/useElectron'
import { useSecrets } from '../../composables/useSecrets'
import { activeWorkspace } from '../../stores/workspaces'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

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
const secrets = useSecrets()
const open = ref(false)
const loading = ref(false)
const diag = ref<Diagnostics | null>(null)
const showDetails = ref(false)
const autoStart = ref(false)
// Backend del SecretsBus: 'safeStorage' (Keychain), 'session' (efímero), null
// (no hay forma de cifrar — secretos no disponibles). Lo resolvemos al cargar
// la pantalla para que el badge sea consistente con el estado real.
const secretsBackend = ref<SecretsBackend>(null)
let disposeMenu: (() => void) | null = null

const gitOk = computed(() => !!diag.value?.git?.configured)
const claudeOk = computed(() => !!diag.value?.claude?.available)
const awsOk = computed(() => !!diag.value?.aws?.configured)
// Git auth detection (Fase 4): solo aplica si git CLI está OK Y el workspace
// activo usa git. Si no hay helper ni SSH key Y el workspace está en
// authMode:'system', el push va a colgar pidiendo password — warning.
const gitAuthAvail = computed(() => !!diag.value?.gitAuth?.available)
const gitAuthHelper = computed(() => diag.value?.gitAuth?.credentialHelper || null)
const gitAuthHasSsh = computed(() => !!diag.value?.gitAuth?.hasSshKey)
const showGitAuthWarning = computed(() => {
  if (!gitOk.value) return false
  const ws = activeWorkspace.value
  if (!ws || ws.useGit === false) return false
  if (ws.git?.authMode === 'pat') return false // ya tiene PAT — no advertimos
  return !gitAuthAvail.value
})
// Preset del workspace activo: solo se muestra cuando hay uno seleccionado.
// Default 'multi-tenant' por back-compat (workspaces existentes en localStorage
// que no traen preset). null cuando no hay workspace activo.
const activePreset = computed(() => {
  const ws = activeWorkspace.value
  if (!ws) return null
  return ws.preset || 'multi-tenant'
})
const presetExplain = computed(() => {
  if (activePreset.value === 'linked-home') return t('workspace.diagPresetLinkedHome')
  if (activePreset.value === 'multi-tenant') return t('workspace.diagPresetMultiTenant')
  return null
})
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
  // SecretsBus backend (best-effort; cualquier fallo deja null y la fila marca
  // "no disponible" — el usuario no pierde acceso al resto del diagnóstico).
  try {
    secretsBackend.value = await secrets.backend()
  } catch {
    secretsBackend.value = null
  }
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
    <div class="doctor" role="dialog" aria-modal="true" :aria-label="t('doctor.aria')" data-test="doctor">
      <header class="doctor-head">
        <h2>{{ t('doctor.heading') }}</h2>
        <p class="sub">{{ t('doctor.subtitle') }}</p>
      </header>

      <div v-if="loading && !diag" class="doctor-loading">{{ t('doctor.checkingEnv') }}</div>

      <div v-else class="checks">
        <!-- GIT (opcional: solo workspaces con git) -->
        <div class="check" :class="statusClass(gitOk, true)" data-test="doctor-git">
          <span class="dot" />
          <div class="body">
            <div class="title">{{ gitOk ? t('doctor.gitConfigured') : t('doctor.gitUnconfigured') }}</div>
            <div v-if="gitOk" class="detail">
              {{ diag?.git.name }} &lt;{{ diag?.git.email }}&gt;
            </div>
            <div v-else class="detail">
              {{ t('doctor.gitDetailUnconfigured') }}
              <code>git config --global user.name "Tu Nombre"</code>
              <code>git config --global user.email "tu@correo.com"</code>
            </div>
          </div>
        </div>

        <!-- CLAUDE -->
        <div class="check" :class="statusClass(claudeOk)" data-test="doctor-claude">
          <span class="dot" />
          <div class="body">
            <div class="title">{{ claudeOk ? t('doctor.claudeAvailable') : t('doctor.claudeNotFound') }}</div>
            <div v-if="claudeOk" class="detail">{{ t('doctor.claudeDetailOk') }}</div>
            <div v-else class="detail">
              {{ t('doctor.claudeDetailMissing', { code: 'claude' }) }}
            </div>
          </div>
        </div>

        <!-- AWS (opcional) -->
        <div class="check" :class="statusClass(awsOk, true)" data-test="doctor-aws">
          <span class="dot" />
          <div class="body">
            <div class="title">{{ awsOk ? t('doctor.awsConfigured') : t('doctor.awsUnconfigured') }}</div>
            <div v-if="awsOk" class="detail">{{ t('doctor.awsDetailOk', { source: diag?.aws.source }) }}</div>
            <div v-else class="detail">
              {{ t('doctor.awsDetailMissing') }} <strong>{{ t('doctor.awsPublishToS3') }}</strong>{{ t('doctor.awsCanUseWithout') }}
            </div>
          </div>
        </div>

        <!-- Git auth chain (Fase 4): solo aparece como warning cuando git CLI
             está OK pero no detectamos ni helper ni SSH key, Y el workspace
             activo usa git en modo 'system'. -->
        <div
          v-if="showGitAuthWarning"
          class="check warn"
          data-test="doctor-git-auth"
        >
          <span class="dot" />
          <div class="body">
            <div class="title">{{ t('workspace.doctorGitAuthMissingTitle') }}</div>
            <div class="detail">{{ t('workspace.doctorGitAuthMissingBody') }}</div>
          </div>
        </div>

        <!-- SecretsBus backend (Fase 2). safeStorage → ok; session → warn
             (los secretos no persisten entre reinicios); null → bad (no podemos
             cifrar nada → S3 y Git con creds explícitas no funcionarán). -->
        <div
          class="check"
          :class="secretsBackend === 'safeStorage' ? 'ok' : secretsBackend === 'session' ? 'warn' : 'bad'"
          data-test="doctor-secrets"
        >
          <span class="dot" />
          <div class="body">
            <div class="title">{{ t('doctor.secretsTitle') }}</div>
            <div v-if="secretsBackend === 'safeStorage'" class="detail">{{ t('doctor.secretsSafeStorage') }}</div>
            <div v-else-if="secretsBackend === 'session'" class="detail">{{ t('doctor.secretsSession') }}</div>
            <div v-else class="detail">{{ t('doctor.secretsUnavailable') }}</div>
          </div>
        </div>

        <!-- Preset del workspace activo (informativo) — solo aparece si hay un
             workspace seleccionado, para no confundir en el primer arranque. -->
        <div
          v-if="presetExplain"
          class="check ok"
          data-test="doctor-preset"
        >
          <span class="dot" />
          <div class="body">
            <div class="title">{{ t('workspace.diagPresetRow') }}: <code>{{ activePreset }}</code></div>
            <div class="detail">{{ presetExplain }}</div>
          </div>
        </div>
      </div>

      <!-- Auto-inicio (solo en la app de escritorio) -->
      <label v-if="electron.isElectron" class="autostart">
        <input type="checkbox" :checked="autoStart" @change="toggleAutoStart" />
        {{ t('doctor.autoStart') }}
      </label>

      <!-- Detalles técnicos -->
      <button class="details-toggle" type="button" @click="showDetails = !showDetails">
        {{ showDetails ? '▾' : '▸' }} {{ t('doctor.technicalDetails') }}
      </button>
      <pre v-if="showDetails && diag" class="details">git:    {{ diag.bins.git || t('doctor.detailsGitNotFound') }}
claude: {{ diag.bins.claude || t('doctor.detailsClaudeNotFound') }}
aws:    {{ t('doctor.detailsAws') }}
runtime: {{ t('doctor.detailsRuntime') }}</pre>

      <footer class="doctor-foot">
        <button type="button" class="btn ghost" :disabled="loading" @click="load" data-test="doctor-retry">
          {{ loading ? t('doctor.retrying') : t('doctor.retry') }}
        </button>
        <button
          type="button"
          class="btn primary"
          @click="dismiss"
          data-test="doctor-continue"
        >
          {{ t('doctor.understood') }}
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
