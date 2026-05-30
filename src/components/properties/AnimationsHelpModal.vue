<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePanelScroll } from '../../composables/usePanelScroll'

// Detailed, plain-Spanish guide to ANIMATION TYPES, TRIGGERS and EASING.
// Opened from the "?" before the "+" in the Animaciones header (and from the
// "Ver guía de easing" link, which jumps to the Easing section). A teleported
// modal: nicely formatted (headings + grouped cards), scrollable, dismissible
// with the X button, a click on the backdrop, or Esc.
const props = defineProps<{ focusSection?: string | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

// The modal floats over the live engine preview, whose Lenis instance registers
// a non-passive wheel listener on window and preventDefaults it — so the body's
// overflow-y:auto never scrolls with the wheel. Same fix as the side panels:
// capture the wheel on the scroll body and stopPropagation (no preventDefault)
// so it never reaches Lenis but native element scrolling still happens.
const { panelScrollRef } = usePanelScroll()
const easingRef = ref<HTMLElement | null>(null)

// Animation TYPES grouped by family so the list is scannable. `name` strings
// stay untranslated (they are the technical engine identifiers). `groupKey`
// resolves to `animHelp.groups.<key>` and each item resolves to
// `animHelp.types.<name>.{desc,when}`.
const TYPE_GROUPS: { groupKey: string; items: string[] }[] = [
  { groupKey: 'aparicion', items: ['fadeIn', 'fadeOut'] },
  { groupKey: 'movimiento', items: ['translateX', 'translateY'] },
  { groupKey: 'giro', items: ['rotate', 'rotateX', 'rotateY'] },
  { groupKey: 'tamanio', items: ['scale', 'skew'] },
  { groupKey: 'efectos', items: ['blur', 'clipPath'] },
]

// TRIGGERS — what makes the animation play. Resolves to
// `animHelp.triggers.<name>.{desc,when}`.
const TRIGGERS: string[] = ['enter', 'scroll', 'loop', 'mouse', 'gyroscope', 'hover', 'click', 'depends']

// EASING — la "sensación" del movimiento (cómo arranca y frena), agrupado.
// Each item has a visible NAME (which differs from the locale key — the easing
// "name" is a display label like "easeOutCubic / Quart / Quint" — and a key
// pointing to the locale's desc/when copy).
const EASING_GROUPS: { groupKey: string; items: { name: string; key: string }[] }[] = [
  {
    groupKey: 'basicas',
    items: [
      { name: 'linear', key: 'linear' },
      { name: 'easeIn', key: 'easeIn' },
      { name: 'easeOut', key: 'easeOut' },
      { name: 'easeInOut', key: 'easeInOut' },
    ],
  },
  {
    groupKey: 'marcadas',
    items: [
      { name: 'easeOutCubic / Quart / Quint', key: 'easeOutCubic' },
      { name: 'easeInCubic / Quart / Quint', key: 'easeInCubic' },
      { name: 'easeInOutCubic / Quart / Quint', key: 'easeInOutCubic' },
    ],
  },
]

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}
onMounted(() => {
  document.addEventListener('keydown', onKey, true)
  // Opened from "Ver guía de easing" → jump straight to the Easing section.
  if (props.focusSection === 'easing') {
    nextTick(() => easingRef.value?.scrollIntoView({ block: 'start' }))
  }
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-help-backdrop"
      data-test="anim-help-modal"
      @click.self="emit('close')"
    >
      <div class="anim-help-modal" role="dialog" :aria-label="t('animHelp.title')">
        <header class="ahm-head">
          <h2 class="ahm-title">{{ t('animHelp.title') }}</h2>
          <button
            class="ahm-close"
            data-test="anim-help-close"
            :aria-label="t('animHelp.closeAria')"
            @click="emit('close')"
          >&times;</button>
        </header>

        <div class="ahm-body" data-test="anim-help-body" :ref="panelScrollRef">
          <p class="ahm-intro" v-html="t('animHelp.intro')"></p>

          <p class="ahm-note" data-test="ahm-edit-vs-preview" v-html="t('animHelp.editVsPreview')"></p>

          <p class="ahm-note" data-test="ahm-anchor" v-html="t('animHelp.anchor')"></p>

          <h3 class="ahm-section">{{ t('animHelp.sectionTypes') }}</h3>
          <p class="ahm-section-sub">{{ t('animHelp.sectionTypesSub') }}</p>
          <div
            v-for="g in TYPE_GROUPS"
            :key="g.groupKey"
            class="ahm-group"
          >
            <div class="ahm-group-name">{{ t(`animHelp.groups.${g.groupKey}`) }}</div>
            <div
              v-for="name in g.items"
              :key="name"
              class="ahm-card"
            >
              <code class="ahm-name">{{ name }}</code>
              <p class="ahm-desc">{{ t(`animHelp.types.${name}.desc`) }}</p>
              <p class="ahm-when"><span class="ahm-when-tag">{{ t('animHelp.whenTag') }}</span>{{ t(`animHelp.types.${name}.when`) }}</p>
            </div>
          </div>

          <h3 class="ahm-section">{{ t('animHelp.sectionTriggers') }}</h3>
          <p class="ahm-section-sub">{{ t('animHelp.sectionTriggersSub') }}</p>
          <div
            v-for="name in TRIGGERS"
            :key="name"
            class="ahm-card"
          >
            <code class="ahm-name">{{ name }}</code>
            <p class="ahm-desc">{{ t(`animHelp.triggers.${name}.desc`) }}</p>
            <p class="ahm-when"><span class="ahm-when-tag">{{ t('animHelp.whenTag') }}</span>{{ t(`animHelp.triggers.${name}.when`) }}</p>
          </div>

          <h3 ref="easingRef" class="ahm-section" data-test="ahm-easing">{{ t('animHelp.sectionEasing') }}</h3>
          <p class="ahm-section-sub" v-html="t('animHelp.sectionEasingSub')"></p>
          <div
            v-for="g in EASING_GROUPS"
            :key="g.groupKey"
            class="ahm-group"
          >
            <div class="ahm-group-name">{{ t(`animHelp.groups.${g.groupKey}`) }}</div>
            <div
              v-for="it in g.items"
              :key="it.key"
              class="ahm-card"
            >
              <code class="ahm-name">{{ it.name }}</code>
              <p class="ahm-desc">{{ t(`animHelp.easing.${it.key}.desc`) }}</p>
              <p class="ahm-when"><span class="ahm-when-tag">{{ t('animHelp.whenTag') }}</span>{{ t(`animHelp.easing.${it.key}.when`) }}</p>
            </div>
          </div>
          <p class="ahm-intro" style="margin-top:14px" v-html="t('animHelp.finalTip')"></p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.anim-help-backdrop {
  position: fixed; inset: 0; z-index: 100001;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.anim-help-modal {
  width: min(560px, 92vw); max-height: 86vh;
  display: flex; flex-direction: column;
  background: #1b1b1b; border: 1px solid #3a3a3a; border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65);
  color: #e6e6e6; overflow: hidden;
}
.ahm-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid #333;
}
.ahm-title { margin: 0; font-size: 16px; font-weight: 700; color: #fff; }
.ahm-close {
  background: none; border: none; color: #999; font-size: 24px; line-height: 1;
  cursor: pointer; padding: 0 4px; border-radius: 4px;
}
.ahm-close:hover { color: #fff; background: #ffffff14; }

.ahm-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: 16px 18px 20px; font-size: 12.5px; line-height: 1.5;
  overscroll-behavior: contain;
}
.ahm-intro { margin: 0 0 14px; color: #cfcfcf; }
.ahm-intro strong { color: #fff; }
/* Callout Edición-vs-Preview: por qué un movimiento no se ve en la mesa. */
.ahm-note {
  margin: 0 0 14px; padding: 9px 11px;
  background: #1b2a3a; border: 1px solid #2d5a8c; border-left: 3px solid #4a90d9;
  border-radius: 6px; color: #cfe0f2; font-size: 12.5px; line-height: 1.5;
}
.ahm-note strong { color: #fff; }
.ahm-note code { color: #ffd9a0; }

.ahm-section {
  margin: 18px 0 2px; font-size: 14px; font-weight: 700; color: var(--accent-strong);
  padding-top: 12px; border-top: 1px solid #2e2e2e;
}
.ahm-section:first-of-type { border-top: none; padding-top: 0; margin-top: 4px; }
.ahm-section-sub { margin: 0 0 10px; font-size: 11px; color: #888; }

.ahm-group { margin-bottom: 12px; }
.ahm-group-name {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: #9a9a9a; margin: 8px 0 5px;
}
.ahm-card {
  background: #232323; border: 1px solid #333; border-radius: 7px;
  padding: 8px 10px; margin: 6px 0;
}
.ahm-name {
  display: inline-block; background: #14233a; color: #8fc4ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
}
.ahm-desc { margin: 6px 0 0; color: #d6d6d6; }
.ahm-when {
  margin: 6px 0 0; color: #cfe2ff; font-size: 11.5px;
}
.ahm-when-tag {
  display: inline-block; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em; color: #7fb3ff;
  margin-right: 6px;
}
</style>
