<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { setLocale, type Locale } from '../../i18n'

const { t, locale } = useI18n()
const current = computed<Locale>({
  get: () => locale.value as Locale,
  set: (v) => setLocale(v),
})
</script>

<template>
  <label class="lang-switcher" :title="t('common.language')">
    <span class="lang-icon" aria-hidden="true">🌐</span>
    <select v-model="current" :aria-label="t('common.language')">
      <option value="es">{{ t('locale.es') }}</option>
      <option value="en">{{ t('locale.en') }}</option>
    </select>
  </label>
</template>

<style scoped>
.lang-switcher {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.04);
  font-size: 12px;
  color: var(--ink, #333);
}
.lang-switcher select {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
  padding-right: 4px;
}
.lang-switcher select:focus-visible {
  outline: 2px solid var(--accent, #888);
  outline-offset: 2px;
  border-radius: 3px;
}
.lang-icon { font-size: 12px; opacity: 0.7; }
</style>
