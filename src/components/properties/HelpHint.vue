<script setup lang="ts">
import { ref, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps<{ text: string; label?: string }>()

const open = ref(false)
const btnRef = ref<HTMLButtonElement | null>(null)

// Popover is rendered to <body> via <Teleport> with position:fixed so it is
// never clipped by an ancestor's overflow (the scrollable .panel-body). These
// reactive coordinates are computed from the "?" button rect.
const POP_W = 260
const popStyle = ref<Record<string, string>>({})

function reposition() {
  const btn = btnRef.value
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const margin = 8
  const vw = window.innerWidth
  const vh = window.innerHeight

  // Prefer placing the popover to the LEFT of the button (panel is on the
  // right edge of the screen); flip to the right if there isn't room.
  let left = r.left - margin - POP_W
  let arrow: 'right' | 'left' = 'right'
  if (left < margin) {
    left = r.right + margin
    arrow = 'left'
  }
  left = Math.max(margin, Math.min(left, vw - POP_W - margin))

  // Vertically center on the button, clamped into the viewport.
  let top = r.top + r.height / 2
  top = Math.max(margin + 14, Math.min(top, vh - margin - 14))

  popStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    transform: 'translateY(-50%)',
    width: `${POP_W}px`,
    maxWidth: `${POP_W}px`,
    // expose arrow side for the ::after via a data attr instead of CSS var
  }
  arrowSide.value = arrow
}

const arrowSide = ref<'left' | 'right'>('right')

function toggle() {
  open.value = !open.value
  if (open.value) {
    nextTick(() => {
      reposition()
      // Close on next outside click / Escape; reposition on scroll/resize.
      requestAnimationFrame(() => {
        document.addEventListener('click', onOutside, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', onScrollResize, true)
        window.addEventListener('resize', onScrollResize, true)
      })
    })
  } else {
    detach()
  }
}

function close() {
  open.value = false
  detach()
}

function onOutside(e: MouseEvent) {
  if (btnRef.value && btnRef.value.contains(e.target as Node)) return
  // Allow clicks inside the popover itself (so text is selectable).
  const pop = (e.target as HTMLElement)?.closest?.('.help-pop')
  if (pop) return
  close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

// Reposition while it stays open; if the button scrolls out of view, hide.
function onScrollResize() {
  if (!open.value) return
  const btn = btnRef.value
  if (!btn) return
  const r = btn.getBoundingClientRect()
  if (r.bottom < 0 || r.top > window.innerHeight) {
    close()
    return
  }
  reposition()
}

function detach() {
  document.removeEventListener('click', onOutside, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('scroll', onScrollResize, true)
  window.removeEventListener('resize', onScrollResize, true)
}

onBeforeUnmount(detach)
</script>

<template>
  <span class="help-hint">
    <button
      ref="btnRef"
      type="button"
      class="help-btn"
      data-test="help-hint-btn"
      :aria-label="props.label ? `Ayuda: ${props.label}` : 'Ayuda'"
      :aria-expanded="open"
      @click.stop="toggle"
    >?</button>
    <Teleport to="body">
      <span
        v-if="open"
        class="help-pop"
        :class="`arrow-${arrowSide}`"
        role="tooltip"
        data-test="help-hint-pop"
        :style="popStyle"
        @click.stop
      >{{ props.text }}</span>
    </Teleport>
  </span>
</template>

<style scoped>
.help-hint { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; }
.help-btn {
  width: 15px; height: 15px; border-radius: 50%;
  background: #2f2f2f; border: 1px solid #4a4a4a; color: #9a9a9a;
  font-size: 10px; line-height: 1; font-weight: 700;
  cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center;
}
.help-btn:hover { background: #0066cc; border-color: #0066cc; color: #fff; }
.help-btn:focus-visible { outline: 2px solid #0099ff; outline-offset: 1px; }
</style>

<style>
/* Unscoped: the popover is teleported to <body>, outside this component's
   scoped style scope. High z-index so it sits above panels & overlays. */
.help-pop {
  background: #0d0d0d; color: #e6e6e6;
  border: 1px solid #555; border-radius: 6px; padding: 8px 10px;
  font-size: 11px; line-height: 1.4; font-weight: 400;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.6); z-index: 100000;
  text-transform: none; letter-spacing: 0; white-space: normal; text-align: left;
}
.help-pop::after {
  content: ''; position: absolute; top: 50%; transform: translateY(-50%);
  border: 5px solid transparent;
}
.help-pop.arrow-right::after { left: 100%; border-left-color: #555; }
.help-pop.arrow-left::after { right: 100%; border-right-color: #555; }
</style>
