import { ref, onMounted, onUnmounted } from 'vue'

const WS_PATH = '/__ws'

export function useWebSocket(onMessage: (data: any) => void) {
  const connected = ref(false)
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`)

      ws.onopen = () => { connected.value = true }
      ws.onclose = () => {
        connected.value = false
        // Reconnect after delay, but don't spam
        reconnectTimer = setTimeout(connect, 5000)
      }
      ws.onerror = () => {
        // Silently fail — watcher is optional
        ws?.close()
      }
      ws.onmessage = (event) => {
        try {
          onMessage(JSON.parse(event.data))
        } catch {}
      }
    } catch {
      // WebSocket not available — watcher is optional
    }
  }

  onMounted(connect)

  onUnmounted(() => {
    ws?.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  return { connected }
}
