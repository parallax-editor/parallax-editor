<script setup lang="ts">
import { computed } from 'vue'
import { state, getAtPath } from '../../stores/editor'

// Smart guides appear when the selected element aligns with others

const guides = computed(() => {
  if (!state.selectedPath || !state.site) return []
  const selected = getAtPath(state.selectedPath)
  if (!selected?.position) return []

  const lines: { type: 'h' | 'v'; pos: number }[] = []
  const sx = typeof selected.position.x === 'number' ? selected.position.x : -1
  const sy = typeof selected.position.y === 'number' ? selected.position.y : -1

  const threshold = 1 // percentage

  for (const section of state.site.sections) {
    for (const layer of section.layers) {
      for (const el of layer.elements) {
        if (el.id === selected.id) continue
        const ex = typeof el.position.x === 'number' ? el.position.x : -999
        const ey = typeof el.position.y === 'number' ? el.position.y : -999
        if (Math.abs(ex - sx) < threshold) lines.push({ type: 'v', pos: ex })
        if (Math.abs(ey - sy) < threshold) lines.push({ type: 'h', pos: ey })
      }
    }
  }

  return lines
})
</script>

<template>
  <svg v-if="guides.length > 0" class="smart-guides" xmlns="http://www.w3.org/2000/svg">
    <line
      v-for="(g, i) in guides"
      :key="i"
      :x1="g.type === 'v' ? `${g.pos}%` : '0'"
      :y1="g.type === 'h' ? `${g.pos}%` : '0'"
      :x2="g.type === 'v' ? `${g.pos}%` : '100%'"
      :y2="g.type === 'h' ? `${g.pos}%` : '100%'"
      stroke="#ff00ff"
      stroke-width="1"
      stroke-dasharray="4,4"
      opacity="0.6"
    />
  </svg>
</template>

<style scoped>
.smart-guides { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9999; }
</style>
