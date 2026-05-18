import { ref, onMounted, onUnmounted } from 'vue'

export function useWebSocket(onMessage: (data: any) => void) {
  const connected = ref(false)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${location.host}/__ws`)

    ws.onopen = () => { connected.value = true }
    ws.onclose = () => {
      connected.value = false
      reconnectTimer = setTimeout(connect, 2000)
    }
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data))
      } catch {}
    }
  }

  onMounted(connect)

  onUnmounted(() => {
    ws?.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  return { connected }
}
