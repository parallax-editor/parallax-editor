<script setup lang="ts">
import { ref, computed, onBeforeUnmount, nextTick, watch } from 'vue'

// HelpHint renders the small "?" button + a teleported popover with help copy.
//
// The `text` prop may now contain LIGHT FORMATTING so non-technical help reads
// well (paragraphs, **bold**, bullet lists, and a "» cuándo usarlo" emphasis
// line). It is STILL just a string — every existing call site (plain text)
// keeps working unchanged. We render it with a tiny SAFE markdown-ish renderer:
// all HTML special chars are escaped FIRST (so any `<…>` becomes inert text),
// then we introduce only a closed allowlist of safe tags from the markup we
// authored. No untrusted HTML, no attributes — this is static authored copy.
const props = defineProps<{ text: string; label?: string }>()

const open = ref(false)
const btnRef = ref<HTMLButtonElement | null>(null)
const popRef = ref<HTMLElement | null>(null)

// Popover is rendered to <body> via <Teleport> with position:fixed so it is
// never clipped by an ancestor's overflow (the scrollable .panel-body). These
// reactive coordinates are computed from the "?" button rect.
const POP_W = 280
// Seed with the fixed width + an off-screen position so the FIRST render is
// already at the correct 280px width (the .help-pop CSS sets no width). That
// way the height we measure in reposition() reflects the real wrapped layout,
// and the popover never flashes at the wrong place/size before positioning.
const popStyle = ref<Record<string, string>>({
  position: 'fixed',
  left: '-9999px',
  top: '0px',
  width: `${POP_W}px`,
  maxWidth: `${POP_W}px`,
})

// ─── Tiny SAFE formatter for help copy ───────────────────────────────────────
// Escape FIRST so any literal markup the copy contains is neutralised, THEN
// add our own allowlisted tags. The only formatting we support is what help
// copy needs: paragraphs (blank-line separated), bullet lists (lines starting
// with "- " or "• "), inline **bold**, and a leading "» " on a line marks a
// "cuándo usarlo" emphasis paragraph.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(escaped: string): string {
  // **bold** (operate on already-escaped text → only adds <strong>).
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function renderHelp(src: string): string {
  if (!src) return ''
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let i = 0
  let para: string[] = []
  const flushPara = () => {
    if (!para.length) return
    html.push(`<p>${para.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`)
    para = []
  }
  let items: string[] = []
  const flushList = () => {
    if (!items.length) return
    html.push(`<ul>${items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('')}</ul>`)
    items = []
  }
  while (i < lines.length) {
    const line = lines[i]
    // Bullet list item: "- …" or "• …"
    const bullet = line.match(/^\s*[-•]\s+(.*)$/)
    if (bullet) {
      flushPara()
      items.push(bullet[1])
      i++
      continue
    }
    // "» …" → a highlighted "cuándo usarlo" line.
    const when = line.match(/^\s*»\s+(.*)$/)
    if (when) {
      flushPara()
      flushList()
      html.push(`<p class="hp-when"><span class="hp-when-tag">cuándo usarlo</span> ${renderInline(escapeHtml(when[1]))}</p>`)
      i++
      continue
    }
    // Blank line → paragraph / list boundary.
    if (/^\s*$/.test(line)) {
      flushPara()
      flushList()
      i++
      continue
    }
    flushList()
    para.push(line)
    i++
  }
  flushPara()
  flushList()
  return html.join('')
}

const renderedHtml = computed(() => renderHelp(props.text))

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

  // Vertically anchor on the button's center, then clamp the WHOLE box into
  // the viewport using the popover's measured height. Centering alone (the old
  // behaviour) only kept the center point on screen, so a tall popover (e.g.
  // the long blend/parallax/easing help) overflowed and was clipped at the
  // bottom when the trigger sat low. Measure the actual rendered height
  // (already capped by CSS max-height) and clamp `top` so `top..top+h` stays
  // within [margin, vh - margin]. If it still can't fit, pin to the top margin
  // and let the popover's own overflow-y:auto scroll the rest.
  const popH = popRef.value?.offsetHeight ?? 0
  let top = r.top + r.height / 2 - popH / 2
  const maxTop = vh - margin - popH
  if (maxTop >= margin) {
    top = Math.max(margin, Math.min(top, maxTop))
  } else {
    top = margin
  }

  popStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${POP_W}px`,
    maxWidth: `${POP_W}px`,
    // expose arrow side for the ::after via a data attr instead of CSS var
  }
  arrowSide.value = arrow
}

// Keep the wheel gesture out of the window-level Lenis listener (the live
// ParallaxSite preview registers a non-passive `wheel` on `window` and
// preventDefaults it, which otherwise swallows scrolling of this popover).
// Same pattern as usePanelScroll: stop propagation in the CAPTURE phase so the
// event never reaches Lenis, but DO NOT preventDefault so the popover's native
// overflow-y:auto scrolling still happens. (data-lenis-prevent on the element
// is a belt-and-suspenders for Lenis configs that honour it.)
function onPopWheel(e: WheelEvent) {
  e.stopPropagation()
}

watch(popRef, (el, prev) => {
  if (prev) prev.removeEventListener('wheel', onPopWheel, true)
  if (el) el.addEventListener('wheel', onPopWheel, { capture: true, passive: true })
})

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
        ref="popRef"
        class="help-pop"
        :class="`arrow-${arrowSide}`"
        role="tooltip"
        data-test="help-hint-pop"
        data-lenis-prevent
        :style="popStyle"
        @click.stop
        v-html="renderedHtml"
      />
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
.help-btn:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.help-btn:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 1px; }
</style>

<style>
/* Unscoped: the popover is teleported to <body>, outside this component's
   scoped style scope. High z-index so it sits above panels & overlays. */
.help-pop {
  background: #0d0d0d; color: #e6e6e6;
  border: 1px solid #555; border-radius: 6px; padding: 10px 12px;
  font-size: 11.5px; line-height: 1.5; font-weight: 400;
  /* z-index must beat every overlay that is ALSO teleported to <body>. The
     ProjectSelector modals use a backdrop at z-index 100001 (and an anchored
     bucket dropdown at 100002); since both the modal and this popover are
     <body> children, paint order is decided purely by z-index. A lower value
     left the tooltip painted BEHIND the modal backdrop → "el help no sirve".
     Sit above all of them. */
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.6); z-index: 100010;
  text-transform: none; letter-spacing: 0; white-space: normal; text-align: left;
  max-height: min(70vh, 460px); overflow-y: auto;
  overscroll-behavior: contain;
}
.help-pop::after {
  content: ''; position: absolute; top: 50%; transform: translateY(-50%);
  border: 5px solid transparent;
}
.help-pop.arrow-right::after { left: 100%; border-left-color: #555; }
.help-pop.arrow-left::after { right: 100%; border-right-color: #555; }

/* Formatted help content (item #1): readable paragraphs, bold, bullet lists,
   and a "cuándo usarlo" emphasis line. Static authored copy → safe. */
.help-pop p { margin: 0 0 7px; }
.help-pop p:last-child { margin-bottom: 0; }
.help-pop strong { color: #fff; font-weight: 700; }
.help-pop ul { margin: 0 0 7px; padding-left: 16px; }
.help-pop ul:last-child { margin-bottom: 0; }
.help-pop li { margin: 2px 0; }
.help-pop .hp-when {
  background: #14233a; border-left: 3px solid #2f80ed; border-radius: 4px;
  padding: 5px 8px; margin: 7px 0 0; color: #cfe2ff;
}
.help-pop .hp-when:last-child { margin-bottom: 0; }
.help-pop .hp-when-tag {
  display: inline-block; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: #7fb3ff; margin-right: 5px;
}
</style>
