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
// Locale resolution at boot:
//   1. localStorage `parallax-editor:locale` (user's explicit choice; persists
//      across restarts). Honored only when 'es' or 'en'.
//   2. Otherwise OS/browser language (`navigator.language`): anything starting
//      with 'en' → English, everything else (including Spanish AND unsupported
//      locales like French/Portuguese) → Spanish, because the project's
//      content & docs are Spanish-first and an unsupported user is less lost
//      reading Spanish UI alongside Spanish content.
// This module is the SINGLE SOURCE OF TRUTH for the boot locale and pushes it
// to (a) vue-i18n, (b) the engine, (c) the Electron native menu — see the
// boot-sync block at the bottom of this file. Don't add a second resolver
// elsewhere (the bug "menu in one language, editor in the other across
// restarts" was exactly that: the Electron main process had its own default).

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
  // Tell the native menu (Electron) so the menu bar labels and the
  // "Window → Language" radio reflect the new choice. Web: no-op.
  try {
    const el = (globalThis as any).electronAPI
    if (el && typeof el.setLocale === 'function') el.setLocale(locale)
  } catch { /* no-op */ }
}

// One-time subscription: when the user picks a language from the native
// "Window → Language" submenu, the main process pushes the new locale here.
// Apply it via setLocale (which loops back to the bridge — the bridge call is
// idempotent and the next push is suppressed by the radio's own toggle).
if (typeof globalThis !== 'undefined') {
  try {
    const el = (globalThis as any).electronAPI
    if (el && typeof el.onLocaleChanged === 'function') {
      el.onLocaleChanged((next: Locale) => {
        if (next === 'es' || next === 'en') setLocale(next)
      })
    }
  } catch { /* no-op */ }
}

// Sync the engine + the native menu to whatever locale we resolved at boot,
// BEFORE any <ParallaxSite> mounts and before the user touches the menu.
//
// Pushing to Electron here is load-bearing: the main process holds its OWN
// `currentLocale` and builds the native menu when the app launches — long
// before this module ever runs. If we only called `setLocale()` on user
// changes (the original wiring), the menu stayed in whatever the main process
// picked while the Vue UI happily used whatever `detectInitialLocale()`
// resolved (e.g. 'en' from localStorage / navigator.language). That was the
// "menu in one language, editor in the other across restarts" bug. Pushing on
// boot forces a single source of truth: this module wins.
const bootLocale = detectInitialLocale()
try { setEngineLocale(bootLocale) } catch { /* noop */ }
try {
  const el = (globalThis as any).electronAPI
  if (el && typeof el.setLocale === 'function') el.setLocale(bootLocale)
} catch { /* no-op */ }

export function currentLocale(): Locale {
  return (i18n.global.locale as unknown as { value: Locale }).value
}
