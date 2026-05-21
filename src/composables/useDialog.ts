/**
 * useDialog — reemplaza los diálogos NATIVOS del navegador
 * (window.confirm / alert / prompt) por un MODAL propio acorde al diseño del
 * editor (oscuro, como los `.create-dialog` de ProjectSelector).
 *
 * Los nativos son SÍNCRONOS (bloquean el hilo); estos son ASÍNCRONOS y
 * devuelven Promesas, así que los call sites pasan a `await dialog.confirm(...)`.
 *
 * Una sola instancia compartida (estado a nivel de módulo) alimenta el
 * <DialogHost> montado una vez en el root. Soporta una COLA simple: si se piden
 * varios diálogos seguidos se muestran uno a uno en orden.
 */
import { reactive, readonly } from 'vue'

export type DialogKind = 'confirm' | 'alert' | 'prompt'

export interface DialogRequest {
  id: number
  kind: DialogKind
  title?: string
  message: string
  // confirm / prompt
  confirmText: string
  cancelText: string
  danger: boolean
  // alert
  okText: string
  // prompt
  defaultValue: string
  placeholder?: string
  // resolución interna
  resolve: (value: boolean | string | null | void) => void
}

interface DialogState {
  current: DialogRequest | null
}

const state = reactive<DialogState>({ current: null })
const queue: DialogRequest[] = []
let seq = 0

function pump() {
  if (state.current || queue.length === 0) return
  state.current = queue.shift() || null
}

function enqueue(req: DialogRequest) {
  queue.push(req)
  pump()
}

// El host llama a esto cuando el usuario resuelve el diálogo activo.
function settle(value: boolean | string | null | void) {
  const cur = state.current
  if (!cur) return
  state.current = null
  cur.resolve(value)
  // Mostrar el siguiente en cola (si lo hay) en el próximo tick reactivo.
  pump()
}

export interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export interface AlertOptions {
  title?: string
  message: string
  okText?: string
}

export interface PromptOptions {
  title?: string
  message: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
}

function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue({
      id: ++seq,
      kind: 'confirm',
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText ?? 'Aceptar',
      cancelText: opts.cancelText ?? 'Cancelar',
      danger: !!opts.danger,
      okText: 'Entendido',
      defaultValue: '',
      placeholder: undefined,
      resolve: (v) => resolve(!!v),
    })
  })
}

function alert(opts: AlertOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueue({
      id: ++seq,
      kind: 'alert',
      title: opts.title,
      message: opts.message,
      confirmText: 'Aceptar',
      cancelText: 'Cancelar',
      danger: false,
      okText: opts.okText ?? 'Entendido',
      defaultValue: '',
      placeholder: undefined,
      resolve: () => resolve(),
    })
  })
}

function prompt(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    enqueue({
      id: ++seq,
      kind: 'prompt',
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText ?? 'Aceptar',
      cancelText: opts.cancelText ?? 'Cancelar',
      danger: false,
      okText: 'Entendido',
      defaultValue: opts.defaultValue ?? '',
      placeholder: opts.placeholder,
      resolve: (v) => resolve(typeof v === 'string' ? v : null),
    })
  })
}

const dialog = { confirm, alert, prompt }

export function useDialog() {
  return dialog
}

// Para el <DialogHost>: estado de solo-lectura + el resolvedor.
export const dialogState = readonly(state)
export function resolveDialog(value: boolean | string | null | void) {
  settle(value)
}
