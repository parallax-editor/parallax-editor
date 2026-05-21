<script setup lang="ts">
/**
 * DialogHost — host global de los diálogos del editor. Se monta UNA vez en el
 * root (App.vue) y renderiza el diálogo activo de `useDialog` con Teleport a
 * <body>, backdrop oscuro y z-index muy alto (sobre toolbar/paneles/otros
 * modales). Reemplaza window.confirm / alert / prompt nativos.
 *
 * UX: confirmar enfocado por defecto (prompt → el input); Enter confirma,
 * Esc cancela (resuelve false/null), click en backdrop cancela, foco atrapado
 * dentro del diálogo. Accesible: role="dialog", aria-modal, aria-labelledby.
 */
import { ref, computed, watch, nextTick } from 'vue'
import { dialogState, resolveDialog } from '../../composables/useDialog'

const cur = computed(() => dialogState.current)

// Valor del input para prompt.
const inputValue = ref('')
// Refs para foco.
const promptInput = ref<HTMLInputElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)

const titleId = computed(() => (cur.value ? `dialog-title-${cur.value.id}` : undefined))

// Cada vez que cambia el diálogo activo: resetear input y enfocar.
watch(
  cur,
  (d) => {
    if (!d) return
    inputValue.value = d.kind === 'prompt' ? d.defaultValue : ''
    nextTick(() => {
      if (d.kind === 'prompt') {
        promptInput.value?.focus()
        promptInput.value?.select()
      } else {
        confirmBtn.value?.focus()
      }
    })
  },
  { immediate: true },
)

function onConfirm() {
  const d = cur.value
  if (!d) return
  if (d.kind === 'prompt') resolveDialog(inputValue.value)
  else resolveDialog(true)
}

function onCancel() {
  const d = cur.value
  if (!d) return
  // alert se cierra resolviendo void; confirm → false; prompt → null.
  if (d.kind === 'confirm') resolveDialog(false)
  else if (d.kind === 'prompt') resolveDialog(null)
  else resolveDialog()
}

function onBackdrop() {
  onCancel()
}

// Teclado a nivel del diálogo: Esc cancela; Enter confirma (incluido el input
// del prompt vía @keydown.enter). Tab queda atrapado dentro del diálogo.
function onKeydown(e: KeyboardEvent) {
  if (!cur.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    onCancel()
    return
  }
  if (e.key === 'Tab') {
    trapTab(e)
  }
}

function trapTab(e: KeyboardEvent) {
  const root = dialogEl.value
  if (!root) return
  const focusables = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault()
      last.focus()
    }
  } else {
    if (active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="cur"
      class="dlg-backdrop"
      data-test="dialog-backdrop"
      @click.self="onBackdrop"
      @keydown="onKeydown"
    >
      <div
        ref="dialogEl"
        class="dlg"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-label="cur.title ? undefined : cur.message"
        data-test="dialog"
      >
        <header v-if="cur.title" class="dlg-head">
          <h3 :id="titleId">{{ cur.title }}</h3>
        </header>
        <div class="dlg-body">
          <p class="dlg-message">{{ cur.message }}</p>
          <input
            v-if="cur.kind === 'prompt'"
            ref="promptInput"
            v-model="inputValue"
            class="dlg-input"
            type="text"
            data-test="dialog-input"
            :placeholder="cur.placeholder"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="onConfirm"
          />
        </div>
        <div class="dlg-actions">
          <button
            v-if="cur.kind !== 'alert'"
            type="button"
            class="dlg-btn"
            data-test="dialog-cancel"
            @click="onCancel"
          >
            {{ cur.cancelText }}
          </button>
          <button
            v-if="cur.kind === 'alert'"
            ref="confirmBtn"
            type="button"
            class="dlg-btn primary"
            data-test="dialog-ok"
            @click="onConfirm"
          >
            {{ cur.okText }}
          </button>
          <button
            v-else
            ref="confirmBtn"
            type="button"
            class="dlg-btn"
            :class="cur.danger ? 'danger' : 'primary'"
            data-test="dialog-confirm"
            @click="onConfirm"
          >
            {{ cur.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Por encima de toolbar/paneles y de los .create-backdrop de ProjectSelector
   (z-index 100001). */
.dlg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100100;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: dlg-fade 0.12s ease-out;
}
.dlg {
  width: min(440px, 92vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: #252525;
  border: 1px solid #3a3a3a;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  animation: dlg-pop 0.14s ease-out;
}
.dlg-head { flex: 0 0 auto; padding: 18px 24px 0; }
.dlg-head h3 { margin: 0; font-size: 16px; font-weight: 700; color: #f0f0f0; }
.dlg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 24px 4px; }
.dlg-message { margin: 0; font-size: 14px; line-height: 1.55; color: #d6d6d6; white-space: pre-wrap; }
.dlg-input {
  width: 100%;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid #555;
  border-radius: 6px;
  background: #1a1a1a;
  color: #e0e0e0;
  font-size: 14px;
  box-sizing: border-box;
}
.dlg-input:focus { outline: none; border-color: var(--accent-strong); }
.dlg-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 16px 24px; margin-top: 8px; }
.dlg-btn {
  padding: 8px 16px;
  border: 1px solid #555;
  border-radius: 6px;
  background: #333;
  color: #e0e0e0;
  cursor: pointer;
  font-size: 14px;
}
.dlg-btn:hover { background: #3c3c3c; }
.dlg-btn:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
.dlg-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); transition: background 0.12s ease; }
.dlg-btn.primary:hover { background: var(--accent-hover); }
.dlg-btn.danger { background: #b02525; border-color: #b02525; color: #fff; transition: background 0.12s ease; }
.dlg-btn.danger:hover { background: #c93030; }

@keyframes dlg-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dlg-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
