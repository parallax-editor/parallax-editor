import { state, VIEWPORTS } from '../stores/editor'

export function useCanvas() {
  const viewport = () => VIEWPORTS[state.deviceMode]

  function handleWheel(e: WheelEvent) {
    if (e.metaKey || e.ctrlKey) {
      // Zoom
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.05 : 0.05
      state.canvasZoom = Math.max(0.1, Math.min(3, state.canvasZoom + delta))
    } else if (state.tool === 'hand') {
      // Pan
      state.canvasPan.x -= e.deltaX
      state.canvasPan.y -= e.deltaY
    }
  }

  let isPanning = false
  let panStart = { x: 0, y: 0 }

  function handleMouseDown(e: MouseEvent) {
    if (state.tool === 'hand' || e.buttons === 4 || (e.buttons === 1 && e.altKey)) {
      isPanning = true
      panStart = { x: e.clientX - state.canvasPan.x, y: e.clientY - state.canvasPan.y }
    }
  }

  function handleMouseMove(e: MouseEvent) {
    if (isPanning) {
      state.canvasPan.x = e.clientX - panStart.x
      state.canvasPan.y = e.clientY - panStart.y
    }
  }

  function handleMouseUp() {
    isPanning = false
  }

  return { viewport, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp }
}
