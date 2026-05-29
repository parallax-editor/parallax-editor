// ─── i18n setup (vue-i18n 9, composition API) ──────────────────────────────
//
// MIGRATION STATUS: infrastructure-only. The editor UI is still authored in
// Spanish; this file wires vue-i18n so contributors can migrate strings
// incrementally with $t() / useI18n() without having to set up the
// framework first. Existing hardcoded Spanish strings keep working
// untouched — the E2E suite depends on their literal text.
//
// To migrate a component:
//   1. Add the keys to src/locales/es.ts and src/locales/en.ts.
//   2. In the SFC: `import { useI18n } from 'vue-i18n'` + `const { t } = useI18n()`.
//   3. Replace the literal with `{{ t('your.key') }}` (template) or `t('your.key')` (script).
//
// New components SHOULD use $t() from day one.
//
// The default locale persists in localStorage under
// `parallax-editor:locale`. On first load we detect from navigator.language
// and fall back to 'es' to preserve the current UX.

import { createI18n } from 'vue-i18n'
import { setEngineLocale } from '@parallax-editor/parallax-engine'
import es from '../locales/es'
import en from '../locales/en'

export type Locale = 'es' | 'en'

const STORAGE_KEY = 'parallax-editor:locale'

function detectInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'es' || stored === 'en') return stored
  } catch { /* localStorage unavailable */ }
  if (typeof navigator !== 'undefined' && navigator.language) {
    if (navigator.language.toLowerCase().startsWith('en')) return 'en'
  }
  return 'es'
}

export const i18n = createI18n<[typeof es], Locale>({
  legacy: false,
  locale: detectInitialLocale(),
  fallbackLocale: 'es',
  messages: { es, en },
  missingWarn: false,
  fallbackWarn: false,
})

/** Persist + apply a new locale. Also propagates to the engine so error
 *  overlay + console messages localize together (single user-visible language
 *  across the whole app). */
export function setLocale(locale: Locale): void {
  ;(i18n.global.locale as unknown as { value: Locale }).value = locale
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* noop */ }
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  try { setEngineLocale(locale) } catch { /* engine may be older — no-op */ }
}

// Sync the engine to whatever locale we resolved at boot, before any
// <ParallaxSite> mounts.
try { setEngineLocale(detectInitialLocale()) } catch { /* noop */ }

export function currentLocale(): Locale {
  return (i18n.global.locale as unknown as { value: Locale }).value
}
